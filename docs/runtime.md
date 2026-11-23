# Cell — Runtime Backends

Cell runs guest code through a pluggable backend. Every backend
implements the `RuntimeBackend` interface in `src/core/types.ts`:

```ts
interface RuntimeBackend {
  readonly name: BackendName;
  probe(): Promise<BackendCapabilities>;
  create(opts: CreateSandboxOptions): Promise<SandboxHandle>;
}
```

`probe()` reports what the backend can do, live, as a
`BackendCapabilities` record; `create()` returns a `SandboxHandle`
(`exec`, `writeFile`, `readFile`, `kill`, `destroy`). The API reports
probe results at `GET /health`, and the security model's static table
(`capabilityMatrix()` in `src/security/model.ts`) states the same
capabilities as the trust contract.

> Implementation status at the time of writing: the backend
> modules (`src/runtime/backends/`, registry in `src/runtime/index.ts`)
> have landed and the full suite passes. End-to-end execution was
> verified live on 2026-11-23 (`cell up` + curl create/exec/destroy,
> and `cell run` on both backends).

## The three backends

### bwrap — the real sandbox

Bubblewrap (`bwrap` 0.9.0) with:

- read-only binds of the system directories the guest needs;
- a tmpfs `/tmp`;
- a private workdir per sandbox, bind-mounted in;
- PID, IPC, and UTS namespaces, so the guest cannot see host
  processes or other sandboxes;
- no bind of `/etc` as a whole — the guest cannot see `/home`,
  `/root`, or `/etc/shadow` (verified by probe: with `/etc` unbound,
  those paths do not exist inside the sandbox). Instead a minimal
  private `/etc` (resolv.conf copied from the host, plus static
  passwd/group/hosts) is bound read-only, and the host's
  `/etc/ssl/certs` is bound read-only over pre-created empty
  `ssl/certs` directories inside that minimal `/etc`, so TLS works
  in `network=allow` mode. (An earlier version bound the certs
  without the pre-created directories and every exec failed with
  `bwrap: Can't mkdir parents for /etc/ssl/certs` — the directories
  are the fix.)

Network isolation is **not** `bwrap --unshare-net`: that flag is
broken in this environment (loopback setup fails with `bwrap:
loopback: Failed RTM_NEWADDR`). Instead bwrap runs inside
`unshare --net --fork`, which was verified to work — the guest gets a
fresh network namespace with loopback down and no route anywhere.
`network: 'allow'` is the only mode that skips the network
namespace; the default for every sandbox is `network: 'none'`.

bwrap is the backend to use for anything untrusted. It is a genuine
sandbox boundary — real filesystem, process, and network isolation —
but it is not a VM: kernel exploits are out of scope (see
`SECURITY.md`).

### process — a child process, not a boundary

The `process` backend spawns the guest as a plain child process with
rlimits and a cwd jail inside the sandbox workdir. It enforces CPU
and memory via rlimits and a wall-clock timeout, exactly like bwrap.
On top of that it opportunistically wraps execs in new namespaces
when `unshare` is present: `--net` for `network=none` and `--pid`
for process isolation — and its live probe reports exactly what
worked (`GET /health` currently shows the process backend isolating
network and processes on this host, but not the filesystem). If
`unshare` is unavailable, `network=none` fails with a clear error
rather than silently running connected.

That does not make it a boundary. The guest still runs on the host
filesystem with no mount namespace: it can read host files subject
to OS permissions, and the namespace wrappers are opportunistic
rather than the backend's designed guarantee. The security model
(`capabilityMatrix()`) therefore rates the process backend as
isolating nothing — the conservative rating — even though the live
probe may show the two namespace wrappers as active. Use it only
for local development and trusted code. Never present it as a
sandbox.

### docker — real isolation, unavailable here

The docker backend would run each sandbox as a container — real
filesystem, network, and process isolation with cgroup enforcement.
But no Docker (and no podman) is installed in this environment, so
the backend reports `available: false` with reason `docker not
available in this environment`, and any create requesting it fails
with 503 `backend_unavailable`. The code must not pretend otherwise.

## Probing and selection

Each backend's `probe()` checks that its tooling actually works in
the current environment (e.g. the docker backend checks for a Docker
daemon; the bwrap backend checks that `bwrap` runs) and returns a
`BackendCapabilities` record: `available`, an optional `reason`,
`isolatesFilesystem`, `isolatesNetwork`, `isolatesProcesses`,
`enforcesCpu`, `enforcesMemory`. `GET /health` returns the probe
results for all backends.

Selection policy for a create (implemented by `selectBackend` in
`src/runtime/index.ts`):

1. An explicit `backend` in the create request wins. If that backend
   is unavailable, the create fails with 503 `backend_unavailable`
   rather than silently falling back to a weaker backend — a silent
   fallback from bwrap to `process` would be a security downgrade the
   caller never asked for.
2. With no explicit backend, the manager uses its `defaultBackend`
   (`ManagerOptions`), if set.
3. Otherwise the first available backend in preference order
   `bwrap` → `process`. Docker is never selected by default — only
   when explicitly requested (and available) — because it depends on
   an external daemon that may not exist.

One latent gap, current at the time of writing: the manager's
fallback resolver (used only when no resolver is injected) imports
`../runtime/registry.js`, but the registry actually lives at
`src/runtime/index.ts`, so a manager constructed without a resolver
fails creates with `backend_unavailable` ("the runtime registry is
unavailable"). In practice the CLI injects a resolver built from
`src/runtime/index.ts`, so `cell run` and `cell up` work; only a
bare `new SandboxManager({})` hits the bad import. The
manager-integration test (`tests/manager-integration.test.ts`) also
looks for a `src/runtime/registry.ts` that does not exist, and
skips.

## Limits enforcement

There is no cgroup enforcement in this environment (see below), so
limits are enforced with rlimits plus wall-clock timeout kills.
Limits come from `Limits` in `src/core/types.ts`; every field is
optional and unset means no limit.

| Limit field | Enforcement | Notes |
| --- | --- | --- |
| `cpuSeconds` | `RLIMIT_CPU` | CPU seconds consumed by the guest. Hitting it kills the process with `SIGKILL` after `SIGXCPU`. |
| `memoryMB` | `RLIMIT_AS` | Address-space cap. This is virtual address space, not resident memory — a guest can be killed for address-space use it never touched. |
| `timeoutMs` | wall-clock timer | The exec is killed when the timer fires; the result reports `timedOut: true`. A per-exec `timeoutMs` overrides the sandbox default. |
| `maxOutputBytes` | output capture cap | stdout+stderr beyond the cap are discarded; the result reports `truncated: true`. |
| `maxFileSizeMB` | `RLIMIT_FSIZE` | A guest write past the cap fails with `SIGXFSZ` / `EFBIG`. |

Fixed internal guards (not user-settable, applied to every exec):

| Guard | Purpose |
| --- | --- |
| `RLIMIT_NOFILE` | Caps open file descriptors, so a guest cannot exhaust the host's fd table. |
| `RLIMIT_NPROC` | Caps the guest's process count. This is the only mitigation for a fork bomb — there is no cgroup `pids.max` to fall back on. |

Resource limits are therefore **best-effort, not hard guarantees**:
rlimits cap the worst cases, but without cgroups there is no
accounting-based throttling and no hard resident-memory ceiling.
Do not promise customers cgroup-grade isolation on this host.

## Verified environment notes

Probed on this VM (Node v24, Python 3.12.3, running as root):

- `bwrap` 0.9.0 is installed and works with read-only system binds,
  tmpfs `/tmp`, a private workdir, and PID/IPC/UTS namespaces.
- `bwrap --unshare-net` is **broken** (loopback setup fails);
  `unshare --net --fork` around bwrap works and leaves the guest
  with loopback down.
- With `/etc` not bound, the guest cannot see `/home`, `/root`, or
  `/etc/shadow`.
- No Docker, no podman.
- cgroup v2 is mounted but **not writable** (`/sys/fs/cgroup` rejects
  writes), so no cgroup enforcement is possible. Limits are rlimits
  plus timeout kills only.
- Node v24 and Python 3.12.3 are available as guest runtimes.

## Adding a new backend

1. Create a module under `src/runtime/backends/` implementing
   `RuntimeBackend`: a `name`, a `probe()` that honestly reports
   availability and capabilities, and a `create()` that returns a
   `SandboxHandle` (`exec`, `writeFile`, `readFile`, `kill`,
   `destroy`).
2. Register it in the backend registry (`BACKENDS` in
   `src/runtime/index.ts`) so `probeAll()` includes it and
   `selectBackend()` can choose it.
3. Add its name to the backend lists that validate input:
   `BACKENDS` in `src/api/server.ts` and `BACKENDS` in
   `src/cli/args.ts` — otherwise the API and CLI will reject it with
   400 / usage errors.
4. Add a row to the capability table in `SECURITY.md` and to
   `capabilityMatrix()` in `src/security/model.ts`, stating honestly
   what it isolates. If it does not isolate the filesystem, say so —
   do not list it alongside bwrap.
5. Probe it on the target host and record what is actually available
   in the "Verified environment notes" section above.
