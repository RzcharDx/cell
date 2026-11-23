import { describe, expect, it } from 'vitest';

import {
  capabilityMatrix,
  isSafePath,
  redactSecrets,
  sanitizeEnvForLogging,
} from '../src/security/index.js';

describe('redactSecrets', () => {
  it('replaces every occurrence of a secret', () => {
    const secret = 's3cr3t-value-123';
    expect(
      redactSecrets(`leaked ${secret} and ${secret} again`, [secret]),
    ).toBe('leaked [redacted] and [redacted] again');
  });

  it('redacts several secrets at once', () => {
    expect(
      redactSecrets('a hunter2-token-here b api-key-abcdef', [
        'hunter2-token-here',
        'api-key-abcdef',
      ]),
    ).toBe('a [redacted] b [redacted]');
  });

  it('replaces an overlapping pair with a single placeholder', () => {
    // 'token-value-long' contains 'token-value'; longest first wins.
    expect(
      redactSecrets('got token-value-long!', [
        'token-value',
        'token-value-long',
      ]),
    ).toBe('got [redacted]!');
  });

  it('handles secrets containing regex metacharacters literally', () => {
    expect(redactSecrets('price is $100.00 (a+b)?', ['$100.00 (a+b)?'])).toBe(
      'price is [redacted]',
    );
  });

  it('leaves short secrets untouched so ordinary text is not mangled', () => {
    expect(redactSecrets('the key is in the lock', ['key'])).toBe(
      'the key is in the lock',
    );
    expect(redactSecrets('abcabc', ['abc'])).toBe('abcabc');
  });

  it('ignores empty strings and returns text unchanged for an empty list', () => {
    expect(redactSecrets('nothing to hide', [])).toBe('nothing to hide');
    expect(redactSecrets('nothing to hide', ['', '   '])).toBe(
      'nothing to hide',
    );
  });

  it('redacts a secret of exactly 8 characters', () => {
    expect(redactSecrets('code 12345678 end', ['12345678'])).toBe(
      'code [redacted] end',
    );
  });
});

describe('sanitizeEnvForLogging', () => {
  it('masks token/secret/password/key/auth values and passes through benign ones', () => {
    const out = sanitizeEnvForLogging({
      API_TOKEN: 'tok-123',
      DB_PASSWORD: 'hunter2',
      SESSION_SECRET: 'shh',
      PRIVATE_KEY: '-----BEGIN-----',
      AUTH_HEADER: 'Bearer x',
      NODE_ENV: 'production',
      APP_NAME: 'cell',
      PORT: '3000',
    });
    expect(out).toEqual({
      API_TOKEN: '[set]',
      DB_PASSWORD: '[set]',
      SESSION_SECRET: '[set]',
      PRIVATE_KEY: '[set]',
      AUTH_HEADER: '[set]',
      NODE_ENV: 'production',
      APP_NAME: 'cell',
      PORT: '3000',
    });
  });

  it('matches sensitive keys case-insensitively', () => {
    expect(
      sanitizeEnvForLogging({
        Api_Token: 'x',
        mySecret: 'y',
        LANG: 'en_US.UTF-8',
      }),
    ).toEqual({ Api_Token: '[set]', mySecret: '[set]', LANG: 'en_US.UTF-8' });
  });

  it('does not mutate the input and handles an empty env', () => {
    const env = { API_KEY: 'abc', HOME: '/home/user' };
    const out = sanitizeEnvForLogging(env);
    expect(out).toEqual({ API_KEY: '[set]', HOME: '/home/user' });
    expect(env).toEqual({ API_KEY: 'abc', HOME: '/home/user' });
    expect(sanitizeEnvForLogging({})).toEqual({});
  });
});

describe('isSafePath', () => {
  it('rejects absolute paths', () => {
    expect(isSafePath('/etc/passwd')).toBe(false);
    expect(isSafePath('/tmp/evil')).toBe(false);
  });

  it('rejects any ".." segment', () => {
    expect(isSafePath('../escape')).toBe(false);
    expect(isSafePath('a/../../b')).toBe(false);
    expect(isSafePath('a/../b')).toBe(false);
    expect(isSafePath('..')).toBe(false);
    expect(isSafePath('a/b/..')).toBe(false);
  });

  it('rejects the empty path', () => {
    expect(isSafePath('')).toBe(false);
  });

  it('accepts normal relative paths', () => {
    expect(isSafePath('main.py')).toBe(true);
    expect(isSafePath('src/app.py')).toBe(true);
    expect(isSafePath('data/input.csv')).toBe(true);
    expect(isSafePath('./main.py')).toBe(true);
    expect(isSafePath('a..b/c.txt')).toBe(true);
  });
});

describe('capabilityMatrix', () => {
  it('matches the honest table for this environment', () => {
    const matrix = capabilityMatrix();

    expect(matrix.docker.available).toBe(false);
    expect(matrix.docker.reason).toBe(
      'docker not available in this environment',
    );

    expect(matrix.bwrap.available).toBe(true);
    expect(matrix.bwrap.isolatesFilesystem).toBe(true);
    expect(matrix.bwrap.isolatesNetwork).toBe(true);
    expect(matrix.bwrap.isolatesProcesses).toBe(true);
    expect(matrix.bwrap.enforcesCpu).toBe(true);
    expect(matrix.bwrap.enforcesMemory).toBe(true);

    expect(matrix.process.available).toBe(true);
    expect(matrix.process.isolatesFilesystem).toBe(false);
    expect(matrix.process.isolatesNetwork).toBe(false);
    expect(matrix.process.isolatesProcesses).toBe(false);
    expect(matrix.process.enforcesCpu).toBe(true);
    expect(matrix.process.enforcesMemory).toBe(true);
  });
});
