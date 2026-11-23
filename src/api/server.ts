import { posix } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { Socket } from 'node:net';
import type {
  BackendCapabilities,
  BackendName,
  ExecRequest,
  ExecResult,
  ExecStreamEvent,
  Language,
  Limits,
  NetworkMode,
  SandboxEvent,
  SandboxInfo,
} from '../core/types.js';
import { requireAuth } from './auth.js';
import {
  ApiError,
  badRequest,
  jsonError,
  notFound,
  toApiError,
} from './errors.js';

/**
 * The slice of the sandbox manager the HTTP layer needs. Method names
 * match the real manager; the real wiring (manager + runtime) happens at
 * integration time, where an adapter maps CreateSandboxInput onto the
 * manager's own create options (id/workdir generation).
 */
export interface CreateSandboxInput {
  backend?: BackendName;
  language: Language;
  image?: string;
  limits: Limits;
  network: NetworkMode;
  env?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface ManagerPort {
  create(input: CreateSandboxInput): Promise<SandboxInfo>;
  get(id: string): Promise<SandboxInfo>;
  list(): SandboxInfo[];
  destroy(id: string): Promise<void>;
  exec(
    id: string,
    req: ExecRequest,
    onEvent?: (e: ExecStreamEvent) => void,
  ): Promise<ExecResult>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  getEvents(id: string): SandboxEvent[];
  onEvent(id: string, listener: (e: SandboxEvent) => void): () => void;
  backends(): Promise<BackendCapabilities[]>;
}

export interface ApiServerOptions {
  port?: number;
  host?: string;
  /** Bearer token clients must present; falls back to CELL_API_TOKEN. */
  token?: string;
  /** When true, no Authorization header is required. */
  noAuth?: boolean;
  /** Max request body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
}

export interface ApiServer {
  server: Server;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const BACKENDS: BackendName[] = ['bwrap', 'process', 'docker'];
const LANGUAGES: Language[] = ['python', 'node', 'shell'];
const NETWORKS: NetworkMode[] = ['none', 'allow'];
const LIMIT_FIELDS: (keyof Limits)[] = [
  'cpuSeconds',
  'memoryMB',
  'timeoutMs',
  'maxOutputBytes',
  'maxFileSizeMB',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

/** Read the whole request body, enforcing the size cap. */
async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ApiError(
        'payload_too_large',
        `Request body exceeds ${maxBytes} bytes`,
      );
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      req.destroy();
      throw new ApiError(
        'payload_too_large',
        `Request body exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body; an empty body yields undefined. */
async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const raw = await readBody(req, maxBytes);
  if (raw.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw badRequest('Malformed JSON body');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw badRequest(`${field} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw badRequest(`${field}.${key} must be a string`);
    }
  }
  return value as Record<string, string>;
}

function validateLanguage(value: unknown, required: boolean): Language {
  if (value === undefined) {
    if (required) {
      throw badRequest('language is required');
    }
    return 'python';
  }
  if (typeof value === 'string' && (LANGUAGES as string[]).includes(value)) {
    return value as Language;
  }
  throw badRequest(`language must be one of: ${LANGUAGES.join(', ')}`);
}

function validateNetwork(value: unknown): NetworkMode {
  if (value === undefined) {
    return 'none';
  }
  if (typeof value === 'string' && (NETWORKS as string[]).includes(value)) {
    return value as NetworkMode;
  }
  throw badRequest(`network must be one of: ${NETWORKS.join(', ')}`);
}

function validateBackend(value: unknown): BackendName {
  if (typeof value === 'string' && (BACKENDS as string[]).includes(value)) {
    return value as BackendName;
  }
  throw badRequest(`Unknown backend: ${String(value)}`);
}

function validateLimits(value: unknown): Limits {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw badRequest('limits must be an object');
  }
  const limits: Limits = {};
  for (const field of LIMIT_FIELDS) {
    const entry = value[field];
    if (entry === undefined) {
      continue;
    }
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
      throw badRequest(`limits.${field} must be a non-negative number`);
    }
    limits[field] = entry;
  }
  return limits;
}

function validateExecRequest(body: unknown): ExecRequest {
  if (!isRecord(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const language = validateLanguage(body.language, true);
  if (body.code !== undefined && typeof body.code !== 'string') {
    throw badRequest('code must be a string');
  }
  if (body.file !== undefined && typeof body.file !== 'string') {
    throw badRequest('file must be a string');
  }
  const hasCode = typeof body.code === 'string' && body.code.length > 0;
  const hasFile = typeof body.file === 'string' && body.file.length > 0;
  if (hasCode === hasFile) {
    throw badRequest('Exactly one of code or file must be set');
  }
  const network =
    body.network === undefined ? undefined : validateNetwork(body.network);
  let timeoutMs: number | undefined;
  if (body.timeoutMs !== undefined) {
    if (
      typeof body.timeoutMs !== 'number' ||
      !Number.isFinite(body.timeoutMs) ||
      body.timeoutMs <= 0
    ) {
      throw badRequest('timeoutMs must be a positive number');
    }
    timeoutMs = body.timeoutMs;
  }
  let args: string[] | undefined;
  if (body.args !== undefined) {
    if (
      !Array.isArray(body.args) ||
      body.args.some((a) => typeof a !== 'string')
    ) {
      throw badRequest('args must be an array of strings');
    }
    args = body.args as string[];
  }
  const stdin =
    body.stdin === undefined ? undefined : requireString(body.stdin, 'stdin');
  return {
    code: hasCode ? (body.code as string) : undefined,
    file: hasFile ? (body.file as string) : undefined,
    language,
    stdin,
    args,
    env: optionalStringRecord(body.env, 'env'),
    timeoutMs,
    network,
  };
}

/**
 * Validate a guest-relative file path and return its normalized form.
 * Rejects absolute paths and anything that escapes the workdir (`..`).
 */
export function normalizeWorkdirPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw badRequest('path must be a non-empty string');
  }
  if (raw.includes('\0')) {
    throw badRequest('path must not contain NUL bytes');
  }
  if (posix.isAbsolute(raw)) {
    throw badRequest('path must be relative to the sandbox workdir');
  }
  const normalized = posix.normalize(raw);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    posix.isAbsolute(normalized)
  ) {
    throw badRequest('path must not escape the sandbox workdir');
  }
  return normalized;
}

export function createServer(
  manager: ManagerPort,
  opts: ApiServerOptions = {},
): ApiServer {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  // Idempotency keys remember the sandbox they created, so a retried
  // create returns the original sandbox instead of a duplicate.
  const idempotency = new Map<string, SandboxInfo>();
  const sockets = new Set<Socket>();

  async function handleCreate(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req, maxBodyBytes);
    if (!isRecord(body)) {
      throw badRequest('Request body must be a JSON object');
    }
    const language = validateLanguage(body.language, false);
    const network = validateNetwork(body.network);
    const backend =
      body.backend === undefined ? undefined : validateBackend(body.backend);
    const limits = validateLimits(body.limits);
    const env = optionalStringRecord(body.env, 'env');
    const labels = optionalStringRecord(body.labels, 'labels');
    const image =
      body.image === undefined ? undefined : requireString(body.image, 'image');
    const idempotencyKey =
      body.idempotencyKey === undefined
        ? undefined
        : requireString(body.idempotencyKey, 'idempotencyKey');
    if (idempotencyKey !== undefined) {
      const existing = idempotency.get(idempotencyKey);
      if (existing) {
        sendJson(res, 201, existing);
        return;
      }
    }
    const info = await manager.create({
      backend,
      language,
      image,
      limits,
      network,
      env,
      labels,
    });
    if (idempotencyKey !== undefined) {
      idempotency.set(idempotencyKey, info);
    }
    sendJson(res, 201, info);
  }

  async function handleExec(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    // Resolve the sandbox first so a missing id is a clean 404 before
    // any streaming headers go out.
    await manager.get(id);
    const body = await readJsonBody(req, maxBodyBytes);
    const execReq = validateExecRequest(body);
    const wantsSse = (req.headers.accept ?? '').includes('text/event-stream');
    if (!wantsSse) {
      const result = await manager.exec(id, execReq);
      let status = 'running';
      try {
        status = (await manager.get(id)).status;
      } catch {
        // The sandbox vanished mid-exec; report the last known status.
      }
      sendJson(res, 200, { ...result, sandbox: { id, status } });
      return;
    }
    startSse(res);
    let exitSent = false;
    const onEvent = (event: ExecStreamEvent): void => {
      if (event.type === 'exit') {
        exitSent = true;
      }
      sendSse(res, event.type, event);
    };
    try {
      const result = await manager.exec(id, execReq, onEvent);
      if (!exitSent) {
        // The backend finished without emitting an exit event; synthesize
        // one from the result so the stream always ends with an exit.
        sendSse(res, 'exit', {
          type: 'exit',
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        } satisfies ExecStreamEvent);
      }
    } catch (err) {
      sendSse(res, 'error', {
        type: 'error',
        message: toApiError(err).message,
      } satisfies ExecStreamEvent);
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  async function handleWriteFile(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    await manager.get(id);
    const body = await readJsonBody(req, maxBodyBytes);
    if (!isRecord(body)) {
      throw badRequest('Request body must be a JSON object');
    }
    const path = normalizeWorkdirPath(body.path);
    const content = requireString(body.content, 'content');
    await manager.writeFile(id, path, content);
    sendJson(res, 200, { path });
  }

  async function handleLogs(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    url: URL,
  ): Promise<void> {
    await manager.get(id);
    if (url.searchParams.get('follow') !== '1') {
      sendJson(res, 200, { events: manager.getEvents(id) });
      return;
    }
    startSse(res);
    for (const event of manager.getEvents(id)) {
      sendSse(res, 'log', event);
    }
    let unsubscribed = false;
    const unsubscribe = manager.onEvent(id, (event) => {
      sendSse(res, 'log', event);
    });
    const stop = (): void => {
      if (!unsubscribed) {
        unsubscribed = true;
        unsubscribe();
      }
    };
    res.on('close', stop);
    req.on('close', stop);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://cell.local');
      let path = url.pathname;
      if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }
      const method = req.method ?? 'GET';

      // /health is public so load balancers can probe it without a token.
      if (path === '/health') {
        if (method !== 'GET') {
          throw notFound(`Unknown route: ${method} ${path}`);
        }
        const backends = await manager.backends();
        sendJson(res, 200, { status: 'ok', backends });
        return;
      }

      if (!path.startsWith('/v1/')) {
        throw notFound(`Unknown route: ${method} ${path}`);
      }
      if (!requireAuth(req, res, opts)) {
        return;
      }

      const segments = path.split('/').filter(Boolean);
      if (segments[0] !== 'v1' || segments[1] !== 'sandboxes') {
        throw notFound(`Unknown route: ${method} ${path}`);
      }
      const id = segments[2];

      if (segments.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, manager.list());
          return;
        }
        if (method === 'POST') {
          await handleCreate(req, res);
          return;
        }
        throw notFound(`Unknown route: ${method} ${path}`);
      }

      if (id === undefined || id.length === 0) {
        throw notFound(`Unknown route: ${method} ${path}`);
      }

      if (segments.length === 3) {
        if (method === 'GET') {
          sendJson(res, 200, await manager.get(id));
          return;
        }
        if (method === 'DELETE') {
          await manager.destroy(id);
          // Evict idempotency entries for the destroyed sandbox, so a
          // retried create after destroy makes a fresh sandbox instead
          // of returning the stale one.
          for (const [key, info] of idempotency) {
            if (info.id === id) {
              idempotency.delete(key);
            }
          }
          sendJson(res, 200, { status: 'destroyed', id });
          return;
        }
        throw notFound(`Unknown route: ${method} ${path}`);
      }

      if (segments.length === 4) {
        if (segments[3] === 'exec' && method === 'POST') {
          await handleExec(req, res, id);
          return;
        }
        if (segments[3] === 'files' && method === 'POST') {
          await handleWriteFile(req, res, id);
          return;
        }
        if (segments[3] === 'logs' && method === 'GET') {
          await handleLogs(req, res, id, url);
          return;
        }
      }

      throw notFound(`Unknown route: ${method} ${path}`);
    } catch (err) {
      if (!res.headersSent) {
        jsonError(res, err);
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // Client already gone.
        }
      }
    }
  }

  const server = createHttpServer((req, res) => {
    void handle(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  return {
    server,
    listen(): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => {
          reject(err);
        };
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          const address = server.address();
          resolve({
            port:
              typeof address === 'object' && address !== null
                ? address.port
                : port,
          });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
