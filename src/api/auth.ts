import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, jsonError } from './errors.js';

export interface AuthOptions {
  /** Bearer token clients must present. Falls back to CELL_API_TOKEN. */
  token?: string;
  /** When true, no Authorization header is required. */
  noAuth?: boolean;
}

/** Resolve the expected token: explicit option first, then the environment. */
export function resolveToken(opts: AuthOptions): string | undefined {
  return opts.token ?? process.env.CELL_API_TOKEN ?? undefined;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * True when the request is allowed through: noAuth is set, or the
 * `Authorization: Bearer <token>` header matches the configured token.
 * When no token is configured at all, nothing can match, so auth fails.
 */
export function isAuthorized(req: IncomingMessage, opts: AuthOptions): boolean {
  if (opts.noAuth) {
    return true;
  }
  const token = resolveToken(opts);
  if (!token) {
    return false;
  }
  const header = req.headers.authorization;
  if (!header) {
    return false;
  }
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value !== undefined && safeEqual(value, token);
}

/**
 * Enforce auth on a request. Returns true when authorized; otherwise
 * writes a 401 JSON error to `res` and returns false.
 */
export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AuthOptions,
): boolean {
  if (isAuthorized(req, opts)) {
    return true;
  }
  jsonError(
    res,
    new ApiError('unauthorized', 'Missing or invalid Authorization header'),
  );
  return false;
}
