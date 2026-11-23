import type { ServerResponse } from 'node:http';

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'gone'
  | 'limit_exceeded'
  | 'backend_unavailable'
  | 'payload_too_large'
  | 'internal';

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  gone: 410,
  limit_exceeded: 429,
  backend_unavailable: 503,
  payload_too_large: 413,
  internal: 500,
};

/** An error that maps directly onto an HTTP error response. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? API_ERROR_STATUS[code];
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError('bad_request', message);
}

export function unauthorized(
  message = 'Missing or invalid credentials',
): ApiError {
  return new ApiError('unauthorized', message);
}

export function notFound(message: string): ApiError {
  return new ApiError('not_found', message);
}

export function limitExceeded(message: string): ApiError {
  return new ApiError('limit_exceeded', message);
}

export function backendUnavailable(message: string): ApiError {
  return new ApiError('backend_unavailable', message);
}

export function payloadTooLarge(message: string): ApiError {
  return new ApiError('payload_too_large', message);
}

/**
 * Manager/backend error codes that have no direct API code are translated
 * here: `invalid_request` is a 400, `sandbox_destroyed` is a 410.
 */
const MANAGER_CODE_MAP: Record<string, ApiErrorCode> = {
  invalid_request: 'bad_request',
  sandbox_destroyed: 'gone',
};

/**
 * Convert any thrown value into an ApiError. ApiErrors pass through
 * unchanged; errors from the manager/backends that already carry a known
 * `code` are honoured; a "not found" message becomes a 404; everything
 * else is a 500. The original message is preserved so callers can see
 * what actually failed.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) {
    return err;
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      const mapped = MANAGER_CODE_MAP[code];
      if (mapped !== undefined) {
        return new ApiError(mapped, err.message);
      }
      if (code in API_ERROR_STATUS) {
        return new ApiError(code as ApiErrorCode, err.message);
      }
    }
    if (/not found/i.test(err.message)) {
      return new ApiError('not_found', err.message);
    }
    return new ApiError('internal', err.message || 'Internal server error');
  }
  return new ApiError('internal', 'Internal server error');
}

/** Write `{error: {code, message}}` with the error's HTTP status. */
export function jsonError(res: ServerResponse, err: unknown): void {
  const apiErr = toApiError(err);
  try {
    if (!res.headersSent) {
      res.writeHead(apiErr.status, { 'content-type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(
        JSON.stringify({
          error: { code: apiErr.code, message: apiErr.message },
        }),
      );
    }
  } catch {
    // The client is already gone; nothing left to report to.
  }
}
