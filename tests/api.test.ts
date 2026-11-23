import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackendCapabilities,
  ExecRequest,
  ExecResult,
  ExecStreamEvent,
  SandboxEvent,
  SandboxInfo,
} from '../src/core/types.js';
import { ApiError } from '../src/api/errors.js';
import type { CreateSandboxInput, ManagerPort } from '../src/api/server.js';
import { createServer } from '../src/api/server.js';

/**
 * Small in-process stand-in for the real manager. Exec simulates a
 * streaming run: two stdout chunks, then an exit event.
 */
class FakeManager implements ManagerPort {
  private sandboxes = new Map<string, SandboxInfo>();
  private files = new Map<string, Map<string, string>>();
  private events = new Map<string, SandboxEvent[]>();
  private listeners = new Map<string, Set<(e: SandboxEvent) => void>>();
  private seq = 0;
  private counter = 0;

  private pushEvent(id: string, type: string, detail?: string): void {
    const event: SandboxEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      type,
      detail,
    };
    this.events.get(id)?.push(event);
    for (const listener of this.listeners.get(id) ?? []) {
      listener(event);
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxInfo> {
    const id = `sb-${++this.counter}`;
    const now = new Date().toISOString();
    const info: SandboxInfo = {
      id,
      backend: input.backend ?? 'process',
      language: input.language,
      status: 'running',
      createdAt: now,
      lastUsedAt: now,
      limits: input.limits,
      network: input.network,
      labels: input.labels,
    };
    this.sandboxes.set(id, info);
    this.files.set(id, new Map());
    this.events.set(id, []);
    this.listeners.set(id, new Set());
    this.pushEvent(id, 'created', `backend=${info.backend}`);
    return info;
  }

  async get(id: string): Promise<SandboxInfo> {
    const info = this.sandboxes.get(id);
    if (!info) {
      throw new ApiError('not_found', `Sandbox ${id} not found`);
    }
    return info;
  }

  list(): SandboxInfo[] {
    return [...this.sandboxes.values()];
  }

  async destroy(id: string): Promise<void> {
    if (!this.sandboxes.has(id)) {
      throw new ApiError('not_found', `Sandbox ${id} not found`);
    }
    this.sandboxes.delete(id);
    this.files.delete(id);
    this.events.delete(id);
    this.listeners.delete(id);
  }

  async exec(
    id: string,
    req: ExecRequest,
    onEvent?: (e: ExecStreamEvent) => void,
  ): Promise<ExecResult> {
    const info = await this.get(id);
    info.lastUsedAt = new Date().toISOString();
    const source = req.code ?? req.file ?? '';
    const stdout = `ran ${req.language}: ${source}\nhello\nworld\n`;
    onEvent?.({ type: 'stdout', data: 'hello\n' });
    onEvent?.({ type: 'stdout', data: 'world\n' });
    const result: ExecResult = {
      exitCode: 0,
      stdout,
      stderr: '',
      timedOut: false,
      killed: false,
      durationMs: 7,
      truncated: false,
    };
    onEvent?.({ type: 'exit', exitCode: 0, timedOut: false });
    this.pushEvent(id, 'exec', `exit=0`);
    return result;
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    await this.get(id);
    this.files.get(id)?.set(path, content);
    this.pushEvent(id, 'file_written', path);
  }

  readFakeFile(id: string, path: string): string | undefined {
    return this.files.get(id)?.get(path);
  }

  getEvents(id: string): SandboxEvent[] {
    return [...(this.events.get(id) ?? [])];
  }

  onEvent(id: string, listener: (e: SandboxEvent) => void): () => void {
    const set = this.listeners.get(id);
    if (!set) {
      return () => undefined;
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  async backends(): Promise<BackendCapabilities[]> {
    return [
      {
        name: 'process',
        available: true,
        isolatesFilesystem: false,
        isolatesNetwork: false,
        isolatesProcesses: false,
        enforcesCpu: true,
        enforcesMemory: true,
      },
      {
        name: 'bwrap',
        available: false,
        reason: 'bwrap binary not found',
        isolatesFilesystem: true,
        isolatesNetwork: true,
        isolatesProcesses: true,
        enforcesCpu: true,
        enforcesMemory: true,
      },
    ];
  }
}

const TOKEN = 'test-token-123';
const fake = new FakeManager();
const main = createServer(fake, { noAuth: true });
const authed = createServer(fake, { token: TOKEN });
const tiny = createServer(fake, { noAuth: true, maxBodyBytes: 64 });

let mainPort = 0;
let authPort = 0;
let tinyPort = 0;

function base(port: number): string {
  return `http://127.0.0.1:${port}`;
}

interface CallResult {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

async function call(
  port: number,
  method: string,
  path: string,
  options: {
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers['content-type'] ??= 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(`${base(port)}${path}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON bodies (SSE streams) leave json undefined.
  }
  return { status: res.status, text, json };
}

async function createSandbox(
  port: number,
  body: Record<string, unknown> = {},
): Promise<CallResult> {
  return call(port, 'POST', '/v1/sandboxes', { body });
}

beforeAll(async () => {
  mainPort = (await main.listen()).port;
  authPort = (await authed.listen()).port;
  tinyPort = (await tiny.listen()).port;
});

afterAll(async () => {
  await main.close();
  await authed.close();
  await tiny.close();
});

describe('health', () => {
  it('returns ok with backends, no auth required', async () => {
    const res = await call(authPort, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('ok');
    expect(res.json.backends).toHaveLength(2);
    expect(res.json.backends[0].name).toBe('process');
    expect(res.json.backends[0].available).toBe(true);
  });
});

describe('sandbox lifecycle', () => {
  it('create → exec (JSON) → files → logs → list/get → destroy → 404', async () => {
    const created = await createSandbox(mainPort, {
      language: 'python',
      limits: { timeoutMs: 5000 },
      labels: { purpose: 'test' },
    });
    expect(created.status).toBe(201);
    expect(created.json.language).toBe('python');
    expect(created.json.network).toBe('none');
    expect(created.json.backend).toBe('process');
    expect(created.json.status).toBe('running');
    const id = created.json.id as string;
    expect(typeof id).toBe('string');

    const exec = await call(mainPort, 'POST', `/v1/sandboxes/${id}/exec`, {
      body: { code: 'print("hi")', language: 'python' },
    });
    expect(exec.status).toBe(200);
    expect(exec.json.exitCode).toBe(0);
    expect(exec.json.stdout).toContain('hello');
    expect(exec.json.stdout).toContain('world');
    expect(exec.json.timedOut).toBe(false);
    expect(exec.json.sandbox).toEqual({ id, status: 'running' });

    const file = await call(mainPort, 'POST', `/v1/sandboxes/${id}/files`, {
      body: { path: 'scripts/hello.py', content: 'print("hi")\n' },
    });
    expect(file.status).toBe(200);
    expect(file.json).toEqual({ path: 'scripts/hello.py' });
    expect(fake.readFakeFile(id, 'scripts/hello.py')).toBe('print("hi")\n');

    const logs = await call(mainPort, 'GET', `/v1/sandboxes/${id}/logs`);
    expect(logs.status).toBe(200);
    expect(logs.json.events.length).toBeGreaterThanOrEqual(3);
    expect(logs.json.events[0].type).toBe('created');
    expect(logs.json.events.map((e: SandboxEvent) => e.type)).toContain('exec');
    expect(logs.json.events.map((e: SandboxEvent) => e.type)).toContain(
      'file_written',
    );

    const listed = await call(mainPort, 'GET', '/v1/sandboxes');
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.json)).toBe(true);
    expect(listed.json.map((s: SandboxInfo) => s.id)).toContain(id);

    const fetched = await call(mainPort, 'GET', `/v1/sandboxes/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json.id).toBe(id);

    const destroyed = await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
    expect(destroyed.status).toBe(200);
    expect(destroyed.json).toEqual({ status: 'destroyed', id });

    const gone = await call(mainPort, 'GET', `/v1/sandboxes/${id}`);
    expect(gone.status).toBe(404);
    expect(gone.json.error.code).toBe('not_found');

    const destroyAgain = await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
    expect(destroyAgain.status).toBe(404);
  });

  it('create applies defaults and honours idempotency keys', async () => {
    const first = await createSandbox(mainPort, { idempotencyKey: 'key-1' });
    expect(first.status).toBe(201);
    expect(first.json.language).toBe('python');
    expect(first.json.network).toBe('none');
    const second = await createSandbox(mainPort, {
      idempotencyKey: 'key-1',
      language: 'node',
    });
    expect(second.status).toBe(201);
    expect(second.json.id).toBe(first.json.id);
    expect(second.json.language).toBe('python');
    await call(mainPort, 'DELETE', `/v1/sandboxes/${first.json.id}`);
  });

  it('exec by file works', async () => {
    const created = await createSandbox(mainPort, { language: 'node' });
    const id = created.json.id as string;
    const exec = await call(mainPort, 'POST', `/v1/sandboxes/${id}/exec`, {
      body: { file: 'app.js', language: 'node' },
    });
    expect(exec.status).toBe(200);
    expect(exec.json.stdout).toContain('app.js');
    await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
  });
});

describe('exec SSE streaming', () => {
  it('streams stdout and exit events as SSE', async () => {
    const created = await createSandbox(mainPort, {});
    const id = created.json.id as string;
    const res = await fetch(`${base(mainPort)}/v1/sandboxes/${id}/exec`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ code: 'print(1)', language: 'python' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: stdout');
    expect(text).toContain('data: {"type":"stdout","data":"hello\\n"}');
    expect(text).toContain('event: exit');
    expect(text).toContain('"exitCode":0');
    await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
  });

  it('exec on a missing sandbox is a 404 even for SSE', async () => {
    const res = await fetch(`${base(mainPort)}/v1/sandboxes/nope/exec`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ code: 'x', language: 'python' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('logs follow SSE', () => {
  it('streams existing events, then live events until disconnect', async () => {
    const created = await createSandbox(mainPort, {});
    const id = created.json.id as string;
    const controller = new AbortController();
    const res = await fetch(
      `${base(mainPort)}/v1/sandboxes/${id}/logs?follow=1`,
      {
        signal: controller.signal,
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Trigger a live event shortly after subscribing.
    setTimeout(() => {
      void call(mainPort, 'POST', `/v1/sandboxes/${id}/exec`, {
        body: { code: 'print(1)', language: 'python' },
      });
    }, 100);
    const deadline = Date.now() + 5000;
    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('"type":"exec"')) {
          break;
        }
      }
    } catch {
      // Aborting the fetch rejects the pending read; expected on teardown.
    } finally {
      controller.abort();
    }
    expect(buf).toContain('event: log');
    expect(buf).toContain('"type":"created"');
    expect(buf).toContain('"type":"exec"');
    await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
  });

  it('logs for a missing sandbox is a 404', async () => {
    const res = await call(mainPort, 'GET', '/v1/sandboxes/nope/logs');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });
});

describe('auth', () => {
  it('token mode: missing token → 401, wrong token → 401, right token → 200', async () => {
    const missing = await call(authPort, 'GET', '/v1/sandboxes');
    expect(missing.status).toBe(401);
    expect(missing.json.error.code).toBe('unauthorized');

    const wrong = await call(authPort, 'GET', '/v1/sandboxes', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('unauthorized');

    const ok = await call(authPort, 'GET', '/v1/sandboxes', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it('health stays public in token mode', async () => {
    const res = await call(authPort, 'GET', '/health');
    expect(res.status).toBe(200);
  });
});

describe('validation', () => {
  it('bad language → 400', async () => {
    const res = await createSandbox(mainPort, { language: 'rust' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad_request');
  });

  it('unknown backend → 400', async () => {
    const res = await createSandbox(mainPort, { backend: 'gvisor' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad_request');
  });

  it('bad network → 400', async () => {
    const res = await createSandbox(mainPort, { network: 'wide-open' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad_request');
  });

  it('exec with both code and file → 400', async () => {
    const created = await createSandbox(mainPort, {});
    const id = created.json.id as string;
    const res = await call(mainPort, 'POST', `/v1/sandboxes/${id}/exec`, {
      body: { code: 'x', file: 'x.py', language: 'python' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad_request');
    await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
  });

  it('exec with neither code nor file → 400', async () => {
    const created = await createSandbox(mainPort, {});
    const id = created.json.id as string;
    const res = await call(mainPort, 'POST', `/v1/sandboxes/${id}/exec`, {
      body: { language: 'python' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad_request');
    await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
  });

  it('exec without language → 400', async () => {
    const created = await createSandbox(mainPort, {});
    const id = created.json.id as string;
    const res = await call(mainPort, 'POST', `/v1/sandboxes/${id}/exec`, {
      body: { code: 'x' },
    });
    expect(res.status).toBe(400);
    await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
  });

  it('exec on a missing sandbox → 404', async () => {
    const res = await call(mainPort, 'POST', '/v1/sandboxes/nope/exec', {
      body: { code: 'x', language: 'python' },
    });
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });

  it('file path traversal → 400', async () => {
    const created = await createSandbox(mainPort, {});
    const id = created.json.id as string;
    for (const badPath of [
      '../escape.txt',
      'a/../../escape.txt',
      '/etc/passwd',
      '..',
    ]) {
      const res = await call(mainPort, 'POST', `/v1/sandboxes/${id}/files`, {
        body: { path: badPath, content: 'x' },
      });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('bad_request');
    }
    await call(mainPort, 'DELETE', `/v1/sandboxes/${id}`);
  });

  it('malformed JSON body → 400', async () => {
    const res = await call(mainPort, 'POST', '/v1/sandboxes', {
      rawBody: '{not json',
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad_request');
  });

  it('unknown route → 404 JSON', async () => {
    const res = await call(mainPort, 'GET', '/v1/bogus');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
    const root = await call(mainPort, 'GET', '/');
    expect(root.status).toBe(404);
  });
});

describe('body size cap', () => {
  it('body over the cap → 413', async () => {
    const res = await call(tinyPort, 'POST', '/v1/sandboxes', {
      body: { language: 'python', labels: { pad: 'x'.repeat(200) } },
    });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('payload_too_large');
  });
});
