import { describe, expect, it } from 'vitest';
import { ArgParseError, parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('parses run with a file and all flags', () => {
    const args = parseArgs([
      'run',
      'script.py',
      '--lang',
      'python',
      '--timeout',
      '5000',
      '--memory',
      '256',
      '--network',
      'allow',
      '--backend',
      'process',
      '--env',
      'A=1',
      '--env',
      'B=hello=world',
      '--stdin',
      'input',
      '--json',
    ]);
    expect(args.command).toBe('run');
    expect(args.positional).toEqual(['script.py']);
    expect(args.lang).toBe('python');
    expect(args.timeoutMs).toBe(5000);
    expect(args.memoryMB).toBe(256);
    expect(args.network).toBe('allow');
    expect(args.backend).toBe('process');
    expect(args.env).toEqual({ A: '1', B: 'hello=world' });
    expect(args.stdin).toBe('input');
    expect(args.json).toBe(true);
  });

  it('parses run - (stdin shorthand) and rejects --stdin with it', () => {
    const args = parseArgs(['run', '-', '--lang', 'shell']);
    expect(args.command).toBe('run');
    expect(args.positional).toEqual(['-']);
    expect(() =>
      parseArgs(['run', '-', '--lang', 'shell', '--stdin', 'x']),
    ).toThrow(ArgParseError);
  });

  it('accepts --flag=value form', () => {
    const args = parseArgs(['run', 'a.py', '--lang=python', '--timeout=100']);
    expect(args.lang).toBe('python');
    expect(args.timeoutMs).toBe(100);
  });

  it('applies run defaults', () => {
    const args = parseArgs(['run', 'a.py', '--lang', 'node']);
    expect(args.port).toBe(8917);
    expect(args.host).toBe('127.0.0.1');
    expect(args.json).toBe(false);
    expect(args.follow).toBe(false);
    expect(args.noAuth).toBe(false);
    expect(args.env).toEqual({});
    expect(args.network).toBeUndefined();
    expect(args.backend).toBeUndefined();
  });

  it('requires --lang for run', () => {
    expect(() => parseArgs(['run', 'a.py'])).toThrow(ArgParseError);
  });

  it('requires a file for run', () => {
    expect(() => parseArgs(['run', '--lang', 'python'])).toThrow(ArgParseError);
  });

  it('parses up with defaults and overrides', () => {
    expect(parseArgs(['up'])).toMatchObject({
      command: 'up',
      port: 8917,
      host: '127.0.0.1',
      noAuth: false,
    });
    const args = parseArgs([
      'up',
      '--port',
      '9000',
      '--host',
      '0.0.0.0',
      '--token',
      'secret',
    ]);
    expect(args.port).toBe(9000);
    expect(args.host).toBe('0.0.0.0');
    expect(args.token).toBe('secret');
    expect(parseArgs(['up', '--no-auth']).noAuth).toBe(true);
  });

  it('rejects --token with --no-auth', () => {
    expect(() => parseArgs(['up', '--token', 'x', '--no-auth'])).toThrow(
      ArgParseError,
    );
  });

  it('parses create with optional flags', () => {
    const args = parseArgs([
      'create',
      '--lang',
      'node',
      '--backend',
      'docker',
      '--network',
      'allow',
      '--timeout',
      '3000',
      '--memory',
      '128',
      '--json',
    ]);
    expect(args.command).toBe('create');
    expect(args.lang).toBe('node');
    expect(args.backend).toBe('docker');
    expect(args.network).toBe('allow');
    expect(args.timeoutMs).toBe(3000);
    expect(args.memoryMB).toBe(128);
    expect(args.json).toBe(true);
  });

  it('parses list with --json', () => {
    const args = parseArgs(['list', '--json']);
    expect(args.command).toBe('list');
    expect(args.json).toBe(true);
  });

  it('parses logs with --follow', () => {
    const args = parseArgs(['logs', 'sb-1', '--follow']);
    expect(args.command).toBe('logs');
    expect(args.positional).toEqual(['sb-1']);
    expect(args.follow).toBe(true);
  });

  it('parses exec with --code and with --file', () => {
    const byCode = parseArgs([
      'exec',
      'sb-1',
      '--code',
      'print(1)',
      '--lang',
      'python',
    ]);
    expect(byCode.code).toBe('print(1)');
    expect(byCode.file).toBeUndefined();

    const byFile = parseArgs([
      'exec',
      'sb-1',
      '--file',
      'main.py',
      '--lang',
      'python',
      '--timeout',
      '2000',
    ]);
    expect(byFile.file).toBe('main.py');
    expect(byFile.timeoutMs).toBe(2000);
  });

  it('exec requires exactly one of --code/--file and --lang', () => {
    expect(() => parseArgs(['exec', 'sb-1', '--lang', 'python'])).toThrow(
      ArgParseError,
    );
    expect(() =>
      parseArgs([
        'exec',
        'sb-1',
        '--code',
        'x',
        '--file',
        'y',
        '--lang',
        'python',
      ]),
    ).toThrow(ArgParseError);
    expect(() => parseArgs(['exec', 'sb-1', '--code', 'x'])).toThrow(
      ArgParseError,
    );
  });

  it('parses kill and destroy with an id', () => {
    expect(parseArgs(['kill', 'sb-1']).command).toBe('kill');
    expect(parseArgs(['destroy', 'sb-1']).positional).toEqual(['sb-1']);
    expect(() => parseArgs(['kill'])).toThrow(ArgParseError);
    expect(() => parseArgs(['destroy', 'a', 'b'])).toThrow(ArgParseError);
  });

  it('parses help with an optional topic', () => {
    expect(parseArgs(['help']).command).toBe('help');
    expect(parseArgs(['help', 'run']).positional).toEqual(['run']);
    expect(() => parseArgs(['help', 'a', 'b'])).toThrow(ArgParseError);
  });

  it('parses --version and --help as global flags', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs([]).command).toBeNull();
  });

  it('rejects unknown commands', () => {
    expect(() => parseArgs(['explode'])).toThrow(ArgParseError);
    expect(() => parseArgs(['frobnicate', 'x'])).toThrow(/unknown command/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['list', '--bogus'])).toThrow(/unknown flag/);
    expect(() =>
      parseArgs(['run', 'a.py', '--lang', 'python', '--wat', '1']),
    ).toThrow(ArgParseError);
  });

  it('rejects invalid enum values', () => {
    expect(() => parseArgs(['run', 'a.py', '--lang', 'ruby'])).toThrow(
      /invalid --lang/,
    );
    expect(() => parseArgs(['create', '--backend', 'vm'])).toThrow(
      /invalid --backend/,
    );
    expect(() => parseArgs(['create', '--network', 'sometimes'])).toThrow(
      /invalid --network/,
    );
  });

  it('rejects invalid numbers and malformed --env', () => {
    expect(() =>
      parseArgs(['run', 'a.py', '--lang', 'python', '--timeout', 'abc']),
    ).toThrow(/--timeout/);
    expect(() =>
      parseArgs(['run', 'a.py', '--lang', 'python', '--timeout', '-5']),
    ).toThrow(/--timeout/);
    expect(() => parseArgs(['up', '--port', '70000'])).toThrow(/--port/);
    expect(() =>
      parseArgs(['run', 'a.py', '--lang', 'python', '--env', 'NOEQUALS']),
    ).toThrow(/--env expects KEY=VAL/);
    expect(() =>
      parseArgs(['run', 'a.py', '--lang', 'python', '--env', '=v']),
    ).toThrow(/--env expects KEY=VAL/);
  });

  it('rejects a missing flag value', () => {
    expect(() => parseArgs(['run', 'a.py', '--lang'])).toThrow(
      /requires a value/,
    );
  });

  it('accepts flags before the positional', () => {
    const args = parseArgs(['run', '--lang', 'shell', 's.sh']);
    expect(args.positional).toEqual(['s.sh']);
    expect(args.lang).toBe('shell');
  });
});
