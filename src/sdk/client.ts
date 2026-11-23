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

/**
 * Error thrown when the Cell API answers with a non-2xx status.
 * `code` comes from the server's `{ error: { code, message } }` body
 * when the server provides one.
 */
export class CellApiError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'CellApiError';
    this.status = status;
    this.code = code;
  }
}

export interface CellClientOptions {
  /** Base URL of the Cell API, e.g. `http://127.0.0.1:8917`. */
  baseUrl: string;
  /** Bearer token sent as `Authorization: Bearer <token>`, when set. */
  token?: string;
  /** Fetch implementation to use. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface CreateSandboxRequest {
  language?: Language;
  backend?: BackendName;
  network?: NetworkMode;
  limits?: Limits;
  /** Shorthand for `limits.timeoutMs`. */
  timeoutMs?: number;
  /** Shorthand for `limits.memoryMB`. */
  memoryMB?: number;
  env?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface HealthStatus {
  status: string;
  backends: BackendCapabilities[];
}

/**
 * HTTP client for the Cell API.
 *
 * Routes (all under `/v1`, except health, which is a bare `/health`):
 * - `GET    /health`
 * - `POST   /v1/sandboxes`            create
 * - `GET    /v1/sandboxes`            list
 * - `GET    /v1/sandboxes/:id`        get
 * - `DELETE /v1/sandboxes/:id`        destroy
 * - `POST   /v1/sandboxes/:id/exec`   exec (JSON, or SSE with
 *   `Accept: text/event-stream`)
 * - `POST   /v1/sandboxes/:id/files`  upload a file into the sandbox
 * - `GET    /v1/sandboxes/:id/logs`   events (JSON; `?follow=1` streams
 *   them as SSE)
 */
export class CellClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CellClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async health(): Promise<HealthStatus> {
    // The server exposes health at a bare, public /health; fall back to
    // the versioned route for servers that only have that one.
    const res = await this.rawRequest('/health', 'GET');
    if (res.status === 404) {
      const fallback = await this.rawRequest('/v1/health', 'GET');
      await this.throwIfError(fallback);
      return this.parseHealth(await this.readBody(fallback));
    }
    await this.throwIfError(res);
    return this.parseHealth(await this.readBody(res));
  }

  async create(opts: CreateSandboxRequest = {}): Promise<SandboxInfo> {
    const limits: Limits = { ...opts.limits };
    if (opts.timeoutMs !== undefined) limits.timeoutMs = opts.timeoutMs;
    if (opts.memoryMB !== undefined) limits.memoryMB = opts.memoryMB;
    const body: Record<string, unknown> = {};
    if (opts.language !== undefined) body.language = opts.language;
    if (opts.backend !== undefined) body.backend = opts.backend;
    if (opts.network !== undefined) body.network = opts.network;
    if (Object.keys(limits).length > 0) body.limits = limits;
    if (opts.env !== undefined) body.env = opts.env;
    if (opts.labels !== undefined) body.labels = opts.labels;
    const data = await this.request('POST', '/v1/sandboxes', body);
    return unwrap<SandboxInfo>(data, 'sandbox');
  }

  async list(): Promise<SandboxInfo[]> {
    const data = await this.request('GET', '/v1/sandboxes');
    if (Array.isArray(data)) return data as SandboxInfo[];
    if (
      data &&
      typeof data === 'object' &&
      Array.isArray((data as Record<string, unknown>).sandboxes)
    ) {
      return (data as Record<string, unknown>).sandboxes as SandboxInfo[];
    }
    throw new CellApiError('unexpected response from list sandboxes');
  }

  async get(id: string): Promise<SandboxInfo> {
    const data = await this.request(
      'GET',
      `/v1/sandboxes/${encodeURIComponent(id)}`,
    );
    return unwrap<SandboxInfo>(data, 'sandbox');
  }

  async exec(id: string, req: ExecRequest): Promise<ExecResult> {
    const data = await this.request(
      'POST',
      `/v1/sandboxes/${encodeURIComponent(id)}/exec`,
      req,
    );
    return data as ExecResult;
  }

  /**
   * Exec with live streaming. `onEvent` is called for every SSE event
   * (`stdout`, `stderr`, `exit`, `error`). The returned ExecResult is
   * assembled from the streamed events. An `error` event throws a
   * CellApiError.
   */
  async execStream(
    id: string,
    req: ExecRequest,
    onEvent: (event: ExecStreamEvent) => void,
  ): Promise<ExecResult> {
    const startedAt = Date.now();
    const res = await this.rawRequest(
      `/v1/sandboxes/${encodeURIComponent(id)}/exec`,
      'POST',
      req,
      'text/event-stream',
    );
    await this.throwIfError(res);
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      // Server answered with a plain JSON result instead of a stream.
      const result = (await this.readBody(res)) as ExecResult;
      onEvent({
        type: 'exit',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });
      return result;
    }

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let timedOut = false;
    await this.readSse(res, (data) => {
      let event: ExecStreamEvent;
      try {
        event = JSON.parse(data) as ExecStreamEvent;
      } catch {
        event = { type: 'stdout', data };
      }
      onEvent(event);
      if (event.type === 'stdout' && event.data) stdout += event.data;
      if (event.type === 'stderr' && event.data) stderr += event.data;
      if (event.type === 'exit') {
        exitCode = event.exitCode ?? null;
        timedOut = event.timedOut ?? false;
      }
      if (event.type === 'error') {
        throw new CellApiError(
          event.message ?? 'exec failed',
          undefined,
          'exec_error',
        );
      }
    });
    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      killed: false,
      durationMs: Date.now() - startedAt,
      truncated: false,
    };
  }

  async uploadFile(id: string, path: string, content: string): Promise<void> {
    await this.request(
      'POST',
      `/v1/sandboxes/${encodeURIComponent(id)}/files`,
      { path, content },
    );
  }

  /**
   * Fetch sandbox events. With `follow`, the server streams events as
   * SSE; `onEvent` is invoked for each event as it arrives, and the
   * returned array collects every event received until the stream ends.
   * (The real Cell server keeps a follow stream open, so with `follow`
   * this resolves only when the server closes the stream — use
   * `onEvent` to see events live.)
   */
  async logs(
    id: string,
    follow = false,
    onEvent?: (event: SandboxEvent) => void,
  ): Promise<SandboxEvent[]> {
    const path = `/v1/sandboxes/${encodeURIComponent(id)}/logs`;
    if (!follow) {
      const data = await this.request('GET', path);
      if (Array.isArray(data)) return data as SandboxEvent[];
      if (
        data &&
        typeof data === 'object' &&
        Array.isArray((data as Record<string, unknown>).events)
      ) {
        return (data as Record<string, unknown>).events as SandboxEvent[];
      }
      throw new CellApiError('unexpected response from logs');
    }
    const res = await this.rawRequest(
      `${path}?follow=1`,
      'GET',
      undefined,
      'text/event-stream',
    );
    await this.throwIfError(res);
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      // Server answered with a plain JSON body instead of a stream.
      const data = await this.readBody(res);
      if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        if (Array.isArray(record.events)) {
          return record.events as SandboxEvent[];
        }
      }
      if (Array.isArray(data)) return data as SandboxEvent[];
      return [];
    }
    const events: SandboxEvent[] = [];
    // A follow stream ends when the server closes the connection; the
    // fetch may surface that as a socket error rather than a clean EOF,
    // so stream errors here end the follow instead of failing it.
    await this.readSse(
      res,
      (data) => {
        try {
          const event = JSON.parse(data) as SandboxEvent;
          events.push(event);
          onEvent?.(event);
        } catch {
          // Ignore unparseable SSE lines.
        }
      },
      true,
    );
    return events;
  }

  async destroy(id: string): Promise<void> {
    await this.request('DELETE', `/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  private parseHealth(data: unknown): HealthStatus {
    if (!data || typeof data !== 'object') {
      throw new CellApiError('unexpected response from health');
    }
    const record = data as Record<string, unknown>;
    const backends = Array.isArray(record.backends)
      ? (record.backends as BackendCapabilities[])
      : [];
    return {
      status: typeof record.status === 'string' ? record.status : 'unknown',
      backends,
    };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept?: string,
  ): Promise<unknown> {
    const res = await this.rawRequest(path, method, body, accept);
    await this.throwIfError(res);
    if (res.status === 204) return undefined;
    return this.readBody(res);
  }

  private async rawRequest(
    path: string,
    method: string,
    body?: unknown,
    accept?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accept) headers.Accept = accept;
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async throwIfError(res: Response): Promise<void> {
    if (res.status >= 200 && res.status < 300) return;
    let message = `request failed with status ${res.status}`;
    let code: string | undefined;
    try {
      const data = (await this.readBody(res)) as unknown;
      if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        const err = record.error as Record<string, unknown> | undefined;
        if (err && typeof err === 'object') {
          if (typeof err.message === 'string') message = err.message;
          if (typeof err.code === 'string') code = err.code;
        } else if (typeof record.message === 'string') {
          message = record.message;
        }
      }
    } catch {
      // Keep the generic message when the error body is unreadable.
    }
    throw new CellApiError(message, res.status, code);
  }

  private async readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /**
   * Read an SSE response body, invoking `onData` with the `data:` payload
   * of each complete event. Stops on a `[DONE]` sentinel. When
   * `swallowStreamErrors` is set, a dropped connection ends the stream
   * instead of throwing (used for follow-style streams, where the
   * server closing the connection is the normal end signal).
   */
  private async readSse(
    res: Response,
    onData: (data: string) => void,
    swallowStreamErrors = false,
  ): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (swallowStreamErrors) return;
          throw err;
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = parseSseBlock(block);
          if (data !== undefined) {
            if (data === '[DONE]') return;
            onData(data);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const data = parseSseBlock(buffer);
        if (data !== undefined && data !== '[DONE]') onData(data);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** Unwrap `{ sandbox: {...} }` style envelopes, or return the body as-is. */
function unwrap<T>(data: unknown, key: string): T {
  if (
    data &&
    typeof data === 'object' &&
    key in (data as Record<string, unknown>)
  ) {
    return (data as Record<string, unknown>)[key] as T;
  }
  return data as T;
}

/** Extract the `data:` payload from one SSE event block, if any. */
function parseSseBlock(block: string): string | undefined {
  const lines = block.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/^\r/, '');
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return undefined;
  return dataLines.join('\n');
}
