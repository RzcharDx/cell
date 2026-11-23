import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(projectRoot, 'dist', 'cli', 'index.js');
const managerSrc = join(projectRoot, 'src', 'core', 'manager.ts');
const managerDist = join(projectRoot, 'dist', 'core', 'manager.js');

const pythonAvailable =
  spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
// The tests use the default backend (bwrap here); the process backend is
// covered by tests/runtime-process.test.ts.
const runtimeAvailable =
  pythonAvailable &&
  existsSync(managerSrc) &&
  existsSync(managerDist) &&
  existsSync(cliPath);

function runCli(args: string[], stdin?: string) {
  return spawnSync('node', [cliPath, ...args], {
    encoding: 'utf8',
    input: stdin,
    timeout: 30000,
    cwd: projectRoot,
  });
}

describe('cell run (one-shot local exec)', () => {
  it.skipIf(!runtimeAvailable)(
    'runs a python file and prints stdout with exit code 0',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cell-run-'));
      const file = join(dir, 'hello.py');
      writeFileSync(file, "print('hello from cell')\n");
      const res = runCli(['run', file, '--lang', 'python']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('hello from cell');
    },
  );

  it.skipIf(!runtimeAvailable)(
    'times out a long sleep and exits nonzero',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cell-run-'));
      const file = join(dir, 'sleep.py');
      writeFileSync(file, 'import time\ntime.sleep(30)\n');
      const res = runCli([
        'run',
        file,
        '--lang',
        'python',
        '--timeout',
        '500',
        '--json',
      ]);
      expect(res.status).not.toBe(0);
      const parsed = JSON.parse(res.stdout) as {
        timedOut?: boolean;
        exitCode?: number | null;
      };
      expect(parsed.timedOut === true || parsed.exitCode !== 0).toBe(true);
    },
  );

  it('reports clearly when the local runtime is unavailable', () => {
    if (runtimeAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), 'cell-run-'));
    const file = join(dir, 'hello.py');
    writeFileSync(file, "print('hello')\n");
    const res = runCli(['run', file, '--lang', 'python']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/error: /);
    expect(res.stderr).toMatch(/local execution is unavailable/);
  });
});
