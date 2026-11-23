# Cell — Build Report

Built 2026-11-23. A real, working sandboxed code execution service in
TypeScript (Node 20+, zero runtime dependencies), at
`~/workspace/projects/cell`. Same *kind* of tool as E2B / Daytona / Modal
sandboxes: an HTTP service that runs untrusted code in isolation, with an
API, a CLI, and a client SDK. Written from scratch, not a clone.

## What it is

```
cell up                                   # start the API server (default :8917)
curl POST /v1/sandboxes                   # create a sandbox
curl POST /v1/sandboxes/:id/exec          # run code, get exit code/stdout/stderr
curl GET  /v1/sandboxes/:id/logs          # event log (or ?follow=1 for live SSE)
curl DELETE /v1/sandboxes/:id             # destroy it
cell run hello.py --lang python           # one-shot local exec, no server needed
```

## Isolation backends found in this VM (probed, not assumed)

| Backend | Available here | Isolation |
| --- | --- | --- |
| `bwrap` (bubblewrap 0.9.0) | **yes — default** | Real: ro-bind system dirs, private tmpfs `/tmp`, private workdir, pid/ipc/uts namespaces. Network via `unshare --net` wrapper (bwrap's own `--unshare-net` is broken here: loopback setup fails). |
| `process` | yes — fallback | Child process + rlimits + cwd jail. **Not a security boundary.** |
| `docker` | **no** (no Docker installed) | Real container isolation, but the backend reports unavailable and refuses to run. Implemented for real (Docker CLI), just not usable here. |

Other verified facts: no podman; cgroup v2 is **not writable** (even as
root), so there is no cgroup enforcement — limits are rlimits only
(`RLIMIT_AS`, `RLIMIT_CPU`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`,
`RLIMIT_NPROC`) plus wall-clock timeout kills. Node v24, Python 3.12.3.
`unshare --net/--pid/--user` all work. `/etc` is never the host's inside
a bwrap sandbox: a minimal private `/etc` (resolv.conf copied in, static
passwd/group/hosts) is bound instead, so the guest cannot see
`/etc/shadow`, `/home`, or `/root`, but DNS and TLS still work.

## Architecture

```
src/
  runtime/      backends: bwrap / process / docker (CLI) + registry
                (probeAll, selectBackend, getBackend) + shared spawn
                machinery (output cap, timeout/group kill, workdir jail)
  core/         SandboxManager: lifecycle (creating → running → stopped
                → destroyed), warm pool, maxSandboxes, idempotency keys,
                per-sandbox event log (capped at 500), idle reaper,
                CellError codes
  api/          HTTP server (Node built-in http only): all /v1 endpoints,
                SSE streaming for exec + logs follow, bearer auth
                (CELL_API_TOKEN, public /health), JSON errors
  cli/          `cell` entry: up/run/create/list/logs/exec/kill/destroy
  sdk/          CellClient (fetch-based, typed, SSE support)
  security/     honest capability matrix, secret redaction, env
                sanitization, path safety
```

Request flow: `CLI/SDK → API → SandboxManager → RuntimeBackend → guest
process`. The agent loop never touches the terminal; the manager never
touches HTTP; each layer is unit-testable in isolation.

## Counts

- **7,141 LOC total** (62 TS files): src 4,493 (runtime 1,152, cli 1,076,
  core 855, api 795, sdk 458, security 157), tests 2,648 (11 files).
  Docs add 1,022 lines (README, SECURITY.md, docs/architecture.md,
  docs/api.md, docs/runtime.md).
- Tests by area: runtime 37 (bwrap 17, process 12, docker 3, registry 5),
  manager 15 + 1 integration, API 21, CLI args 22, SDK 18, CLI run 3,
  security 15.
- Docs: README.md, SECURITY.md, docs/architecture.md, docs/api.md,
  docs/runtime.md, MIT LICENSE, `.github/workflows/ci.yml` (Node 20 + 22,
  build + typecheck + lint + prettier + tests).

## Verification — all green (commands I ran)

```
npm install                              # clean
npm run build                            # tsc — clean
npm run check                            # tsc src + tests — clean
npm run lint                             # eslint — clean
npx prettier --check src tests           # clean
npm test                                 # vitest — 132/132 passed, 11 files
```

## Manual end-to-end smoke test (run by me, 2026-11-23)

Server started with `node dist/cli/index.js up --port 8917 --no-auth`,
then exercised over curl (script saved at `/tmp/cell-smoke.sh`):

| Step | Result |
| --- | --- |
| `GET /health` | `status ok`; bwrap + process available, docker unavailable with reason |
| Create sandbox | `sb_da7f7c19-…`, backend bwrap |
| Exec `math.factorial(20)` | exit 0, stdout `2432902008176640000`, 35 ms |
| Exec `sleep 30`, timeoutMs 2000 | `timedOut: true, killed: true`, 2006 ms |
| Exec with `Accept: text/event-stream` | `line 0/1/2` arrived as separate SSE stdout events, then an exit event |
| Upload `hello.py`, exec it | exit 0, stdout `from file` |
| `GET /v1/sandboxes/:id/logs` | ordered event log (created → exec_started → exec_finished, seq 1..n) |
| Idempotency (same key twice) | same sandbox id both times |
| Destroy, then same key again | a fresh sandbox id (eviction verified) |
| Exec on destroyed sandbox | HTTP 410 `{"error":{"code":"gone",…}}` |
| Destroy + GET | 200 destroyed, then 410 gone |

Also verified separately: `cell run` on the default (bwrap) backend
prints stdout and exits 0, and times out a sleep correctly; bare
`new SandboxManager({})` with no injected resolver now works (fallback
imports the real registry).

## Cuts / known limits (documented in the repo)

1. **No cgroup enforcement** — cgroup v2 is unwritable here; limits are
   rlimits + timeout kills only. A fork bomb is mitigated only by
   `RLIMIT_NPROC`.
2. **Process backend is not a security boundary** — it is resource
   limiting + a cwd jail, not isolation. The capability matrix rates it
   conservative (isolates nothing) even though it opportunistically
   uses `unshare --net/--pid` when present.
3. **Docker backend is real but untestable here** — no Docker installed;
   only the probe-unavailable and rejection paths are exercised.
4. **No default exec timeout** when none is set (contract: unset = no
   limit); callers must set `timeoutMs` or use `kill()`.
5. **Warm pool only serves plain requests** — a create that asks for
   anything beyond backend+language (custom limits, network, env,
   labels, image) bypasses the pool and creates a fresh sandbox.
6. **`cell kill` destroys the sandbox** — the API has no kill route, so
   kill == destroy (documented in `cell help kill`).
7. **`Limits.cpuSeconds` is a time budget, not a CPU share** — it is
   deliberately not mapped to Docker `--cpus` (different semantics).
8. **Idempotency keys live in server memory only** — a restart forgets
   them.
9. Node under a very small `--as` cap may fail to start (RLIMIT_AS
   covers the interpreter's own address space); the memory test uses
   Python, where the behaviour was verified.

## Integration fixes made by the coordinator

- Manager's no-resolver fallback imported a nonexistent
  `../runtime/registry.js` — fixed to `../runtime/index.js` (bare
  `new SandboxManager({})` now works).
- API error mapper did not recognise the manager's `invalid_request` /
  `sandbox_destroyed` codes (surfaced as 500) — now mapped to
  `bad_request` (400) and `gone` (410); docs updated.
- Server idempotency map was never evicted on destroy (a retried
  create after destroy returned the stale sandbox) — now evicted in
  the DELETE handler; verified in the smoke test.
- `tests/manager-integration.test.ts` looked for
  `src/runtime/registry.ts` and always skipped — fixed to
  `src/runtime/index.ts`; it now runs (132/132, 0 skipped).
- `tests/cli-run.test.ts` pinned `--backend process` with a stale
  comment claiming bwrap could not run here — verified bwrap works
  via `cell run` and switched the tests to the default backend.
- `ManagerOptions.idleTimeoutSeconds` doc comment said "stopped" while
  the manager destroys — aligned to "destroyed".

## Constraints honoured

Work stayed under `~/workspace/projects/cell` only. No GitHub account
touched, nothing pushed, no repo created. Network used only for
`npm install`. No secrets or API keys anywhere in the repo (scanned);
no TODO/stub/placeholder functions in shipped code; `node_modules/`
and `dist/` are gitignored. The tree is clean for a later GitHub push.
