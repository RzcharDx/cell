# Cell — Security Model

Cell executes arbitrary code submitted through its API. This document
states the threat model, what each backend actually isolates, what is
**not** protected, and how to operate Cell without turning it into an
open code-execution service on your network.

The enforcement code lives in `src/security/model.ts`
(`capabilityMatrix`, `redactSecrets`, `sanitizeEnvForLogging`,
`isSafePath`); the HTTP layer's auth and error handling lives in
`src/api/auth.ts` and `src/api/errors.ts`.

## Threat model

### Who the attacker is

Anyone who can reach the API with a valid token — or, if the server is
misconfigured, anyone who can reach it at all. Assume the attacker
submits arbitrary code in any supported language (`python`, `node`,
`shell`) and will try to:

- read files outside the sandbox workdir (host secrets, other users'
  data, `/etc/shadow`, SSH keys);
- reach the host network or the internet (exfiltrate data, download
  tooling, attack other hosts);
- see or interfere with other sandboxes running on the same host;
- exhaust host resources (fork bomb, memory hog, disk fill, CPU spin)
  to deny service to other sandboxes or the host itself;
- steal secrets passed to the sandbox as environment variables, or
  trick the service into leaking them through logs, events, or error
  messages.

The guest is **not** trusted to be benign, well-written, or
resource-conscious. Everything in this document follows from that.

### What is protected

| Asset | Protection |
| --- | --- |
| Host filesystem outside the workdir | bwrap backend: the guest only sees the bound system dirs (read-only), a tmpfs `/tmp`, and its private workdir. `/home`, `/root`, and `/etc/shadow` are not visible (verified by probe). |
| Host network | bwrap backend: the guest runs in a fresh network namespace with loopback down, so it has no route out. Default network mode is `none` for every backend. |
| Other sandboxes | bwrap backend: separate mount, PID, IPC, and UTS namespaces per sandbox, plus a private workdir each. |
| Host resources | rlimits (`RLIMIT_AS`, `RLIMIT_CPU`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`, `RLIMIT_NPROC`) plus a wall-clock timeout that kills the exec. Best-effort only — see below. |
| Secrets in env / logs | Env values and secrets never appear in logs, event logs, error messages, or API responses. `sanitizeEnvForLogging` masks sensitive keys before logging; `redactSecrets` scrubs known secrets from text. |

## What each backend actually isolates

| Capability | bwrap | process | docker |
| --- | --- | --- | --- |
| Available in this environment | yes | yes | **no** — Docker is not installed here |
| Isolates filesystem | yes | **no** | yes (when present) |
| Isolates network | yes (via `unshare --net` wrapper) | **no** | yes (when present) |
| Isolates processes | yes | **no** | yes (when present) |
| Enforces CPU | yes (rlimit) | yes (rlimit) | yes |
| Enforces memory | yes (rlimit) | yes (rlimit) | yes |

See `capabilityMatrix()` in `src/security/model.ts` — this table is
the code, not just documentation. `GET /health` reports the same
capabilities live from each backend's `probe()` — with one
deliberate difference: the process backend opportunistically wraps
execs in `unshare --net` / `--pid` namespaces when `unshare` is
present, so its live probe reports network and process isolation as
active on this host, while the static table rates it as isolating
nothing. The static table is the conservative rating: without
filesystem isolation the backend is not a boundary, and the
wrappers are opportunistic, not a designed guarantee (see
`docs/runtime.md`).

### bwrap — a genuine sandbox boundary (but not a VM)

`bwrap` 0.9.0 with read-only binds of the system dirs, a tmpfs
`/tmp`, a private workdir, and PID/IPC/UTS namespaces. Network
isolation is **not** done with `bwrap --unshare-net` — that is broken
in this environment (loopback setup fails) — but by wrapping bwrap in
`unshare --net --fork`, which was verified to work: the guest sees a
network namespace with loopback down and no route anywhere.

### process — NOT a security boundary

The `process` backend is a child process with rlimits and a cwd jail.
The guest can read the host filesystem subject to OS permissions. It
additionally wraps execs in `unshare --net` / `--pid` namespaces
when `unshare` is present (its live probe says so), but that does
not make it a boundary: no filesystem isolation, and the wrappers
are opportunistic. Use it only for local development and trusted
code, never for untrusted multi-tenant workloads. If you only
remember one line of this document, remember this one.

### docker — real isolation, unavailable here

Docker would give real container isolation, but no Docker (or podman)
is installed in this environment, so the backend reports
`available: false` with reason `docker not available in this
environment`. Do not assume it will appear on its own.

## What is NOT protected

- **No cgroup enforcement.** cgroup v2 is not writable in this
  environment, so there are no hard CPU/memory cgroup guarantees.
  Limits are enforced only via rlimits plus wall-clock timeout kills.
  A fork bomb is mitigated only by `RLIMIT_NPROC`; a memory hog is
  capped only by `RLIMIT_AS` (address space, which is not the same as
  resident memory). Resource limits are best-effort, not guarantees.
- **The `process` backend is not a boundary.** See above. Guest code
  there can read host files the OS lets it read.
- **bwrap is not a VM.** Kernel exploits, container escapes via kernel
  bugs, and side channels are out of scope. A sufficiently motivated
  attacker with a kernel vulnerability is not contained by namespaces.
- **Secrets in env are visible to the guest process by design.** If you
  pass a secret to a sandbox via `env`, the code running inside can
  read it — that is the point of passing it. Never pass a secret a
  guest should not have, and never pass host credentials (cloud keys,
  database passwords) into an untrusted sandbox.
- **Secrets shorter than 8 characters are not redacted.**
  `redactSecrets` skips them: blanking every occurrence of a short
  string would destroy ordinary log text. Short secrets must be
  rotated, not logged around.
- **Idempotency keys are kept in server memory only.** A server
  restart forgets them, so a retried create after a restart can
  produce a duplicate sandbox.
- **The event log is not a secret store.** Events carry a `detail`
  string; callers must pass secrets through `redactSecrets` /
  `sanitizeEnvForLogging` before recording them. The security module
  cannot scrub what it never sees.

## Secrets rule

Env values and secrets must **never** appear in logs, event logs,
error messages, or API responses. The two choke points:

- `sanitizeEnvForLogging(env)` — keeps key names, replaces values
  with `[set]` for keys matching
  `/token|secret|password|key|auth/i`, passes other values through.
  Call it before writing env anywhere.
- `redactSecrets(text, secrets)` — replaces every occurrence of each
  known secret (≥ 8 characters; longer secrets first so overlapping
  secrets collapse to one `[redacted]`) with `[redacted]`. Call it on
  any guest output or error text that might contain a secret before
  it is logged or returned.

## Operational guidance

- **Run behind auth.** The API requires `Authorization: Bearer
  <token>` on every `/v1/*` route (token from `--token` or
  `CELL_API_TOKEN`; see `src/api/auth.ts`). `/health` is the only
  public route, so load balancers can probe it. Never expose
  `CELL_API_TOKEN`, and never run with `--no-auth` on a network
  anyone else can reach.
- **Bind to localhost by default.** The server defaults to
  `127.0.0.1:8917`. If you bind a public interface, put Cell behind
  a reverse proxy with TLS and your own authentication in front of
  it.
- **Run the server as an unprivileged user in production.** This
  development VM runs as root; production must not. A sandbox escape
  is far worse when the server itself is root.
- **Keep the host patched.** Namespace isolation is only as good as
  the kernel underneath it. Kernel updates are part of the security
  model, not an afterthought.
- **Use the bwrap backend for anything untrusted.** Prefer
  `bwrap`; fall back to `process` only for local trusted runs.
- **Keep request bodies small.** The server caps request bodies at
  1 MiB by default (413 `payload_too_large` above that).
- **Treat guest file paths as untrusted.** Upload paths must be
  relative and must not escape the workdir. The server normalizes
  them and rejects absolute paths, `..` escapes, and NUL bytes
  (`normalizeWorkdirPath` in `src/api/server.ts`); the security
  module's stricter `isSafePath` rejects any `..` segment at all.
