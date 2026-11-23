/**
 * Cell — typed errors.
 *
 * Every error the manager (and, by convention, the rest of Cell) throws for
 * an expected failure mode is a CellError carrying a stable machine-readable
 * `code` and an HTTP-style `status`.
 */

export type CellErrorCode =
  | 'not_found'
  | 'limit_exceeded'
  | 'backend_unavailable'
  | 'invalid_request'
  | 'sandbox_destroyed';

const STATUS_BY_CODE: Record<CellErrorCode, number> = {
  not_found: 404,
  limit_exceeded: 429,
  backend_unavailable: 503,
  invalid_request: 400,
  sandbox_destroyed: 410,
};

export class CellError extends Error {
  readonly code: CellErrorCode;
  readonly status: number;

  constructor(code: CellErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'CellError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
  }

  static notFound(message: string): CellError {
    return new CellError('not_found', message);
  }

  static limitExceeded(message: string): CellError {
    return new CellError('limit_exceeded', message);
  }

  static backendUnavailable(message: string): CellError {
    return new CellError('backend_unavailable', message);
  }

  static invalidRequest(message: string): CellError {
    return new CellError('invalid_request', message);
  }

  static sandboxDestroyed(message: string): CellError {
    return new CellError('sandbox_destroyed', message);
  }
}
