#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { CellClient } from '../sdk/index.js';
import { ArgParseError, parseArgs, type ParsedArgs } from './args.js';
import { loadManagerPort, runLocalExec } from './local.js';
import type { ExecResult } from '../core/types.js';

const VERSION = '0.1.0';

const USAGE = `cell — sandboxed code execution

Usage:
  cell up [--port N] [--host H] [--token T] [--no-auth]
  cell run <file|-> --lang python|node|shell [--timeout ms] [--memory MB]
       [--network none|allow] [--backend bwrap|process|docker]
       [--env KEY=VAL ...] [--stdin TEXT] [--json]
  cell create [--lang ...] [--backend ...] [--network ...]
       [--timeout ms] [--memory MB] [--json]
  cell list [--json]
  cell logs <id> [--follow] [--json]
  cell exec <id> (--code CODE | --file FILE) --lang ... [--timeout ms] [--json]
  cell kill <id>
  cell destroy <id>
  cell help [command]
  cell --version

Server commands use CELL_API_URL (default http://127.0.0.1:8917)
and CELL_API_TOKEN when set. \`cell run\` executes locally without a server.
`;

const COMMAND_USAGE: Record<string, string> = {
  up: `cell up [--port N] [--host H] [--token T] [--no-auth]

Start the Cell API server. Defaults: --port 8917, --host 127.0.0.1.
Prints "Cell listening on http://host:port" and runs until SIGINT.
`,
  run: `cell run <file|-> --lang python|node|shell [--timeout ms] [--memory MB]
       [--network none|allow] [--backend bwrap|process|docker]
       [--env KEY=VAL ...] [--stdin TEXT] [--json]

Execute code once, locally, without a server. <file> is read from disk;
"-" reads code from stdin (then --stdin is not allowed). stdout goes to
stdout, stderr to stderr; the process exits with the guest's exit code.
--json prints the ExecResult as JSON instead.
`,
  create: `cell create [--lang ...] [--backend ...] [--network ...]
       [--timeout ms] [--memory MB] [--json]

Create a sandbox via the API and print its id (or full JSON with --json).
`,
  list: `cell list [--json]

List sandboxes via the API.
`,
  logs: `cell logs <id> [--follow] [--json]

Print a sandbox's events via the API. --follow streams live events.
`,
  exec: `cell exec <id> (--code CODE | --file FILE) --lang ... [--timeout ms] [--json]

Execute code in an existing sandbox via the API. --file names a file
already inside the sandbox workdir. Prints stdout/stderr and exits
with the guest's exit code.
`,
  kill: `cell kill <id>

Stop a sandbox's work. NOTE: the Cell API has no separate kill route,
so kill currently destroys the sandbox (same as \`cell destroy\`).
`,
  destroy: `cell destroy <id>

Destroy a sandbox via the API.
`,
};

async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgParseError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.stderr.write(USAGE);
      return 2;
    }
    throw err;
  }

  if (args.version) {
    process.stdout.write(`cell ${VERSION}\n`);
    return 0;
  }
  if (args.help && args.command === null) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === null) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (args.help) {
    process.stdout.write(commandUsage(args.command));
    return 0;
  }

  try {
    switch (args.command) {
      case 'help': {
        const topic = args.positional[0];
        process.stdout.write(topic ? commandUsage(topic) : USAGE);
        return 0;
      }
      case 'up':
        return await cmdUp(args);
      case 'run':
        return await cmdRun(args);
      case 'create':
        return await cmdCreate(args);
      case 'list':
        return await cmdList(args);
      case 'logs':
        return await cmdLogs(args);
      case 'exec':
        return await cmdExec(args);
      case 'kill':
        return await cmdKill(args);
      case 'destroy':
        return await cmdDestroy(args);
    }
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}

function commandUsage(topic: string): string {
  return COMMAND_USAGE[topic] ?? USAGE;
}

function makeClient(): CellClient {
  return new CellClient({
    baseUrl: process.env.CELL_API_URL ?? 'http://127.0.0.1:8917',
    token: process.env.CELL_API_TOKEN,
  });
}

async function cmdUp(args: ParsedArgs): Promise<number> {
  const manager = await loadManagerPort();
  let serverMod: Record<string, unknown>;
  try {
    // Specifier kept in a variable so TypeScript does not try to resolve
    // the not-yet-built server module at compile time.
    const serverSpecifier = '../api/server.js';
    serverMod = (await import(serverSpecifier)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      'cannot start the server: the API server module could not be ' +
        `loaded (it may not be built yet). (${errorMessage(err)})`,
    );
  }
  const server = await startServer(serverMod, manager, args);
  process.stdout.write(`Cell listening on http://${args.host}:${args.port}\n`);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      try {
        if (server && typeof server.close === 'function') {
          // close() may be callback-style (http.Server) or
          // promise-style (ApiServer); handle both.
          const closed = server.close(() => resolve()) as unknown;
          if (
            closed &&
            typeof (closed as { then?: unknown }).then === 'function'
          ) {
            (closed as Promise<void>).then(
              () => resolve(),
              () => resolve(),
            );
          }
          return;
        }
      } catch {
        // Fall through to resolving anyway.
      }
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

/**
 * Start the API server module. The server is built by a sibling module,
 * so this probes the shapes it may export — `startServer(manager,
 * opts)`, `createServer(manager, opts)` returning an ApiServer
 * (`{ server, listen(): Promise, close(): Promise }`) or a plain
 * http.Server, or a default export of either form — instead of
 * assuming one.
 */
async function startServer(
  mod: Record<string, unknown>,
  manager: unknown,
  args: ParsedArgs,
): Promise<{ close?: (cb?: () => void) => unknown } | null> {
  const opts = {
    port: args.port,
    host: args.host,
    token: args.noAuth ? undefined : args.token,
    noAuth: args.noAuth,
  };
  const candidates: unknown[] = [
    mod.startServer,
    mod.createServer,
    mod.serve,
    mod.default,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'function') continue;
    const started = (await (
      candidate as (manager: unknown, opts: unknown) => unknown
    )(manager, opts)) as Record<string, unknown> | null | undefined;
    if (started && typeof started === 'object') {
      if (typeof started.listen === 'function') {
        if ('server' in started) {
          // ApiServer shape: listen() takes no arguments and returns
          // a promise that resolves once the server is listening.
          await (started.listen as () => Promise<unknown>)();
          return started as { close?: (cb?: () => void) => unknown };
        }
        // Plain http.Server: listen(port, host, callback).
        await new Promise<void>((resolve, reject) => {
          const srv = started as unknown as {
            once(event: string, listener: (err: Error) => void): void;
            listen(port: number, host: string, cb: () => void): void;
          };
          srv.once('error', reject);
          srv.listen(args.port, args.host, () => resolve());
        });
        return started as { close?: (cb?: () => void) => unknown };
      }
      return started as { close?: (cb?: () => void) => unknown };
    }
    // A starter that returns nothing presumably listened itself.
    if (started === undefined || started === null) return null;
  }
  throw new Error(
    'the loaded server module does not expose startServer(), ' +
      'createServer(), or a usable default export.',
  );
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const file = args.positional[0] as string;
  let code: string;
  if (file === '-') {
    code = await readStdin();
  } else {
    try {
      code = await readFile(file, 'utf8');
    } catch (err) {
      throw new Error(`cannot read ${file}: ${errorMessage(err)}`);
    }
  }
  const result = await runLocalExec({
    code,
    lang: args.lang as NonNullable<ParsedArgs['lang']>,
    timeoutMs: args.timeoutMs,
    memoryMB: args.memoryMB,
    network: args.network,
    backend: args.backend,
    env: args.env,
    stdin: args.stdin,
  });
  return emitExecResult(result, args.json);
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const client = makeClient();
  const sandbox = await client.create({
    language: args.lang,
    backend: args.backend,
    network: args.network,
    timeoutMs: args.timeoutMs,
    memoryMB: args.memoryMB,
    env: Object.keys(args.env).length > 0 ? args.env : undefined,
  });
  process.stdout.write(
    args.json ? `${JSON.stringify(sandbox, null, 2)}\n` : `${sandbox.id}\n`,
  );
  return 0;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const client = makeClient();
  const sandboxes = await client.list();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(sandboxes, null, 2)}\n`);
  } else {
    for (const sb of sandboxes) {
      process.stdout.write(
        `${sb.id}\t${sb.backend}\t${sb.language}\t${sb.status}\n`,
      );
    }
  }
  return 0;
}

async function cmdLogs(args: ParsedArgs): Promise<number> {
  const client = makeClient();
  const id = args.positional[0] as string;
  if (args.follow) {
    // Stream live: print each event as it arrives. The promise only
    // resolves when the server closes the stream (e.g. on SIGINT the
    // process exits).
    await client.logs(id, true, (event) => {
      process.stdout.write(
        args.json ? `${JSON.stringify(event)}\n` : `${formatEvent(event)}\n`,
      );
    });
    return 0;
  }
  const events = await client.logs(id, false);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
  } else {
    for (const event of events) {
      process.stdout.write(`${formatEvent(event)}\n`);
    }
  }
  return 0;
}

function formatEvent(event: {
  seq: number;
  at: string;
  type: string;
  detail?: string;
}): string {
  return `${event.seq}\t${event.at}\t${event.type}${event.detail ? `\t${event.detail}` : ''}`;
}

async function cmdExec(args: ParsedArgs): Promise<number> {
  const client = makeClient();
  const id = args.positional[0] as string;
  const result = await client.exec(id, {
    code: args.code,
    file: args.file,
    language: args.lang as NonNullable<ParsedArgs['lang']>,
    stdin: args.stdin,
    timeoutMs: args.timeoutMs,
  });
  return emitExecResult(result, args.json);
}

async function cmdKill(args: ParsedArgs): Promise<number> {
  const client = makeClient();
  const id = args.positional[0] as string;
  await client.destroy(id);
  process.stdout.write(
    `killed ${id} (note: the Cell API has no separate kill route, so kill destroys the sandbox)\n`,
  );
  return 0;
}

async function cmdDestroy(args: ParsedArgs): Promise<number> {
  const client = makeClient();
  const id = args.positional[0] as string;
  await client.destroy(id);
  process.stdout.write(`destroyed ${id}\n`);
  return 0;
}

/** Print an ExecResult (or its JSON) and return the guest's exit code. */
function emitExecResult(result: ExecResult, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.timedOut) {
      process.stderr.write('error: exec timed out\n');
    }
  }
  return result.exitCode ?? 1;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`error: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
