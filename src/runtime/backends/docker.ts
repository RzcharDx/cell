/**
 * Real Docker CLI backend.
 *
 * Runs `docker run --rm -i --network none --memory <mb>m --read-only
 * --cap-drop ALL --security-opt no-new-privileges -v <workdir>:/work
 * -w /work <image> <cmd>`. The workdir is mounted at /work, /tmp is a
 * tmpfs (the rootfs is read-only, so guests need a writable /tmp), and
 * the guest env is passed with `-e` flags (the spawn env only carries
 * what the docker CLI itself needs). Timeout/kill also runs
 * `docker kill <container>` (best effort) because SIGKILLing the CLI
 * alone would orphan the container; each exec gets a unique
 * `--name cell-<id>-<random>`.
 *
 * CPU seconds in Limits is a time budget (RLIMIT_CPU), not a CPU share,
 * so it is deliberately NOT mapped to `docker --cpus`. Timeout is
 * enforced by killing the container, not by a docker flag.
 *
 * Docker is absent on this host: probe() reports available=false with a
 * clear reason, and create()/selectBackend('docker') fail loudly
 * instead of pretending to work.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  BackendCapabilities,
  BackendName,
  CreateSandboxOptions,
  Language,
  RuntimeBackend,
  SandboxHandle,
} from '../../core/types.js';
import { BackendError } from '../errors.js';
import {
  buildGuestEnv,
  createSandboxHandle,
  interpreterCommand,
  spawnExec,
  type BuiltCommand,
} from './common.js';

const DEFAULT_IMAGES: Record<Language, string> = {
  python: 'python:3.12-slim',
  node: 'node:20-slim',
  shell: 'python:3.12-slim',
};

/** Minimal env for the docker CLI itself (not the guest). */
function dockerCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/root',
  };
  if (process.env.DOCKER_HOST !== undefined) {
    env.DOCKER_HOST = process.env.DOCKER_HOST;
  }
  return env;
}

/** Best-effort `docker kill`; the CLI process group is SIGKILLed anyway. */
function killContainer(name: string): void {
  try {
    const child = spawn('docker', ['kill', name], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Best effort only.
  }
}

export class DockerBackend implements RuntimeBackend {
  readonly name: BackendName = 'docker';

  async probe(): Promise<BackendCapabilities> {
    const caps: BackendCapabilities = {
      name: 'docker',
      available: false,
      isolatesFilesystem: true,
      isolatesNetwork: true,
      isolatesProcesses: true,
      enforcesCpu: true,
      enforcesMemory: true,
    };
    try {
      const res = await spawnExec({
        command: 'docker',
        args: ['info'],
        timeoutMs: 10000,
        maxOutputBytes: 8192,
      }).result;
      if (res.exitCode === 0) {
        caps.available = true;
        return caps;
      }
      const detail = (res.stderr || res.stdout).trim().split('\n')[0] ?? '';
      caps.reason = `docker is installed but \`docker info\` failed (exit ${String(res.exitCode)})${detail === '' ? '' : `: ${detail}`}`;
      return caps;
    } catch (err) {
      caps.reason = `docker is not available: ${err instanceof Error ? err.message : String(err)}`;
      return caps;
    }
  }

  async create(opts: CreateSandboxOptions): Promise<SandboxHandle> {
    const caps = await this.probe();
    if (!caps.available) {
      throw new BackendError(
        'backend_unavailable',
        caps.reason ?? 'docker backend is not available on this host',
      );
    }
    await fs.mkdir(opts.workdir, { recursive: true });
    const image = opts.image ?? DEFAULT_IMAGES[opts.language];
    const limits = opts.limits;
    const workdir = opts.workdir;

    return createSandboxHandle({
      backend: 'docker',
      id: opts.id,
      workdir,
      language: opts.language,
      limits,
      network: opts.network,
      env: opts.env,
      buildCommand: (ctx): BuiltCommand => {
        const safeId = opts.id.replace(/[^a-zA-Z0-9_.-]/g, '-');
        const containerName = `cell-${safeId}-${randomBytes(4).toString('hex')}`;
        const argv: string[] = [
          'run',
          '--rm',
          '-i',
          '--name',
          containerName,
          '--network',
          ctx.network === 'none' ? 'none' : 'bridge',
          '--read-only',
          '--tmpfs',
          '/tmp',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '-v',
          `${workdir}:/work`,
          '-w',
          '/work',
        ];
        if (limits.memoryMB !== undefined) {
          argv.push(
            '--memory',
            `${String(Math.max(1, Math.floor(limits.memoryMB)))}m`,
          );
        }
        const env = buildGuestEnv(opts.env, ctx.req.env, '/work');
        for (const [key, value] of Object.entries(env)) {
          argv.push('-e', `${key}=${value}`);
        }
        argv.push(
          image,
          ...interpreterCommand(
            ctx.req.language,
            ctx.target.guestPath,
            ctx.req.args ?? [],
          ),
        );
        return {
          command: 'docker',
          args: argv,
          env: dockerCliEnv(),
          cwd: workdir,
          onKill: () => killContainer(containerName),
        };
      },
    });
  }
}
