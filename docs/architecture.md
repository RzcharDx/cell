# Cell — Architecture

Cell is a sandboxed code execution service: a client creates a
sandbox, runs code in it, and destroys it. The shared contract for
every component is `src/core/types.ts` (`Language`, `NetworkMode`,
`BackendName`, `Limits`, `ExecRequest`, `ExecResult`, `SandboxInfo`,
`BackendCapabilities`, `RuntimeBackend`, `SandboxHandle`,
`ManagerOptions`, `SandboxEvent`).

> Implementation status at the time of writing: the API server
> (`src/api/`), CLI (`src/cli/`), SDK (`src/sdk/`), security model
> (`src/security/`), manager (`src/core/manager.ts`), and runtime
> backends with their registry (`src/runtime/index.ts`) are all in
> place, the full test suite passes, and end-to-end execution was
> verified live on 2026-11-23 (`cell up` + curl create/exec/destroy,
> and `cell run` on both backends). One latent gap remains: the
> manager's no-resolver fallback imports `../runtime/registry.js`,
> which does not exist (see `docs/runtime.md`).

## Component diagram

```
                  +------------------+
                  |   CLI (`cell`)   |  local one-shot runs, or
                  |  src/cli/        |  a thin client over the API
                  +--------+---------+
                           |
                  +--------v---------+        +------------------+
                  |   SDK client     |        |  HTTP API server |
                  |  src/sdk/        +------->|  src/api/        |
                  |  CellClient      |  HTTP  |  server.ts       |
                  +------------------+        |  auth.ts errors.ts
                                              +--------+---------+
                                                       |
                                              +--------v---------+
                                              |  Manager         |
                                              |  src/core/       |
                                              |  manager.ts      |
                                              |  (ManagerOptions)|
                                              +---+----+---------+
                                                  |    |
                                   +--------------+    +--------------+
                                   |                                   |
                          +--------v---------+               +--------v---------+
                          |  RuntimeBackend  |               |  RuntimeBackend  |
                          |  bwrap           |               |  process         |
                          |  (real sandbox)  |               |  (child process) |
                          +------------------+               +------------------+
                          +--------v---------+
                          |  RuntimeBackend  |
                          |  docker          |
                          |  (unavailable)   |
                          +------------------+
```

- **Runtime backends** (`RuntimeBackend` in `src/core/types.ts`)
  implement `probe(): Promise<BackendCapabilities>` and
  `create(opts: CreateSandboxOptions): Promise<SandboxHandle>`. Each
  backend owns one isolation strategy; see `docs/runtime.md`.
- **Manager** owns sandbox lifetimes: create/get/list/destroy, exec
  routing, the warm pool, idle reaping, and the event log. Its options
  are `ManagerOptions`: `defaultBackend`, `maxSandboxes`, `poolSize`,
  `defaultLimits`, `workdirRoot`, `idleTimeoutSeconds`.
- **API** (`src/api/server.ts`) is a zero-dependency `node:http`
  server exposing the REST surface in `docs/api.md`. It validates
  input, enforces auth (`src/api/auth.ts`), maps errors
  (`src/api/errors.ts`), and talks to the manager only through the
  `ManagerPort` interface.
- **CLI** (`src/cli/`) parses args (`args.ts`) and either drives the
  API through the SDK (`create`, `list`, `logs`, `exec`, `destroy`,
  `kill`) or runs code locally without a server (`run`, via
  `local.ts`), or starts the server (`up`).
- **SDK** (`src/sdk/client.ts`, `CellClient`) is the typed HTTP
  client for the API, including SSE streaming for exec and logs.

## Request lifecycle

### Create → exec → destroy

```
client                        API                         manager/backend
  |  POST /v1/sandboxes         |                               |
  |--------------------------->|  validate, idempotency check  |
  |                             |------------------------------>|
  |                             |   create sandbox (workdir,    |
  |                             |   backend, limits, network)   |
  |  201 SandboxInfo            |                               |
  |<---------------------------|                               |
  |  POST /v1/sandboxes/:id/exec|                              |
  |--------------------------->|  validate ExecRequest         |
  |                             |------------------------------>|
  |                             |   run code, stream stdout/    |
  |                             |   stderr, enforce timeout     |
  |  200 ExecResult (+sandbox)  |                               |
  |<---------------------------|                               |
  |  DELETE /v1/sandboxes/:id   |                               |
  |--------------------------->|------------------------------>|
  |                             |   kill guest, remove workdir  |
  |  200 {status: destroyed}    |                               |
  |<---------------------------|                               |
```

Sandbox status follows `SandboxStatus` in `src/core/types.ts`:
`creating` → `running` → `stopped` → `destroyed`. `destroy` is
terminal: later operations on a destroyed id fail, and a destroyed
sandbox's id is remembered so a second destroy reports it as
destroyed rather than silently succeeding. An exec on a missing
sandbox is a 404 before any work starts; the server resolves the
sandbox first so a streaming exec never sends headers for a sandbox
that does not exist. A failed or crashing exec does **not** destroy
the sandbox — it stays `running`. `kill()` kills the sandbox's
current work and leaves it running; `stop()` kills current work and
marks it `stopped`, and a later exec restarts a stopped sandbox back
to `running`.

A single exec is one `ExecRequest` — exactly one of `code` or `file`,
a required `language`, optional `stdin`, `args`, `env`, `timeoutMs`,
and `network` — and returns one `ExecResult` (`exitCode`, `stdout`,
`stderr`, `timedOut`, `killed`, `durationMs`, `truncated`). With
`Accept: text/event-stream` the same exec streams `stdout` / `stderr`
/ `exit` / `error` events instead; the server synthesizes an `exit`
event if the backend finishes without emitting one, so a stream
always ends with an exit.

### File upload

`POST /v1/sandboxes/:id/files` with `{path, content}` writes a file
into the sandbox workdir before (or between) execs. The path is
normalized server-side and must stay inside the workdir — absolute
paths, `..` escapes, and NUL bytes are rejected with 400
(`normalizeWorkdirPath` in `src/api/server.ts`).

## Warm pool

`ManagerOptions.poolSize` configures a pool of pre-created idle
sandboxes (default backend, `python`). Creating a sandbox from the
pool avoids backend startup cost (notably bwrap's namespace and bind
setup) on the hot path. The pool is deliberately narrow:

- A pooled sandbox is handed out only when the create asks for
  nothing beyond a backend and a language — no custom limits,
  network, env, labels, or image. Anything else creates fresh.
- The pool refills asynchronously after each checkout
  (`refillPool`), and `waitForPool()` resolves once it is full.
- Pooled sandboxes count toward `maxSandboxes` (default 32) and are
  exempt from the idle reaper.

The idle reaper destroys sandboxes idle longer than
`idleTimeoutSeconds` (default 3600; 0 disables it). Note it
**destroys**, it does not merely stop. Pool membership is invisible
in the API — a sandbox obtained from the pool looks exactly like a
freshly created one.

Manager defaults (`SandboxManager` in `src/core/manager.ts`):
`maxSandboxes` 32, `idleTimeoutSeconds` 3600, `poolSize` 0,
`workdirRoot` `<tmpdir>/cell-sandboxes`, language `python`.

## Idempotency

Create is idempotent when the client supplies an `idempotencyKey` in
the create body. Two layers remember it:

- **API layer** (`src/api/server.ts`): an in-memory map from key to
  the `SandboxInfo` it created; a retried create with the same key
  returns the original sandbox with 201 instead of a duplicate. The
  map is evicted when the sandbox is destroyed (so the same key then
  creates a fresh sandbox); a server restart forgets it.
- **Manager layer** (`SandboxManager`): a key→id map plus dedup of
  concurrent in-flight creates with the same key. The manager frees
  the key when the sandbox is destroyed, so the same key then creates
  a fresh sandbox instead of returning the old one.

Only create is idempotent: exec, file upload, and destroy are not
deduplicated, so clients must not blindly retry them.

## Event log

Every sandbox has an append-only event log of `SandboxEvent`
records: `{seq, at, type, detail?}`. `seq` is a per-sandbox sequence
number, `at` an ISO timestamp, `type` a short event name, and
`detail` an optional human-readable string. Read it with
`GET /v1/sandboxes/:id/logs` (JSON `{events: [...]}`), or follow it
live with `?follow=1`, which streams events as SSE (`event: log`).
The log is capped at 500 events per sandbox (oldest dropped first),
and the events of the last 100 destroyed sandboxes are kept as
tombstones, so `GET .../logs` still works after destroy.

Event types the manager records: `created`, `pool_checkout`,
`started` (a stopped sandbox restarted by exec), `exec_started`,
`exec_finished`, `killed`, `stopped`, `destroyed`.

The event log is for operations, not secrets: `detail` must never
contain env values or secrets. Anything recorded there goes through
`sanitizeEnvForLogging` / `redactSecrets` first (see `SECURITY.md`).
