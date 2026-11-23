import type { BackendName, Language, NetworkMode } from '../core/types.js';

/** Thrown by parseArgs for usage errors. The CLI maps these to exit 2. */
export class ArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgParseError';
  }
}

export type CommandName =
  | 'up'
  | 'run'
  | 'create'
  | 'list'
  | 'logs'
  | 'exec'
  | 'kill'
  | 'destroy'
  | 'help';

export const COMMANDS: readonly CommandName[] = [
  'up',
  'run',
  'create',
  'list',
  'logs',
  'exec',
  'kill',
  'destroy',
  'help',
];

const LANGUAGES: readonly Language[] = ['python', 'node', 'shell'];
const BACKENDS: readonly BackendName[] = ['bwrap', 'process', 'docker'];
const NETWORKS: readonly NetworkMode[] = ['none', 'allow'];

export interface ParsedArgs {
  /** Null when no command was given (e.g. bare `cell` or `--version`). */
  command: CommandName | null;
  help: boolean;
  version: boolean;
  json: boolean;
  /** Positional arguments after the command, in order. */
  positional: string[];
  lang?: Language;
  backend?: BackendName;
  network?: NetworkMode;
  timeoutMs?: number;
  memoryMB?: number;
  env: Record<string, string>;
  /** Text passed to the guest process on stdin (`--stdin`). */
  stdin?: string;
  /** Code to exec (`--code`, for `cell exec`). */
  code?: string;
  /** Guest-side file path to exec (`--file`, for `cell exec`). */
  file?: string;
  follow: boolean;
  port: number;
  host: string;
  token?: string;
  noAuth: boolean;
}

const VALUE_FLAGS = new Set([
  '--lang',
  '--backend',
  '--network',
  '--timeout',
  '--memory',
  '--env',
  '--stdin',
  '--code',
  '--file',
  '--port',
  '--host',
  '--token',
]);

const BOOLEAN_FLAGS = new Set([
  '--json',
  '--follow',
  '--no-auth',
  '--help',
  '--version',
]);

/**
 * Parse `argv` (normally `process.argv.slice(2)`) into a ParsedArgs.
 * Throws ArgParseError on unknown commands/flags, missing values, bad
 * enum/numeric values, and per-command arity mistakes.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: null,
    help: false,
    version: false,
    json: false,
    positional: [],
    env: {},
    follow: false,
    port: 8917,
    host: '127.0.0.1',
    noAuth: false,
  };

  let endOfFlags = false;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] as string;
    i += 1;

    if (!endOfFlags && token === '--') {
      endOfFlags = true;
      continue;
    }

    if (!endOfFlags && token === '-') {
      // A lone dash is a positional (the `run -` stdin shorthand).
      args.positional.push(token);
      continue;
    }

    if (!endOfFlags && (token.startsWith('--') || token === '-h')) {
      let name = token;
      let inlineValue: string | undefined;
      const eq = token.indexOf('=');
      if (token.startsWith('--') && eq !== -1) {
        name = token.slice(0, eq);
        inlineValue = token.slice(eq + 1);
      }
      if (name === '-h') name = '--help';

      if (BOOLEAN_FLAGS.has(name)) {
        if (inlineValue !== undefined) {
          throw new ArgParseError(`flag ${name} does not take a value`);
        }
        switch (name) {
          case '--json':
            args.json = true;
            break;
          case '--follow':
            args.follow = true;
            break;
          case '--no-auth':
            args.noAuth = true;
            break;
          case '--help':
            args.help = true;
            break;
          case '--version':
            args.version = true;
            break;
        }
        continue;
      }

      if (VALUE_FLAGS.has(name)) {
        let value = inlineValue;
        if (value === undefined) {
          if (i >= argv.length) {
            throw new ArgParseError(`flag ${name} requires a value`);
          }
          value = argv[i] as string;
          i += 1;
        }
        applyValueFlag(args, name, value);
        continue;
      }

      throw new ArgParseError(`unknown flag: ${name}`);
    }

    if (!endOfFlags && args.command === null) {
      if ((COMMANDS as readonly string[]).includes(token)) {
        args.command = token as CommandName;
        continue;
      }
      throw new ArgParseError(`unknown command: ${token}`);
    }

    args.positional.push(token);
  }

  validate(args);
  return args;
}

function applyValueFlag(args: ParsedArgs, name: string, value: string): void {
  switch (name) {
    case '--lang':
      if (!(LANGUAGES as readonly string[]).includes(value)) {
        throw new ArgParseError(
          `invalid --lang ${JSON.stringify(value)} (expected one of: python, node, shell)`,
        );
      }
      args.lang = value as Language;
      break;
    case '--backend':
      if (!(BACKENDS as readonly string[]).includes(value)) {
        throw new ArgParseError(
          `invalid --backend ${JSON.stringify(value)} (expected one of: bwrap, process, docker)`,
        );
      }
      args.backend = value as BackendName;
      break;
    case '--network':
      if (!(NETWORKS as readonly string[]).includes(value)) {
        throw new ArgParseError(
          `invalid --network ${JSON.stringify(value)} (expected one of: none, allow)`,
        );
      }
      args.network = value as NetworkMode;
      break;
    case '--timeout':
      args.timeoutMs = parsePositiveInt(value, '--timeout');
      break;
    case '--memory':
      args.memoryMB = parsePositiveInt(value, '--memory');
      break;
    case '--port':
      args.port = parsePositiveInt(value, '--port');
      if (args.port > 65535) {
        throw new ArgParseError('--port must be between 1 and 65535');
      }
      break;
    case '--host':
      if (!value) throw new ArgParseError('--host requires a non-empty value');
      args.host = value;
      break;
    case '--token':
      if (!value) throw new ArgParseError('--token requires a non-empty value');
      args.token = value;
      break;
    case '--env': {
      const eq = value.indexOf('=');
      if (eq <= 0) {
        throw new ArgParseError(
          `--env expects KEY=VAL, got ${JSON.stringify(value)}`,
        );
      }
      args.env[value.slice(0, eq)] = value.slice(eq + 1);
      break;
    }
    case '--stdin':
      args.stdin = value;
      break;
    case '--code':
      args.code = value;
      break;
    case '--file':
      args.file = value;
      break;
  }
}

function parsePositiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ArgParseError(
      `${flag} expects a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ArgParseError(
      `${flag} expects a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function requirePositionals(
  args: ParsedArgs,
  count: number,
  what: string,
): void {
  if (args.positional.length !== count) {
    throw new ArgParseError(
      `${args.command} expects exactly ${count} ${what}, got ${args.positional.length}`,
    );
  }
}

function validate(args: ParsedArgs): void {
  if (args.command === null) return;
  switch (args.command) {
    case 'up':
      requirePositionals(args, 0, 'argument(s)');
      if (args.token !== undefined && args.noAuth) {
        throw new ArgParseError(
          '--token and --no-auth cannot be used together',
        );
      }
      break;
    case 'run': {
      requirePositionals(args, 1, 'file argument');
      if (args.lang === undefined) {
        throw new ArgParseError('run requires --lang python|node|shell');
      }
      if (args.code !== undefined || args.file !== undefined) {
        throw new ArgParseError('run takes a file argument, not --code/--file');
      }
      if (args.positional[0] === '-' && args.stdin !== undefined) {
        throw new ArgParseError(
          '--stdin cannot be used when reading code from stdin (`run -`)',
        );
      }
      break;
    }
    case 'create':
      requirePositionals(args, 0, 'argument(s)');
      break;
    case 'list':
      requirePositionals(args, 0, 'argument(s)');
      break;
    case 'logs':
      requirePositionals(args, 1, 'sandbox id');
      break;
    case 'exec': {
      requirePositionals(args, 1, 'sandbox id');
      if (args.lang === undefined) {
        throw new ArgParseError('exec requires --lang python|node|shell');
      }
      const hasCode = args.code !== undefined;
      const hasFile = args.file !== undefined;
      if (hasCode === hasFile) {
        throw new ArgParseError(
          'exec requires exactly one of --code CODE or --file FILE',
        );
      }
      break;
    }
    case 'kill':
    case 'destroy':
      requirePositionals(args, 1, 'sandbox id');
      break;
    case 'help':
      if (args.positional.length > 1) {
        throw new ArgParseError('help takes at most one command name');
      }
      break;
  }
}
