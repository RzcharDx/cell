import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExecStreamEvent,
  Limits,
  NetworkMode,
  SandboxHandle,
} from '../src/core/types.js';
import { BwrapBackend } from '../src/runtime/backends/bwrap.js';

const backend = new BwrapBackend();
const handles: SandboxHandle[] = [];

let counter = 0;

async function makeSandbox(
  limits: Limits = {},
  network: NetworkMode = 'none',
): Promise<SandboxHandle> {
  const workdir = await mkdtemp(path.join(tmpdir(), 'cell-bwrap-'));
  const handle = await backend.create({
    id: `bwrap-test-${counter++}`,
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

const CONNECT_CODE = [
  'import socket',
  'try:',
  '    socket.create_connection(("8.8.8.8", 53), timeout=3)',
  '    print("connected")',
  'except Exception as e:',
  '    print("blocked:", type(e).__name__)',
].join('\n');

describe('bwrap backend', () => {
  it('executes python code with correct stdout and exit code', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'python',
      code: 'print("hello cell")',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello cell\n');
    expect(res.stderr).toBe('');
    expect(res.timedOut).toBe(false);
    expect(res.killed).toBe(false);
    expect(res.truncated).toBe(false);
  });

  it('executes node code', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'node',
      code: "console.log('node works'); console.error('to stderr');",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('node works\n');
    expect(res.stderr).toBe('to stderr\n');
  });

  it('executes shell code', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'shell',
      code: 'echo shell-works',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('shell-works\n');
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

  it('reports nonzero exit codes', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'python',
      code: 'import sys; sys.exit(3)',
    });
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
  });

  it('guest cannot see /etc/shadow or /home', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'python',
      code: [
        'import os',
        "print(os.path.exists('/etc/shadow'))",
        "print(os.path.exists('/home'))",
        "print(os.path.exists('/root'))",
        "print(os.path.exists('/etc/passwd'))",
      ].join('\n'),
    });
    expect(res.exitCode).toBe(0);
    // No shadow, no /home, no /root. /etc/passwd exists only because it
    // is the minimal private copy bound for the guest, not the host's.
    expect(res.stdout.trim().split('\n')).toEqual([
      'False',
      'False',
      'False',
      'True',
    ]);
  });

  it('guest cannot read /etc/shadow', async () => {
    const handle = await makeSandbox();
    const res = await handle.exec({
      language: 'python',
      code: "open('/etc/shadow').read()",
    });
    expect(res.exitCode).not.toBe(0);
  });

  it('network=none blocks outbound connects', async () => {
    const handle = await makeSandbox({}, 'none');
    const res = await handle.exec({
      language: 'python',
      code: CONNECT_CODE,
      network: 'none',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('blocked');
  });

  it('network=allow lets outbound connects through', async () => {
    const handle = await makeSandbox({}, 'allow');
    const res = await handle.exec({
      language: 'python',
      code: CONNECT_CODE,
      network: 'allow',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('connected');
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
    const handle = await makeSandbox({ maxOutputBytes: 1024 });
    const res = await handle.exec({
      language: 'python',
      code: "print('x' * 100000)",
    });
    expect(res.exitCode).toBe(0);
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(1024);
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

  it('streams stdout/stderr chunks and an exit event', async () => {
    const handle = await makeSandbox();
    const events: ExecStreamEvent[] = [];
    const res = await handle.exec(
      {
        language: 'python',
        code: 'print("one"); print("two")',
      },
      (event) => {
        events.push(event);
      },
    );
    expect(res.exitCode).toBe(0);
    const streamed = events
      .filter((e) => e.type === 'stdout')
      .map((e) => e.data ?? '')
      .join('');
    expect(streamed).toContain('one');
    expect(streamed).toContain('two');
    const exit = events.find((e) => e.type === 'exit');
    expect(exit?.exitCode).toBe(0);
    expect(exit?.timedOut).toBe(false);
  });

  it('writes a file then executes it', async () => {
    const handle = await makeSandbox();
    await handle.writeFile('hello.py', 'print("from-file")');
    expect(await handle.readFile('hello.py')).toBe('print("from-file")');
    const res = await handle.exec({ language: 'python', file: 'hello.py' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('from-file\n');
  });

  it('rejects paths escaping the workdir', async () => {
    const handle = await makeSandbox();
    await expect(handle.writeFile('../escape.txt', 'x')).rejects.toThrow(
      /escapes/,
    );
    await expect(handle.readFile('../../etc/passwd')).rejects.toThrow(
      /escapes/,
    );
    await expect(
      handle.exec({ language: 'python', file: '../outside.py' }),
    ).rejects.toThrow(/escapes/);
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
    expect(res.timedOut).toBe(false);
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
