/**
 * Plain child_process backend — always available, no sandboxing.
 *
 * The guest runs directly on the host with cwd jailed to the workdir and
 * a restricted environment (fixed base + sandbox/exec env only). rlimits
 * are enforced via a `prlimit` wrapper, same as the bwrap backend.
 * When `unshare` is present at runtime the backend additionally wraps
 * execs in new namespaces: `--net` for network=none and `--pid` for
 * process isolation. Both are probed live; capabilities report exactly
 * what worked, and network=none fails with a clear error when
 * `unshare --net` is unavailable instead of silently running connected.
 */
import { promises as fs } from 'node:fs';
import type {
  BackendCapabilities,
  BackendName,
  CreateSandboxOptions,
  RuntimeBackend,
  SandboxHandle,
} from '../../core/types.js';
import { BackendError } from '../errors.js';
import {
  buildGuestEnv,
  buildPrlimitArgs,
  commandSucceeds,
  createSandboxHandle,
  interpreterCommand,
  type BuiltCommand,
} from './common.js';

export class ProcessBackend implements RuntimeBackend {
  readonly name: BackendName = 'process';

  async probe(): Promise<BackendCapabilities> {
    const net = await commandSucceeds('unshare', [
      '--net',
      '--fork',
      '--',
      'true',
    ]);
    const pid = await commandSucceeds('unshare', [
      '--pid',
      '--fork',
      '--',
      'true',
    ]);
    return {
      name: 'process',
      available: true,
      isolatesFilesystem: false,
      isolatesNetwork: net,
      isolatesProcesses: pid,
      enforcesCpu: true,
      enforcesMemory: true,
    };
  }

  async create(opts: CreateSandboxOptions): Promise<SandboxHandle> {
    const caps = await this.probe();
    await fs.mkdir(opts.workdir, { recursive: true });
    const netOk = caps.isolatesNetwork;
    const pidOk = caps.isolatesProcesses;
    const limits = opts.limits;
    const workdir = opts.workdir;

    return createSandboxHandle({
      backend: 'process',
      id: opts.id,
      workdir,
      language: opts.language,
      limits,
      network: opts.network,
      env: opts.env,
      buildCommand: (ctx): BuiltCommand => {
        const argv: string[] = [];
        const nsFlags: string[] = [];
        if (ctx.network === 'none') {
          if (!netOk) {
            throw new BackendError(
              'network_unavailable',
              'network=none requires `unshare --net`, which is not available on this host; the process backend cannot isolate the network here',
            );
          }
          nsFlags.push('--net');
        }
        if (pidOk) nsFlags.push('--pid');
        if (nsFlags.length > 0) {
          argv.push('unshare', ...nsFlags, '--fork', '--');
        }
        argv.push(...buildPrlimitArgs(limits));
        argv.push(
          ...interpreterCommand(
            ctx.req.language,
            ctx.target.hostPath,
            ctx.req.args ?? [],
          ),
        );
        const command = argv.shift();
        if (command === undefined) {
          throw new BackendError('internal', 'empty process command');
        }
        return {
          command,
          args: argv,
          env: buildGuestEnv(opts.env, ctx.req.env, workdir),
          cwd: workdir,
        };
      },
    });
  }
}
