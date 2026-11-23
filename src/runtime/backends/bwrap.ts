/**
 * bwrap (bubblewrap) backend — the preferred backend on this host.
 *
 * Isolation, verified empirically on this VM:
 * - Filesystem: system dirs are bound read-only (`/usr`, `/lib`, `/lib64`,
 *   `/bin`), `/tmp` is a fresh tmpfs, `/dev` and `/proc` are fresh mounts,
 *   the host workdir is bound at `/work` and is the only writable host
 *   path. `/etc` is NOT the host's: a minimal private dir (resolv.conf
 *   copied from the host, plus static passwd/group/hosts) is bound
 *   read-only at `/etc`, so the guest gets working DNS but can never see
 *   /etc/shadow, /home, or /root. Host /etc/ssl/certs is additionally
 *   bound read-only so TLS works in network=allow mode. With no /etc
 *   bind at all python3 and node still run; the minimal bind exists for
 *   DNS and for programs that read /etc/passwd.
 * - Namespaces: `--unshare-pid --unshare-ipc --unshare-uts`,
 *   `--die-with-parent`, `--new-session`.
 * - Network: `bwrap --unshare-net` is broken on this host ("loopback:
 *   Failed RTM_NEWADDR"), so network=none wraps bwrap in
 *   `unshare --net --fork` (verified: outbound connects fail with
 *   "Network is unreachable"). network=allow runs without the wrapper.
 * - Limits: rlimits via a `prlimit` wrapper (cgroup v2 is not writable
 *   here), see `buildPrlimitArgs` in common.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
  spawnExec,
  type BuiltCommand,
} from './common.js';

async function hostPathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the minimal private /etc for one sandbox next to its workdir.
 * Returns the directory, or null when it could not be created (execs
 * still work without an /etc bind — python3 and node were verified to
 * run with no /etc at all).
 */
async function setupMinimalEtc(workdir: string): Promise<string | null> {
  const etcDir = `${workdir}.cell-etc`;
  try {
    await fs.mkdir(etcDir, { recursive: true });
    const resolv = await fs
      .readFile('/etc/resolv.conf', 'utf8')
      .catch(() => null);
    if (resolv !== null) {
      await fs.writeFile(path.join(etcDir, 'resolv.conf'), resolv, 'utf8');
    }
    await fs.writeFile(
      path.join(etcDir, 'passwd'),
      'root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(etcDir, 'group'),
      'root:x:0:\nnogroup:x:65534:\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(etcDir, 'hosts'),
      '127.0.0.1 localhost\n::1 localhost\n',
      'utf8',
    );
    // Empty mountpoint for the host CA store: bwrap cannot create the
    // parents of a later `--ro-bind /etc/ssl/certs` once /etc itself is
    // bound read-only, so the destination directory must already exist.
    await fs.mkdir(path.join(etcDir, 'ssl', 'certs'), { recursive: true });
    return etcDir;
  } catch {
    await fs
      .rm(etcDir, { recursive: true, force: true })
      .catch(() => undefined);
    return null;
  }
}

export class BwrapBackend implements RuntimeBackend {
  readonly name: BackendName = 'bwrap';

  async probe(): Promise<BackendCapabilities> {
    const caps: BackendCapabilities = {
      name: 'bwrap',
      available: false,
      isolatesFilesystem: true,
      isolatesNetwork: false,
      isolatesProcesses: true,
      enforcesCpu: true,
      enforcesMemory: true,
    };
    let bwrapOk = false;
    try {
      const res = await spawnExec({
        command: 'bwrap',
        args: ['--version'],
        timeoutMs: 5000,
        maxOutputBytes: 4096,
      }).result;
      bwrapOk = res.exitCode === 0;
    } catch {
      bwrapOk = false;
    }
    if (!bwrapOk) {
      caps.reason =
        'bwrap is not installed or failed to run (tried `bwrap --version`)';
      return caps;
    }
    caps.available = true;
    // Network isolation depends on the `unshare --net` wrapper, not on
    // bwrap itself. Report what is actually available.
    caps.isolatesNetwork = await commandSucceeds('unshare', ['--version']);
    return caps;
  }

  async create(opts: CreateSandboxOptions): Promise<SandboxHandle> {
    const caps = await this.probe();
    if (!caps.available) {
      throw new BackendError(
        'backend_unavailable',
        caps.reason ?? 'bwrap backend is not available on this host',
      );
    }
    await fs.mkdir(opts.workdir, { recursive: true });
    const etcDir = await setupMinimalEtc(opts.workdir);
    const sslCerts = await hostPathExists('/etc/ssl/certs');
    const unshareNet = caps.isolatesNetwork;
    const limits = opts.limits;
    const workdir = opts.workdir;

    return createSandboxHandle({
      backend: 'bwrap',
      id: opts.id,
      workdir,
      language: opts.language,
      limits,
      network: opts.network,
      env: opts.env,
      buildCommand: (ctx): BuiltCommand => {
        if (ctx.network === 'none' && !unshareNet) {
          throw new BackendError(
            'network_unavailable',
            'network=none requires the `unshare` command, which is not available on this host',
          );
        }
        const argv: string[] = [...buildPrlimitArgs(limits)];
        if (ctx.network === 'none') {
          argv.push('unshare', '--net', '--fork', '--');
        }
        argv.push(
          'bwrap',
          '--ro-bind',
          '/usr',
          '/usr',
          '--ro-bind',
          '/lib',
          '/lib',
          '--ro-bind',
          '/lib64',
          '/lib64',
          '--ro-bind',
          '/bin',
          '/bin',
          '--tmpfs',
          '/tmp',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--unshare-pid',
          '--unshare-ipc',
          '--unshare-uts',
          '--die-with-parent',
          '--new-session',
        );
        if (etcDir !== null) {
          argv.push('--ro-bind', etcDir, '/etc');
        }
        if (sslCerts) {
          argv.push('--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs');
        }
        argv.push('--bind', workdir, '/work', '--chdir', '/work');
        argv.push(
          ...interpreterCommand(
            ctx.req.language,
            ctx.target.guestPath,
            ctx.req.args ?? [],
          ),
        );
        const command = argv.shift();
        if (command === undefined) {
          throw new BackendError('internal', 'empty bwrap command');
        }
        return {
          command,
          args: argv,
          env: buildGuestEnv(opts.env, ctx.req.env, '/work'),
          cwd: workdir,
        };
      },
      onDestroy: async () => {
        if (etcDir !== null) {
          await fs.rm(etcDir, { recursive: true, force: true });
        }
      },
    });
  }
}
