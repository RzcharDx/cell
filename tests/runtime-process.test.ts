import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Limits, NetworkMode, SandboxHandle } from '../src/core/types.js';
import { ProcessBackend } from '../src/runtime/backends/process.js';

const backend = new ProcessBackend();
const handles: SandboxHandle[] = [];

let counter = 0;

async function makeSandbox(
  limits: Limits = {},
  network: NetworkMode = 'none',
): Promise<SandboxHandle> {
  const workdir = await mkdtemp(path.join(tmpdir(), 'cell-process-'));
  const handle = await backend.create({
    id: `process-test-${counter++}`,
    language: 'python',
    limits: { timeoutMs: 10000, ...limits },
    network,
    workdir,
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) {
      await handle.destroy().catch(() => undefined);
    }
  }
});

describe('process backend', () => {
  it('is always available but does not isolate the filesystem', async () => {
    const caps = await backend.probe();
    expect(caps.name).toBe('process');
    expect(caps.available).toBe(true);
    expect(caps.isolatesFilesystem).toBe(false);
  });

  it('executes python code with correct stdout and exit code', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'python',
      code: 'print("hello cell")',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello cell\n');
    expect(res.timedOut).toBe(false);
    expect(res.killed).toBe(false);
  });

  it('executes node and shell code', async () => {
    const handle = await makeSandbox();
    const nodeRes = await handle.exec({
      language: 'node',
      code: "console.log('node works')",
    });
    expect(nodeRes.exitCode).toBe(0);
    expect(nodeRes.stdout).toBe('node works\n');
    const shellRes = await handle.exec({
      language: 'shell',
      code: 'echo shell-works',
    });
    expect(shellRes.exitCode).toBe(0);
    expect(shellRes.stdout).toBe('shell-works\n');
  });

  it('passes args and stdin to the program', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'python',
      code: 'import sys; print(sys.argv[1:]); print(sys.stdin.read())',
      args: ['a', 'b'],
      stdin: 'hello-stdin',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("['a', 'b']");
    expect(res.stdout).toContain('hello-stdin');
  });

  it('timeout kills a sleeping exec quickly', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'python',
      code: 'import time; time.sleep(30)',
      timeoutMs: 1000,
    });
    expect(res.timedOut).toBe(true);
    expect(res.killed).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.durationMs).toBeLessThan(10000);
  });

  it('truncates output at maxOutputBytes', async () => {
    const handle = await makeSandbox({ maxOutputBytes: 512 });
    const res = await handle.exec({
      language: 'python',
      code: "print('y' * 100000)",
    });
    expect(res.exitCode).toBe(0);
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(512);
  });

  it('memory rlimit kills an over-allocating process', async () => {
    const handle = await makeSandbox({ memoryMB: 64 });
    const res = await handle.exec({
      language: 'python',
      code: 'x = bytearray(200 * 1024 * 1024); print("allocated")',
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).not.toContain('allocated');
  });

  it('network=none blocks outbound connects when unshare is available', async () => {
    const caps = await backend.probe();
    const handle = await makeSandbox({}, 'none');
    const res = await handle.exec({
      language: 'python',
      code: [
        'import socket',
        'try:',
        '    socket.create_connection(("8.8.8.8", 53), timeout=3)',
        '    print("connected")',
        'except Exception as e:',
        '    print("blocked:", type(e).__name__)',
      ].join('\n'),
      network: 'none',
    });
    expect(res.exitCode).toBe(0);
    if (caps.isolatesNetwork) {
      expect(res.stdout).toContain('blocked');
    } else {
      // No isolation was claimed; the exec itself must still succeed.
      expect(res.stdout).toMatch(/connected|blocked/);
    }
  });

  it('writes a file then executes it, and round-trips readFile', async () => {
    const handle = await makeSandbox();
    await handle.writeFile('sub/hello.py', 'print("from-file")');
    expect(await handle.readFile('sub/hello.py')).toBe('print("from-file")');
    const res = await handle.exec({
      language: 'python',
      file: 'sub/hello.py',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('from-file\n');
  });

  it('rejects paths escaping the workdir', async () => {
    const handle = await makeSandbox();
    await expect(handle.writeFile('../escape.txt', 'x')).rejects.toThrow(
      /escapes/,
    );
  });

  it('kill() stops a sleeping exec', async () => {
    const handle = await makeSandbox();
    const pending = handle.exec({
      language: 'python',
      code: 'import time; time.sleep(30)',
      timeoutMs: 60000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.kill();
    const res = await pending;
    expect(res.killed).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.durationMs).toBeLessThan(10000);
  });

  it('passes only the allowed env, never host env', async () => {
    process.env.CELL_HOST_SECRET = 'do-not-leak';
    const handle = await makeSandbox();
    try {
      const res = await handle.exec({
        language: 'python',
        code: [
          'import os',
          "print(os.environ.get('CELL_TEST_VAR'))",
          "print(os.environ.get('CELL_HOST_SECRET'))",
        ].join('\n'),
        env: { CELL_TEST_VAR: 'hello-env' },
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim().split('\n')).toEqual(['hello-env', 'None']);
    } finally {
      delete process.env.CELL_HOST_SECRET;
    }
  });
});
