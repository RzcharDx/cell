/**
 * Shared machinery for the Cell runtime backends.
 *
 * Every backend funnels execs through one generic sandbox handle
 * (`createSandboxHandle`) and one spawn helper (`spawnExec`), so the
 * security-relevant behaviour — output capping, timeout kills, whole
 * process-group kills, workdir jailing — is implemented once and is
 * identical for all backends. Backends differ only in how they build the
 * command line (bwrap wrapping, unshare wrapping, `docker run`).
 */
import { spawn } from 'node:child_process';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type {
  BackendName,
  ExecRequest,
  ExecResult,
  ExecStreamEvent,
  Language,
  Limits,
  NetworkMode,
  SandboxHandle,
} from '../../core/types.js';
import { BackendError } from '../errors.js';

/** Default cap on captured stdout+stderr per exec (1 MiB). */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** File inside the workdir that `code` execs are written to. */
export function mainFileName(language: Language): string {
  switch (language) {
    case 'python':
      return '_cell_main.py';
    case 'node':
      return '_cell_main.mjs';
    case 'shell':
      return '_cell_main.sh';
  }
}

/** Interpreter invocation for a file, plus any user args. */
export function interpreterCommand(
  language: Language,
  filePath: string,
  args: string[],
): string[] {
  switch (language) {
    case 'python':
      return ['python3', filePath, ...args];
    case 'node':
      return ['node', filePath, ...args];
    case 'shell':
      return ['sh', filePath, ...args];
  }
}

/**
 * Restricted guest environment: a fixed minimal base plus the sandbox
 * env and the per-exec env. Nothing from the host process environment
 * leaks in.
 */
export function buildGuestEnv(
  sandboxEnv: Record<string, string> | undefined,
  reqEnv: Record<string, string> | undefined,
  home: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm',
  };
  for (const [key, value] of Object.entries(sandboxEnv ?? {})) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(reqEnv ?? {})) {
    env[key] = value;
  }
  return env;
}

/**
 * `prlimit` wrapper prefix enforcing the given limits via rlimits.
 * Returns [] when no limit is set (no wrapper needed). cgroup v2 is not
 * writable on this host, so rlimits are the only enforcement available.
 * `--nproc` is included whenever any limit is set; it is a no-op for
 * root, which is exempt from RLIMIT_NPROC, but binds non-root runs.
 */
export function buildPrlimitArgs(limits: Limits): string[] {
  const args: string[] = [];
  if (limits.memoryMB !== undefined) {
    args.push(
      `--as=${String(Math.max(1, Math.floor(limits.memoryMB * 1024 * 1024)))}`,
    );
  }
  if (limits.cpuSeconds !== undefined) {
    args.push(`--cpu=${String(Math.max(1, Math.floor(limits.cpuSeconds)))}`);
  }
  if (limits.maxFileSizeMB !== undefined) {
    args.push(
      `--fsize=${String(Math.max(1, Math.floor(limits.maxFileSizeMB * 1024 * 1024)))}`,
    );
  }
  if (args.length === 0) return [];
  args.push('--nproc=256');
  return ['prlimit', ...args, '--'];
}

/**
 * Resolve a user-supplied path inside the workdir, rejecting anything
 * that lexically escapes it (`..`, absolute paths outside the workdir).
 */
export function resolveInWorkdir(workdir: string, target: string): string {
  const abs = path.resolve(workdir, target);
  const rel = path.relative(workdir, abs);
  if (rel === '') {
    throw new BackendError(
      'invalid_path',
      `path must name a file inside the sandbox: ${target}`,
    );
  }
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new BackendError(
      'path_escape',
      `path escapes sandbox workdir: ${target}`,
    );
  }
  return abs;
}

/** realpath of the nearest existing ancestor, re-appending missing parts. */
async function nearestExistingRealpath(target: string): Promise<string> {
  let current = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Reject a target that resolves (through symlinks) outside the workdir.
 * Lexical checks alone are not enough: a guest could plant a symlink
 * inside the workdir pointing at the host filesystem.
 */
async function assertInsideWorkdir(
  workdir: string,
  target: string,
): Promise<void> {
  const realWorkdir = await fs.realpath(workdir);
  const realTarget = await nearestExistingRealpath(target);
  const rel = path.relative(realWorkdir, realTarget);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new BackendError(
      'path_escape',
      `path escapes sandbox workdir: ${target}`,
    );
  }
}

export interface SpawnExecOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes: number;
  onEvent?: (event: ExecStreamEvent) => void;
  /** Called (fire-and-forget) when the process is killed by timeout or kill(). */
  onKill?: () => void;
}

export interface SpawnController {
  result: Promise<ExecResult>;
  kill: () => void;
}

/**
 * Spawn a child in its own process group, stream its output, enforce a
 * wall-clock timeout and an output cap.
 *
 * - stdin is written (if given) and then closed, so programs reading
 *   stdin see EOF instead of hanging.
 * - stdout+stderr are captured up to `maxOutputBytes` combined; beyond
 *   that the child keeps running but output is drained and discarded,
 *   and `truncated` is set. Streaming events stop at the cap as well.
 * - Timeout and kill() SIGKILL the whole process group (`-pgid`), so
 *   grandchildren die too. The result resolves on 'close'; a 5 s
 *   force-resolve covers a wedged child that never reports close.
 * - A spawn failure (e.g. binary missing) rejects with BackendError.
 */
export function spawnExec(options: SpawnExecOptions): SpawnController {
  const start = Date.now();
  const maxBytes = Math.max(0, options.maxOutputBytes);
  let stdout = '';
  let stderr = '';
  let captured = 0;
  let truncated = false;
  let timedOut = false;
  let killed = false;
  let settled = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;

  let resolveResult: (result: ExecResult) => void = () => undefined;
  let rejectResult: (err: Error) => void = () => undefined;
  const result = new Promise<ExecResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    throw new BackendError(
      'spawn_failed',
      `failed to start ${options.command}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdin === null || childStdout === null || childStderr === null) {
    child.kill('SIGKILL');
    throw new BackendError(
      'spawn_failed',
      `failed to start ${options.command}: stdio unavailable`,
    );
  }

  const finish = (code: number | null, signaled: boolean): void => {
    if (settled) return;
    settled = true;
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    const finalResult: ExecResult = {
      exitCode: signaled ? null : code,
      stdout,
      stderr,
      timedOut,
      killed: killed || signaled,
      durationMs: Date.now() - start,
      truncated,
    };
    options.onEvent?.({
      type: 'exit',
      exitCode: finalResult.exitCode,
      timedOut,
    });
    resolveResult(finalResult);
  };

  const killGroup = (): void => {
    if (settled) return;
    killed = true;
    options.onKill?.();
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Process group is already gone.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Child is already gone.
    }
    forceTimer = setTimeout(() => finish(null, true), 5000);
  };

  const push = (which: 'stdout' | 'stderr', chunk: Buffer | string): void => {
    if (captured >= maxBytes) return;
    const buffer =
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const room = maxBytes - captured;
    const take = buffer.subarray(0, room);
    captured += take.length;
    if (take.length < buffer.length) truncated = true;
    const text = take.toString('utf8');
    if (which === 'stdout') stdout += text;
    else stderr += text;
    options.onEvent?.({ type: which, data: text });
  };

  childStdout.on('data', (chunk: Buffer | string) => push('stdout', chunk));
  childStderr.on('data', (chunk: Buffer | string) => push('stderr', chunk));
  child.on('error', (err: Error) => {
    if (settled) return;
    settled = true;
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    options.onEvent?.({ type: 'error', message: err.message });
    rejectResult(
      new BackendError(
        'spawn_failed',
        `failed to start ${options.command}: ${err.message}`,
      ),
    );
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    finish(code, signal !== null);
  });

  childStdin.on('error', () => undefined);
  if (options.stdin !== undefined && options.stdin.length > 0) {
    childStdin.write(options.stdin);
  }
  childStdin.end();

  if (options.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
  }

  return {
    result,
    kill: () => killGroup(),
  };
}

/** Run a command and report whether it exited 0 (used by probes). */
export async function commandSucceeds(
  command: string,
  args: string[],
  timeoutMs = 5000,
): Promise<boolean> {
  try {
    const res = await spawnExec({
      command,
      args,
      timeoutMs,
      maxOutputBytes: 4096,
    }).result;
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/** Where the code/file to execute lives, on the host and in the guest. */
export interface ExecTarget {
  hostPath: string;
  guestPath: string;
}

export interface BackendExecContext {
  req: ExecRequest;
  target: ExecTarget;
  network: NetworkMode;
  timeoutMs?: number;
}

export interface BuiltCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onKill?: () => void;
}

export interface HandleConfig {
  backend: BackendName;
  id: string;
  workdir: string;
  language: Language;
  limits: Limits;
  network: NetworkMode;
  env?: Record<string, string>;
  buildCommand: (ctx: BackendExecContext) => BuiltCommand;
  onDestroy?: () => Promise<void> | void;
}

class GenericSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly backend: BackendName;
  private readonly workdir: string;
  private readonly language: Language;
  private readonly limits: Limits;
  private readonly network: NetworkMode;
  private readonly env: Record<string, string> | undefined;
  private readonly buildCommand: HandleConfig['buildCommand'];
  private readonly onDestroy: HandleConfig['onDestroy'];
  private readonly active = new Set<SpawnController>();
  private destroyed = false;

  constructor(config: HandleConfig) {
    this.id = config.id;
    this.backend = config.backend;
    this.workdir = config.workdir;
    this.language = config.language;
    this.limits = config.limits;
    this.network = config.network;
    this.env = config.env;
    this.buildCommand = config.buildCommand;
    this.onDestroy = config.onDestroy;
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new BackendError(
        'sandbox_destroyed',
        `sandbox ${this.id} has been destroyed`,
      );
    }
  }

  async exec(
    req: ExecRequest,
    onEvent?: (event: ExecStreamEvent) => void,
  ): Promise<ExecResult> {
    this.assertAlive();
    const code = req.code;
    const file = req.file;
    if ((code === undefined) === (file === undefined)) {
      throw new BackendError(
        'invalid_exec_request',
        'exactly one of code or file must be set',
      );
    }
    let target: ExecTarget;
    if (code !== undefined) {
      // Write code to a file so req.stdin stays free for the program.
      const name = mainFileName(req.language);
      const hostPath = path.join(this.workdir, name);
      await fs.writeFile(hostPath, code, 'utf8');
      target = { hostPath, guestPath: `/work/${name}` };
    } else if (file !== undefined) {
      const hostPath = resolveInWorkdir(this.workdir, file);
      let stat: Stats | undefined;
      try {
        stat = await fs.stat(hostPath);
      } catch {
        stat = undefined;
      }
      if (stat === undefined || !stat.isFile()) {
        throw new BackendError(
          'file_not_found',
          `file not found in sandbox: ${file}`,
        );
      }
      const rel = path
        .relative(this.workdir, hostPath)
        .split(path.sep)
        .join('/');
      target = { hostPath, guestPath: `/work/${rel}` };
    } else {
      throw new BackendError(
        'invalid_exec_request',
        'exactly one of code or file must be set',
      );
    }

    const network = req.network ?? this.network;
    const timeoutMs = req.timeoutMs ?? this.limits.timeoutMs;
    const built = this.buildCommand({ req, target, network, timeoutMs });
    const controller = spawnExec({
      command: built.command,
      args: built.args,
      cwd: built.cwd ?? this.workdir,
      env: built.env,
      stdin: req.stdin,
      timeoutMs,
      maxOutputBytes: this.limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      onEvent,
      onKill: built.onKill,
    });
    this.active.add(controller);
    try {
      return await controller.result;
    } finally {
      this.active.delete(controller);
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.assertAlive();
    const target = resolveInWorkdir(this.workdir, filePath);
    await assertInsideWorkdir(this.workdir, target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

  async readFile(filePath: string): Promise<string> {
    this.assertAlive();
    const target = resolveInWorkdir(this.workdir, filePath);
    await assertInsideWorkdir(this.workdir, target);
    try {
      return await fs.readFile(target, 'utf8');
    } catch (err) {
      throw new BackendError(
        'file_not_found',
        `cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async kill(): Promise<void> {
    for (const controller of [...this.active]) {
      controller.kill();
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.kill();
    if (this.onDestroy !== undefined) await this.onDestroy();
    await fs.rm(this.workdir, { recursive: true, force: true });
  }
}

/** Build a SandboxHandle backed by a backend-specific command builder. */
export function createSandboxHandle(config: HandleConfig): SandboxHandle {
  return new GenericSandboxHandle(config);
}
