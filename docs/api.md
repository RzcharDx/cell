# Cell — HTTP API Reference

Base URL: `http://127.0.0.1:8917` by default (`cell up --port 8917
--host 127.0.0.1`). All routes are JSON unless noted. The typed
client for this API is `CellClient` in `src/sdk/client.ts`.

## Authentication

Every `/v1/*` route requires a Bearer token:

```
Authorization: Bearer <token>
```

The token is the server's `--token` option, falling back to the
`CELL_API_TOKEN` environment variable (`resolveToken` in
`src/api/auth.ts`). Comparison is timing-safe. `GET /health` is the
only public route, so load balancers can probe it without a token.

- Missing or wrong token → `401` with code `unauthorized` and message
  `Missing or invalid Authorization header`.
- If the server was started with `--no-auth`, no header is required.
  Never use `--no-auth` on a network anyone else can reach.
- If no token is configured on the server at all, every `/v1/*`
  request fails — there is nothing a client could present that
  matches.

## Errors

All errors use the same body:

```json
{ "error": { "code": "not_found", "message": "sandbox not found" } }
```

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `bad_request` | 400 | Malformed JSON, missing/invalid field, or a path that escapes the workdir. |
| `unauthorized` | 401 | Missing or invalid `Authorization` header. |
| `not_found` | 404 | Unknown route, or unknown sandbox id. |
| `gone` | 410 | Operation on a sandbox that was already destroyed. |
| `payload_too_large` | 413 | Request body exceeds the 1 MiB cap. |
| `limit_exceeded` | 429 | Raised by the manager, e.g. the sandbox cap (`maxSandboxes`) is reached. |
| `backend_unavailable` | 503 | Raised when the requested backend cannot run a sandbox. |
| `internal` | 500 | Anything else. The message is the underlying error message. |

Error codes and their statuses are defined in `src/api/errors.ts`
(`ApiErrorCode`, `API_ERROR_STATUS`). `limit_exceeded` and
`backend_unavailable` are defined there and raised by the
manager/backend layer; the server itself raises `bad_request`,
`unauthorized`, `not_found`, `payload_too_large`, and `internal`.

The manager also throws `invalid_request` and `sandbox_destroyed`
(`CellErrorCode` in `src/core/errors.ts`); the API's error mapper
(`toApiError`) translates them to `bad_request` (400) and `gone`
(410) respectively. Unknown ids return 404 `not_found`; ids of
destroyed sandboxes return 410 `gone`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Server status and backend capabilities (public). |
| `POST` | `/v1/sandboxes` | Create a sandbox. |
| `GET` | `/v1/sandboxes` | List sandboxes. |
| `GET` | `/v1/sandboxes/:id` | Get one sandbox. |
| `DELETE` | `/v1/sandboxes/:id` | Destroy a sandbox. |
| `POST` | `/v1/sandboxes/:id/exec` | Execute code (JSON or SSE stream). |
| `POST` | `/v1/sandboxes/:id/files` | Upload a file into the sandbox. |
| `GET` | `/v1/sandboxes/:id/logs` | Sandbox event log (JSON or SSE with `?follow=1`). |

There is no separate kill route: `cell kill` destroys the sandbox
(see the CLI notes in the README).

### GET /health

Public — no auth required.

Response `200`:

```json
{
  "status": "ok",
  "backends": [
    {
      "name": "bwrap",
      "available": true,
      "isolatesFilesystem": true,
      "isolatesNetwork": true,
      "isolatesProcesses": true,
      "enforcesCpu": true,
      "enforcesMemory": true
    },
    { "name": "docker", "available": false, "reason": "docker is not available: failed to start docker: spawn docker ENOENT", "isolatesFilesystem": true, "isolatesNetwork": true, "isolatesProcesses": true, "enforcesCpu": true, "enforcesMemory": true }
  ]
}
```

`backends` is the live result of each backend's `probe()`. (The SDK
first tries `/v1/health` and falls back to `/health` on 404; only
`/health` exists on the server.)

```bash
curl http://127.0.0.1:8917/health
```

### POST /v1/sandboxes

Auth required. Request body (all fields optional except as noted):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `language` | `"python" \| "node" \| "shell"` | `"python"` | |
| `backend` | `"bwrap" \| "process" \| "docker"` | manager default | Unknown value → 400. |
| `network` | `"none" \| "allow"` | `"none"` | |
| `limits` | object | `{}` (no limits) | See below. |
| `env` | object of string → string | — | Passed to the guest process. Never put secrets here that the guest should not see. |
| `labels` | object of string → string | — | Free-form metadata, returned on the sandbox. |
| `image` | string | — | Docker image; only meaningful for the docker backend. |
| `idempotencyKey` | string | — | Retried creates with the same key return the original sandbox (201) instead of a duplicate. Keys live in server memory only. |

`limits` fields — every field optional, each a non-negative number
(negative or non-numeric → 400); unset means no limit:

| Field | Type | Meaning |
| --- | --- | --- |
| `cpuSeconds` | number | CPU seconds (`RLIMIT_CPU`). |
| `memoryMB` | number | Address-space cap in MiB (`RLIMIT_AS`). |
| `timeoutMs` | number | Wall-clock timeout for a single exec, in ms. |
| `maxOutputBytes` | number | Max bytes captured across stdout+stderr per exec. |
| `maxFileSizeMB` | number | Max size of a single guest-created file, in MiB (`RLIMIT_FSIZE`). |

Response `201` — the `SandboxInfo` directly:

```json
{
  "id": "sb_9f2c...",
  "backend": "bwrap",
  "language": "python",
  "status": "running",
  "createdAt": "2026-11-23T15:00:00.000Z",
  "lastUsedAt": "2026-11-23T15:00:00.000Z",
  "limits": { "timeoutMs": 30000, "memoryMB": 512 },
  "network": "none",
  "labels": { "owner": "zhang" }
}
```

```bash
curl -X POST http://127.0.0.1:8917/v1/sandboxes \
  -H "Authorization: Bearer $CELL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"language": "python", "limits": {"timeoutMs": 30000, "memoryMB": 512}}'
```

### GET /v1/sandboxes

Auth required. Response `200` — a bare JSON array of `SandboxInfo`:

```bash
curl http://127.0.0.1:8917/v1/sandboxes \
  -H "Authorization: Bearer $CELL_API_TOKEN"
```

### GET /v1/sandboxes/:id

Auth required. Response `200` — the `SandboxInfo` directly.
Unknown id → 404 `not_found`.

```bash
curl http://127.0.0.1:8917/v1/sandboxes/sb_9f2c... \
  -H "Authorization: Bearer $CELL_API_TOKEN"
```

### DELETE /v1/sandboxes/:id

Auth required. Destroys the sandbox: kills the guest and removes
the workdir. Response `200`:

```json
{ "status": "destroyed", "id": "sb_9f2c..." }
```

Unknown id → 404 `not_found`.

```bash
curl -X DELETE http://127.0.0.1:8917/v1/sandboxes/sb_9f2c... \
  -H "Authorization: Bearer $CELL_API_TOKEN"
```

### POST /v1/sandboxes/:id/exec

Auth required. Request body (`ExecRequest`):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `code` | string | one of `code`/`file` | Code to run. Non-empty. |
| `file` | string | one of `code`/`file` | Path of a file already inside the sandbox workdir to execute. Non-empty. |
| `language` | `"python" \| "node" \| "shell"` | yes | |
| `stdin` | string | no | Text passed to the guest on stdin. |
| `args` | string[] | no | Arguments to the guest program. |
| `env` | object of string → string | no | Extra env for this exec. |
| `timeoutMs` | number | no | Overrides the sandbox default timeout for this exec; must be positive. |
| `network` | `"none" \| "allow"` | no | Overrides the sandbox network mode for this exec. |

Exactly one of `code` or `file` must be set — both or neither is a
400 `bad_request`. The sandbox is resolved before the body is read,
so an unknown id is a clean 404 before any streaming starts.

**JSON response** `200` — the `ExecResult` plus a `sandbox` summary:

```json
{
  "exitCode": 0,
  "stdout": "hello\n",
  "stderr": "",
  "timedOut": false,
  "killed": false,
  "durationMs": 42,
  "truncated": false,
  "sandbox": { "id": "sb_9f2c...", "status": "running" }
}
```

`truncated` is true when output was cut at `maxOutputBytes`.
`timedOut` is true when the wall-clock timeout fired; `killed` is
true when the exec was killed for another reason.

```bash
curl -X POST http://127.0.0.1:8917/v1/sandboxes/sb_9f2c.../exec \
  -H "Authorization: Bearer $CELL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"language": "python", "code": "print(\"hello\")"}'
```

**SSE response** — send `Accept: text/event-stream` to stream the
exec live. Events are named after their type:

```
event: stdout
data: {"type":"stdout","data":"hello\n"}

event: exit
data: {"type":"exit","exitCode":0,"timedOut":false}
```

Event types (`ExecStreamEvent`):

| Type | Fields | Meaning |
| --- | --- | --- |
| `stdout` | `data` | A chunk of guest stdout. |
| `stderr` | `data` | A chunk of guest stderr. |
| `exit` | `exitCode`, `timedOut` | The guest finished. Always the last event; the server synthesizes one if the backend does not emit it (the synthesized exit also carries `killed`, `durationMs`, and `truncated`). |
| `error` | `message` | The exec failed (e.g. backend error). The stream ends after this. |

The stream ends when the response ends (after the `exit` or `error`
event). The SDK (`CellClient.execStream`) assembles an `ExecResult`
from the streamed events.

```bash
curl -N -X POST http://127.0.0.1:8917/v1/sandboxes/sb_9f2c.../exec \
  -H "Authorization: Bearer $CELL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"language": "python", "code": "import time; print(1); time.sleep(1); print(2)"}'
```

### POST /v1/sandboxes/:id/files

Auth required. Writes a file into the sandbox workdir.

Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | yes | Relative to the workdir. Normalized server-side; absolute paths, `..` escapes, and NUL bytes are rejected with 400. |
| `content` | string | yes | File contents (UTF-8 text). |

Response `200`: `{ "path": "<normalized path>" }`.

```bash
curl -X POST http://127.0.0.1:8917/v1/sandboxes/sb_9f2c.../files \
  -H "Authorization: Bearer $CELL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path": "main.py", "content": "print(\"hello\")"}'
```

### GET /v1/sandboxes/:id/logs

Auth required. Response `200` — the sandbox event log:

```json
{
  "events": [
    { "seq": 1, "at": "2026-11-23T15:00:00.000Z", "type": "created" },
    { "seq": 2, "at": "2026-11-23T15:00:01.000Z", "type": "exec", "detail": "python" }
  ]
}
```

Add `?follow=1` to stream live events as SSE instead (event name
`log`, one event per log record, starting with the full history).
Follow is selected by the `?follow=1` query parameter, not by the
`Accept` header.

```bash
curl http://127.0.0.1:8917/v1/sandboxes/sb_9f2c.../logs \
  -H "Authorization: Bearer $CELL_API_TOKEN"

curl -N "http://127.0.0.1:8917/v1/sandboxes/sb_9f2c.../logs?follow=1" \
  -H "Authorization: Bearer $CELL_API_TOKEN"
```

## Limits

- Request bodies are capped at 1 MiB (`maxBodyBytes`, default
  `1024 * 1024`). Larger bodies are rejected with 413
  `payload_too_large` before they are read in full.
- There is no pagination on list/logs in this version; both return
  the full array.
