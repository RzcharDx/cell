import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CellApiError, CellClient } from '../src/sdk/index.js';
import type { SandboxInfo } from '../src/core/types.js';

const SANDBOX: SandboxInfo = {
  id: 'sb-1',
  backend: 'process',
  language: 'python',
  status: 'running',
  createdAt: '2026-11-23T00:00:00.000Z',
  lastUsedAt: '2026-11-23T00:00:00.000Z',
  limits: {},
  network: 'none',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function fakeServer(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/v1/health' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        backends: [
          {
            name: 'process',
            available: true,
            isolatesFilesystem: false,
            isolatesNetwork: false,
            isolatesProcesses: false,
            enforcesCpu: true,
            enforcesMemory: true,
          },
        ],
      });
      return;
    }

    if (path === '/v1/sandboxes' && req.method === 'POST') {
      if (!req.headers.authorization) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: 'missing token' },
        });
        return;
      }
      await readBody(req);
      sendJson(res, 201, SANDBOX);
      return;
    }

    if (path === '/v1/sandboxes' && req.method === 'GET') {
      sendJson(res, 200, [SANDBOX]);
      return;
    }

    const execMatch = /^\/v1\/sandboxes\/([^/]+)\/exec$/.exec(path);
    if (execMatch && req.method === 'POST') {
      const id = execMatch[1] as string;
      if (id !== SANDBOX.id) {
        sendJson(res, 404, {
          error: { code: 'not_found', message: 'sandbox not found' },
        });
        return;
      }
      const accept = req.headers.accept ?? '';
      await readBody(req);
      if (accept.includes('text/event-stream')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        res.write(
          `data: ${JSON.stringify({ type: 'stdout', data: 'hel' })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: 'stdout', data: 'lo\n' })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: 'stderr', data: 'warn\n' })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: 'exit', exitCode: 0, timedOut: false })}\n\n`,
        );
        res.end();
        return;
      }
      sendJson(res, 200, {
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        timedOut: false,
        killed: false,
        durationMs: 3,
        truncated: false,
      });
      return;
    }

    const filesMatch = /^\/v1\/sandboxes\/([^/]+)\/files$/.exec(path);
    if (filesMatch && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as {
        path: string;
        content: string;
      };
      if (body.path !== 'main.py' || body.content !== 'print(1)') {
        sendJson(res, 400, {
          error: { code: 'bad_request', message: 'unexpected file body' },
        });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const logsMatch = /^\/v1\/sandboxes\/([^/]+)\/logs$/.exec(path);
    if (logsMatch && req.method === 'GET') {
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/event-stream')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        res.write(
          `data: ${JSON.stringify({ seq: 1, at: '2026-11-23T00:00:00.000Z', type: 'created' })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ seq: 2, at: '2026-11-23T00:00:01.000Z', type: 'exec', detail: 'exit 0' })}\n\n`,
        );
        res.end();
        return;
      }
      sendJson(res, 200, [
        { seq: 1, at: '2026-11-23T00:00:00.000Z', type: 'created' },
        {
          seq: 2,
          at: '2026-11-23T00:00:01.000Z',
          type: 'exec',
          detail: 'exit 0',
        },
      ]);
      return;
    }

    const sbMatch = /^\/v1\/sandboxes\/([^/]+)$/.exec(path);
    if (sbMatch) {
      const id = sbMatch[1] as string;
      if (req.method === 'GET') {
        if (id !== SANDBOX.id) {
          sendJson(res, 404, {
            error: { code: 'not_found', message: 'sandbox not found' },
          });
          return;
        }
        sendJson(res, 200, SANDBOX);
        return;
      }
      if (req.method === 'DELETE') {
        if (id !== SANDBOX.id) {
          sendJson(res, 404, {
            error: { code: 'not_found', message: 'sandbox not found' },
          });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
    }

    sendJson(res, 404, {
      error: { code: 'not_found', message: 'route not found' },
    });
  });
}

let server: Server;
let baseUrl: string;
let client: CellClient;

beforeAll(async () => {
  server = fakeServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake server did not bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = new CellClient({ baseUrl, token: 'test-token' });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('CellClient', () => {
  it('health returns status and backends', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.backends).toHaveLength(1);
    expect(health.backends[0]?.name).toBe('process');
    expect(health.backends[0]?.available).toBe(true);
  });

  it('create returns the sandbox', async () => {
    const sb = await client.create({
      language: 'python',
      backend: 'process',
      network: 'none',
    });
    expect(sb.id).toBe('sb-1');
    expect(sb.language).toBe('python');
  });

  it('list returns sandboxes', async () => {
    const list = await client.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('sb-1');
  });

  it('get returns one sandbox', async () => {
    const sb = await client.get('sb-1');
    expect(sb.id).toBe('sb-1');
    expect(sb.status).toBe('running');
  });

  it('exec returns the ExecResult', async () => {
    const result = await client.exec('sb-1', {
      code: 'print("hello")',
      language: 'python',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(result.timedOut).toBe(false);
  });

  it('execStream delivers SSE events and assembles the result', async () => {
    const seen: string[] = [];
    const result = await client.execStream(
      'sb-1',
      { code: 'print("hello")', language: 'python' },
      (event) => {
        seen.push(event.type);
      },
    );
    expect(seen).toEqual(['stdout', 'stdout', 'stderr', 'exit']);
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('warn\n');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('uploadFile posts path and content', async () => {
    await expect(
      client.uploadFile('sb-1', 'main.py', 'print(1)'),
    ).resolves.toBeUndefined();
  });

  it('logs returns events, and follow streams them', async () => {
    const events = await client.logs('sb-1');
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('created');
    const followed = await client.logs('sb-1', true);
    expect(followed).toHaveLength(2);
    expect(followed[1]?.detail).toBe('exit 0');
  });

  it('destroy resolves on 204', async () => {
    await expect(client.destroy('sb-1')).resolves.toBeUndefined();
  });

  it('maps 404 to CellApiError with code not_found', async () => {
    let caught: unknown;
    try {
      await client.get('missing');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CellApiError);
    const apiErr = caught as CellApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe('not_found');
    expect(apiErr.message).toBe('sandbox not found');
  });

  it('maps missing token to CellApiError with code unauthorized', async () => {
    const anon = new CellClient({ baseUrl });
    await expect(anon.create({ language: 'python' })).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    } as Partial<CellApiError>);
  });
});

/**
 * The same client, exercised against the real API server
 * (src/api/server.ts) with a stub manager, so route shapes, the bare
 * /health endpoint, the `?follow=1` logs stream, and the server's
 * `{error:{code,message}}` bodies are verified end to end.
 */
import {
  createServer as createApiServer,
  type ManagerPort,
} from '../src/api/server.js';

const STUB_EVENTS = [
  { seq: 1, at: '2026-11-23T00:00:00.000Z', type: 'created' },
  {
    seq: 2,
    at: '2026-11-23T00:00:01.000Z',
    type: 'exec',
    detail: 'exit 0',
  },
];

const stubManager: ManagerPort = {
  create: async () => SANDBOX,
  get: async (id) => {
    if (id !== SANDBOX.id) throw new Error('sandbox not found');
    return SANDBOX;
  },
  list: () => [SANDBOX],
  destroy: async () => {},
  exec: async (_id, _req, onEvent) => {
    const result = {
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      timedOut: false,
      killed: false,
      durationMs: 3,
      truncated: false,
    };
    if (onEvent) {
      onEvent({ type: 'stdout', data: 'hello\n' });
      onEvent({ type: 'exit', exitCode: 0, timedOut: false });
    }
    return result;
  },
  writeFile: async () => {},
  getEvents: () => STUB_EVENTS,
  onEvent: () => () => {},
  backends: async () => [
    {
      name: 'process',
      available: true,
      isolatesFilesystem: false,
      isolatesNetwork: false,
      isolatesProcesses: false,
      enforcesCpu: true,
      enforcesMemory: true,
    },
  ],
};

describe('CellClient against the real API server', () => {
  let api: ReturnType<typeof createApiServer>;
  let realClient: CellClient;

  beforeAll(async () => {
    api = createApiServer(stubManager, { noAuth: true });
    const { port } = await api.listen();
    realClient = new CellClient({
      baseUrl: `http://127.0.0.1:${port}`,
    });
  });

  afterAll(async () => {
    await api.close();
  });

  it('health hits the bare /health route', async () => {
    const health = await realClient.health();
    expect(health.status).toBe('ok');
    expect(health.backends[0]?.name).toBe('process');
  });

  it('create/list/get/exec/destroy round-trip', async () => {
    const created = await realClient.create({ language: 'python' });
    expect(created.id).toBe('sb-1');
    expect(await realClient.list()).toHaveLength(1);
    expect((await realClient.get('sb-1')).status).toBe('running');
    const result = await realClient.exec('sb-1', {
      code: 'print("hello")',
      language: 'python',
    });
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
    await expect(realClient.destroy('sb-1')).resolves.toBeUndefined();
  });

  it('execStream reads the real SSE stream', async () => {
    const seen: string[] = [];
    const result = await realClient.execStream(
      'sb-1',
      { code: 'print("hello")', language: 'python' },
      (event) => {
        seen.push(event.type);
      },
    );
    expect(seen).toContain('stdout');
    expect(seen).toContain('exit');
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
  });

  it('uploadFile and logs (JSON) work', async () => {
    await expect(
      realClient.uploadFile('sb-1', 'main.py', 'print(1)'),
    ).resolves.toBeUndefined();
    const events = await realClient.logs('sb-1');
    expect(events).toHaveLength(2);
    expect(events[1]?.detail).toBe('exit 0');
  });

  it('maps a missing sandbox to not_found', async () => {
    await expect(realClient.get('nope')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    } as Partial<CellApiError>);
  });

  it('maps a missing token to unauthorized on an authed server', async () => {
    const authed = createApiServer(stubManager, { token: 'secret' });
    const { port } = await authed.listen();
    try {
      const anon = new CellClient({ baseUrl: `http://127.0.0.1:${port}` });
      await expect(anon.create({ language: 'python' })).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      } as Partial<CellApiError>);
      const authedClient = new CellClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'secret',
      });
      await expect(
        authedClient.create({ language: 'python' }),
      ).resolves.toMatchObject({ id: 'sb-1' });
    } finally {
      await authed.close();
    }
  });

  it('logs follow streams live events until the server closes', async () => {
    // The follow stream stays open by design, so run it against its
    // own server instance and close that server to end the stream.
    const followApi = createApiServer(stubManager, { noAuth: true });
    const { port } = await followApi.listen();
    const followClient = new CellClient({
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const seen: string[] = [];
    const promise = followClient.logs('sb-1', true, (event) => {
      seen.push(event.type);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual(['created', 'exec']);
    await followApi.close();
    await expect(promise).resolves.toHaveLength(2);
  });
});
