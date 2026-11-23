/**
 * Cell — security model public surface.
 *
 * Re-exports the capability table, secret redaction, env sanitisation,
 * and path validation from `./model.js`, plus the capability types from
 * the shared core contract.
 */

export {
  capabilityMatrix,
  isSafePath,
  redactSecrets,
  sanitizeEnvForLogging,
  ENV_SET,
  MIN_SECRET_LENGTH,
  REDACTED,
} from './model.js';
export type { BackendCapabilities, BackendName } from '../core/types.js';
