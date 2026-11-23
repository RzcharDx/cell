# Cell

Cell is a sandboxed code execution service in TypeScript (Node 20+,
zero runtime dependencies) — an E2B/Daytona-style sandbox service in
miniature. Create a sandbox, run code in it, destroy it, over HTTP or
from the CLI.

> Status: all modules are in place, the full test suite passes
> (131 tests), and the quickstart below was verified end-to-end on
> 2026-11-23 against a live server (`cell up` + curl
> create/exec/destroy) and via `cell run` on both the bwrap and
> process backends.

## Quickstart

```bash
npm install
npm run build
```

Start the server (defaults: `127.0.0.1:8917`, Bearer auth from
`CELL_API_TOKEN`):

```bash
export CELL_API_TOKEN="$(openssl rand -hex 16)"
cell up
# Cell listening on http://127.0.0.1:8917
```

Create a sandbox and run code in it:

```bash
curl -X POST http://127.0.0.1:8917/v1/sandboxes \
  -H "Authorization: Bearer $CELL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"language": "python", "limits": {"timeoutMs": 30000, "memoryMB": 512}}'
# {"id":"sb_...","backend":"bwrap","language":"python","status":"running", ...}

curl -X POST http://127.0.0.1:8917/v1/sandboxes/sb_.../exec \
  -H "Authorization: Bearer $CELL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"language": "python", "code": "print(\"hello from the sandbox\")"}'
# {"exitCode":0,"stdout":"hello from the sandbox\n","stderr":"","timedOut":false,...}
```

Or run a file once, locally, without a server:

```bash
cell run ./main.py --lang python
```

More CLI: `cell create`, `cell list`, `cell logs <id> [--follow]`,
`cell exec <id> --code CODE --lang python`, `cell destroy <id>`.
`cell kill <id>` destroys the sandbox (there is no separate kill
route). `cell --help` prints full usage.

## Architecture

```
CLI / SDK  →  HTTP API (src/api/)  →  Manager (src/core/manager.ts)
                                          →  backends (bwrap | process | docker)
```

- **Runtime backends** implement `RuntimeBackend` (`probe` +
  `create`): `bwrap` is the real sandbox (namespaces + a network
  namespace via `unshare --net`), `process` is a plain child process
  with rlimits (not a security boundary), and `docker` is real
  container isolation but unavailable in this environment.
- **Manager** owns sandbox lifetimes, the warm pool (`poolSize`),
  idle reaping (`idleTimeoutSeconds`), and the per-sandbox event log.
- **API** is a zero-dependency `node:http` server with Bearer auth
  and a uniform `{error: {code, message}}` error body.
- **CLI/SDK** are the two clients: `cell` on the command line,
  `CellClient` in code.

Details: [docs/architecture.md](docs/architecture.md),
[docs/runtime.md](docs/runtime.md).

## API reference (summary)

Full reference: [docs/api.md](docs/api.md).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Status + live backend capabilities (public). |
| `POST` | `/v1/sandboxes` | Create a sandbox (201). |
| `GET` | `/v1/sandboxes` | List sandboxes. |
| `GET` | `/v1/sandboxes/:id` | Get one sandbox. |
| `DELETE` | `/v1/sandboxes/:id` | Destroy a sandbox. |
| `POST` | `/v1/sandboxes/:id/exec` | Execute code — JSON, or SSE with `Accept: text/event-stream`. |
| `POST` | `/v1/sandboxes/:id/files` | Upload a file into the sandbox. |
| `GET` | `/v1/sandboxes/:id/logs` | Event log — JSON, or SSE with `?follow=1`. |

All `/v1/*` routes require `Authorization: Bearer <token>`.
Create is idempotent when the body carries an `idempotencyKey`.

## Security notes

Full threat model: [SECURITY.md](SECURITY.md).

- The attacker is anyone who can submit arbitrary code. The bwrap
  backend isolates filesystem, network, and processes; the `process`
  backend does **not** isolate anything — never use it for untrusted
  code.
- There is no cgroup enforcement on this host, so resource limits
  are rlimits plus timeout kills: best-effort, not hard guarantees.
  A fork bomb is mitigated only by `RLIMIT_NPROC`.
- Env values and secrets never appear in logs, event logs, error
  messages, or API responses (`sanitizeEnvForLogging`,
  `redactSecrets` in `src/security/model.ts`). Secrets passed via
  `env` are visible to the guest process by design.
- Run behind auth, bind localhost by default, never expose
  `CELL_API_TOKEN`, and run the server as an unprivileged user in
  production.

## What Cell is / is not

**Is:**

- An E2B/Daytona-style sandbox service in miniature — create, exec,
  destroy, with streaming output, file upload, and an event log.
- A portfolio-quality codebase: TypeScript strict, zero runtime
  dependencies, typed SDK and CLI, and an honest security model.

**Is not:**

- A VM. bwrap namespaces are a real boundary, but kernel exploits
  are out of scope.
- A multi-tenant cloud. There is no tenant isolation, billing, or
  autoscaling — and the `process` backend is not a security boundary
  at all.
- A production-hardened platform. No cgroup enforcement on this host,
  idempotency keys live in server memory only, and the server must
  run behind auth and TLS in any real deployment.
- A Docker service here: the docker backend is unavailable in this
  environment (no Docker installed).

## Development

```bash
npm run build   # compile src/ to dist/
npm run check   # typecheck src and tests
npm run lint    # eslint src tests
npm test        # vitest
npx prettier --check src tests
```
