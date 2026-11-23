/**
 * SandboxManager tests, using a small in-process fake backend so they stay
 * fast, hermetic, and independent of src/runtime/ (which is built in
 * parallel by another agent).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CellError } from '../src/core/errors.js';
import { SandboxManager } from '../src/core/manager.js';
import type {
  BackendCapabilities,
  BackendName,
  CreateSandboxOptions,
  ExecRequest,
  ExecResult,
  ExecStreamEvent,
  RuntimeBackend,
  SandboxHandle,
} from '../src/core/types.js';

// -- fake backend -----------------------------------------------------------

interface PendingExec {
  resolve: (r: ExecResult) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

function result(
  partial: Partial<ExecResult> & { startedAt: number },
): ExecResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    killed: false,
    durationMs: Date.now() - partial.startedAt,
    truncated: false,
    ...partial,
  };
}

class FakeHandle implements SandboxHandle {
  readonly id: string;
  readonly backend: BackendName = 'process';
  readonly files = new Map<string, string>();
  readonly pending = new Set<PendingExec>();
  destroyed = false;
  killCount = 0;

  constructor(id: string) {
    this.id = id;
  }

  async exec(
    req: ExecRequest,
    onEvent?: (e: ExecStreamEvent) => void,
  ): Promise<ExecResult> {
    const startedAt = Date.now();
    const code = req.code ?? req.file ?? '';
    if (code.includes('sleep')) {
      // Long-running exec that only finishes when killed (or after 5s).
      return new Promise<ExecResult>((resolve) => {
        const timer = setTimeout(() => {
          const entry = [...this.pending].find((p) => p.resolve === resolve);
          if (entry !== undefined) this.pending.delete(entry);
          resolve(result({ startedAt, stdout: 'slept' }));
        }, 5000);
        this.pending.add({ resolve, timer, startedAt });
      });
    }
    onEvent?.({ type: 'stdout', data: `echo:${code}` });
    onEvent?.({ type: 'exit', exitCode: 0 });
    return result({ startedAt, stdout: `echo:${code}` });
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`no such file: ${path}`);
    return value;
  }

  async kill(): Promise<void> {
    this.killCount += 1;
    for (const entry of [...this.pending]) {
      clearTimeout(entry.timer);
      this.pending.delete(entry);
      entry.resolve(
        result({ startedAt: entry.startedAt, exitCode: null, killed: true }),
      );
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.kill();
  }
}

class FakeBackend implements RuntimeBackend {
  readonly name: BackendName = 'process';
  created = 0;
  handles: FakeHandle[] = [];

  async probe(): Promise<BackendCapabilities> {
    return {
      name: 'process',
      available: true,
      isolatesFilesystem: false,
      isolatesNetwork: false,
      isolatesProcesses: false,
      enforcesCpu: false,
      enforcesMemory: false,
    };
  }

  async create(opts: CreateSandboxOptions): Promise<SandboxHandle> {
    this.created += 1;
    const handle = new FakeHandle(opts.id);
    this.handles.push(handle);
    return handle;
  }
}

// -- helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 6000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await sleep(50);
  }
}

describe('SandboxManager', () => {
  let tmp: string;
  let backend: FakeBackend;
  let manager: SandboxManager;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cell-manager-test-'));
    backend = new FakeBackend();
    manager = new SandboxManager({ workdirRoot: tmp }, async () => backend);
  });

  afterEach(async () => {
    await manager.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  });

  it('create/get/list/destroy lifecycle with status transitions', async () => {
    const info = await manager.create({ language: 'python' });
    expect(info.id).toMatch(/^sb_/);
    expect(info.status).toBe('running');
    expect(info.backend).toBe('process');
    expect(info.language).toBe('python');
    expect(info.network).toBe('none');
    expect(existsSync(join(tmp, info.id))).toBe(true);

    expect(manager.get(info.id).id).toBe(info.id);
    expect(manager.list()).toHaveLength(1);

    const written = await manager.exec(info.id, {
      language: 'python',
      code: "print('hi')",
    });
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toBe("echo:print('hi')");

    await manager.writeFile(info.id, 'hello.txt', 'hello');
    expect(await manager.readFile(info.id, 'hello.txt')).toBe('hello');

    const stopped = await manager.stop(info.id);
    expect(stopped.status).toBe('stopped');
    // Stopping twice is a no-op.
    expect((await manager.stop(info.id)).status).toBe('stopped');

    // Exec on a stopped sandbox restarts it.
    const restarted = await manager.exec(info.id, {
      language: 'python',
      code: 'print(2)',
    });
    expect(restarted.stdout).toBe('echo:print(2)');
    expect(manager.get(info.id).status).toBe('running');

    await manager.destroy(info.id);
    expect(manager.list()).toHaveLength(0);
    expect(existsSync(join(tmp, info.id))).toBe(false);
    expect(() => manager.get(info.id)).toThrowError(CellError);
    try {
      manager.get(info.id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CellError);
      expect((err as CellError).code).toBe('sandbox_destroyed');
    }
  });

  it('exec requires exactly one of code or file', async () => {
    const info = await manager.create({ language: 'python' });
    await expect(
      manager.exec(info.id, { language: 'python' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      manager.exec(info.id, {
        language: 'python',
        code: 'x',
        file: 'x.py',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('idempotency: same key returns the same sandbox, no second create', async () => {
    const first = await manager.create({
      language: 'python',
      idempotencyKey: 'job-1',
    });
    const second = await manager.create({
      language: 'python',
      idempotencyKey: 'job-1',
    });
    expect(second.id).toBe(first.id);
    expect(backend.created).toBe(1);
    expect(manager.list()).toHaveLength(1);

    // Concurrent creates with the same key also collapse to one sandbox.
    const [a, b] = await Promise.all([
      manager.create({ language: 'python', idempotencyKey: 'job-2' }),
      manager.create({ language: 'python', idempotencyKey: 'job-2' }),
    ]);
    expect(a.id).toBe(b.id);
    expect(backend.created).toBe(2);

    // After destroy, the same key creates a fresh sandbox.
    await manager.destroy(first.id);
    const third = await manager.create({
      language: 'python',
      idempotencyKey: 'job-1',
    });
    expect(third.id).not.toBe(first.id);
    expect(backend.created).toBe(3);
  });

  it('enforces maxSandboxes', async () => {
    const small = new SandboxManager(
      { workdirRoot: tmp, maxSandboxes: 2 },
      async () => backend,
    );
    try {
      await small.create({ language: 'python' });
      await small.create({ language: 'python' });
      await expect(small.create({ language: 'python' })).rejects.toMatchObject({
        code: 'limit_exceeded',
      });
      // Freeing a slot lets creation succeed again.
      const [first] = small.list();
      if (first !== undefined) await small.destroy(first.id);
      await expect(small.create({ language: 'python' })).resolves.toBeDefined();
    } finally {
      await small.close();
    }
  });

  it('merges default limits with per-create overrides', async () => {
    const limited = new SandboxManager(
      {
        workdirRoot: tmp,
        defaultLimits: { timeoutMs: 1000, memoryMB: 256 },
      },
      async () => backend,
    );
    try {
      const info = await limited.create({
        language: 'python',
        limits: { memoryMB: 128 },
      });
      expect(info.limits).toEqual({ timeoutMs: 1000, memoryMB: 128 });
    } finally {
      await limited.close();
    }
  });

  it('warm pool: hands out pooled sandboxes and refills', async () => {
    const pooled = new SandboxManager(
      { workdirRoot: tmp, poolSize: 2 },
      async () => backend,
    );
    try {
      await pooled.waitForPool();
      expect(pooled.poolCount()).toBe(2);
      expect(backend.created).toBe(2);

      const one = await pooled.create({ language: 'python' });
      // No new backend sandbox was created for this checkout.
      expect(backend.created).toBe(2);
      expect(pooled.poolCount()).toBe(1);

      // The pool refills asynchronously.
      await pooled.waitForPool();
      expect(pooled.poolCount()).toBe(2);
      expect(backend.created).toBe(3);

      // The checked-out sandbox is a normal live sandbox.
      expect(pooled.get(one.id).status).toBe('running');
      const events = pooled.getEvents(one.id);
      expect(events.map((e) => e.type)).toContain('pool_checkout');

      // A request with custom limits does not consume the pool.
      await pooled.create({
        language: 'python',
        limits: { timeoutMs: 500 },
      });
      expect(backend.created).toBe(4);
      expect(pooled.poolCount()).toBe(2);
    } finally {
      await pooled.close();
    }
  });

  it('warm pool counts toward maxSandboxes', async () => {
    const pooled = new SandboxManager(
      { workdirRoot: tmp, poolSize: 2, maxSandboxes: 2 },
      async () => backend,
    );
    try {
      await pooled.waitForPool();
      expect(pooled.poolCount()).toBe(2);
      // Checkout is free (the sandbox already exists)...
      await pooled.create({ language: 'python' });
      // ...but a second fresh create would exceed the limit.
      await expect(
        pooled.create({ language: 'python', limits: { timeoutMs: 1 } }),
      ).rejects.toMatchObject({ code: 'limit_exceeded' });
    } finally {
      await pooled.close();
    }
  });

  it('event log: ordering, live subscription, and 500-entry cap', async () => {
    const info = await manager.create({ language: 'python' });
    const seen: string[] = [];
    const unsubscribe = manager.onEvent(info.id, (e) => {
      seen.push(e.type);
    });
    await manager.exec(info.id, { language: 'python', code: 'print(1)' });
    await manager.kill(info.id);
    unsubscribe();
    await manager.exec(info.id, { language: 'python', code: 'print(2)' });

    expect(seen).toEqual(['exec_started', 'exec_finished', 'killed']);
    const events = manager.getEvents(info.id);
    expect(events.map((e) => e.type)).toEqual([
      'created',
      'exec_started',
      'exec_finished',
      'killed',
      'exec_started',
      'exec_finished',
    ]);
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
    });

    // Cap: before this loop the log already holds 6 events (created, two
    // execs, one kill); 260 more execs add 520, for 526 total. Only the
    // newest 500 are kept, with sequence numbers still strictly increasing.
    for (let i = 0; i < 260; i += 1) {
      await manager.exec(info.id, { language: 'python', code: `x${i}` });
    }
    const capped = manager.getEvents(info.id);
    expect(capped).toHaveLength(500);
    expect(capped[0]?.seq).toBe(27);
    expect(capped[499]?.seq).toBe(526);
    capped.forEach((e, i) => {
      expect(e.seq).toBe(27 + i);
    });
  });

  it('event log survives destroy; subscribing to a destroyed sandbox throws', async () => {
    const info = await manager.create({ language: 'python' });
    await manager.exec(info.id, { language: 'python', code: 'print(1)' });
    await manager.destroy(info.id);
    const events = manager.getEvents(info.id);
    expect(events.map((e) => e.type)).toEqual([
      'created',
      'exec_started',
      'exec_finished',
      'destroyed',
    ]);
    expect(() => manager.onEvent(info.id, () => {})).toThrowError(CellError);
  });

  it('kill aborts a running exec but leaves the sandbox running', async () => {
    const info = await manager.create({ language: 'python' });
    const pending = manager.exec(info.id, {
      language: 'python',
      code: 'sleep 10',
    });
    await sleep(50);
    const killed = await manager.kill(info.id);
    expect(killed.status).toBe('running');
    const outcome = await pending;
    expect(outcome.killed).toBe(true);
    expect(outcome.exitCode).toBeNull();
    expect(manager.get(info.id).status).toBe('running');
    const handle = backend.handles.find((h) => h.id === info.id);
    expect(handle?.killCount).toBeGreaterThan(0);
  });

  it('idle reaper destroys an idle sandbox', async () => {
    const short = new SandboxManager(
      { workdirRoot: tmp, idleTimeoutSeconds: 1 },
      async () => backend,
    );
    try {
      const info = await short.create({ language: 'python' });
      await waitUntil(() => short.list().length === 0);
      expect(() => short.get(info.id)).toThrowError(CellError);
      const handle = backend.handles.find((h) => h.id === info.id);
      expect(handle?.destroyed).toBe(true);
    } finally {
      await short.close();
    }
  });

  it('idle reaper can be disabled and never reaps pooled sandboxes', async () => {
    const pooled = new SandboxManager(
      { workdirRoot: tmp, poolSize: 1, idleTimeoutSeconds: 1 },
      async () => backend,
    );
    try {
      await pooled.waitForPool();
      await sleep(2500);
      expect(pooled.poolCount()).toBe(1);
      expect(pooled.list()).toHaveLength(1);
    } finally {
      await pooled.close();
    }

    const disabled = new SandboxManager(
      { workdirRoot: tmp, idleTimeoutSeconds: 0 },
      async () => backend,
    );
    try {
      await disabled.create({ language: 'python' });
      await sleep(1200);
      expect(disabled.list()).toHaveLength(1);
      expect(await disabled.reapIdle()).toBe(0);
    } finally {
      await disabled.close();
    }
  });

  it('exec on a destroyed sandbox throws sandbox_destroyed', async () => {
    const info = await manager.create({ language: 'python' });
    await manager.destroy(info.id);
    await expect(
      manager.exec(info.id, { language: 'python', code: 'print(1)' }),
    ).rejects.toMatchObject({ code: 'sandbox_destroyed' });
    await expect(manager.destroy(info.id)).rejects.toMatchObject({
      code: 'sandbox_destroyed',
    });
    await expect(
      manager.exec('sb_does-not-exist', {
        language: 'python',
        code: 'print(1)',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(() => manager.get('sb_does-not-exist')).toThrowError(CellError);
  });

  it('exec updates lastUsedAt', async () => {
    const info = await manager.create({ language: 'python' });
    const before = info.lastUsedAt;
    await sleep(25);
    await manager.exec(info.id, { language: 'python', code: 'print(1)' });
    const after = manager.get(info.id).lastUsedAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('close destroys all sandboxes and blocks further creates', async () => {
    const one = await manager.create({ language: 'python' });
    const two = await manager.create({ language: 'python' });
    await manager.close();
    expect(manager.list()).toHaveLength(0);
    expect(backend.handles.find((h) => h.id === one.id)?.destroyed).toBe(true);
    expect(backend.handles.find((h) => h.id === two.id)?.destroyed).toBe(true);
    await expect(manager.create({ language: 'python' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    // Closing twice is safe.
    await manager.close();
  });
});
