/**
 * Error type for runtime backend failures.
 *
 * `code` is a stable, machine-readable string (for example
 * 'backend_unavailable', 'network_unavailable', 'path_escape',
 * 'spawn_failed', 'invalid_exec_request', 'file_not_found',
 * 'sandbox_destroyed', 'no_backend_available'). Callers should branch on
 * `code`, not on the human-readable message.
 */
export class BackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
  }
}
