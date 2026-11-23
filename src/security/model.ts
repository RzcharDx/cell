/**
 * Cell — security model.
 *
 * The honest capability table, secret redaction, log sanitisation, and
 * path validation for the service. Nothing here trusts the guest: every
 * value is either a static statement about this environment (see
 * docs/runtime.md) or a pure function over untrusted input.
 *
 * Secrets rule: env values and secrets must never appear in logs, event
 * logs, error messages, or API responses. `redactSecrets` and
 * `sanitizeEnvForLogging` are the two choke points for that rule — call
 * them before anything leaves the process.
 */

import type { BackendCapabilities, BackendName } from '../core/types.js';

/** Placeholder used wherever a secret value is removed. */
export const REDACTED = '[redacted]';

/** Placeholder used for a sensitive env value in logs. */
export const ENV_SET = '[set]';

/**
 * Secrets shorter than this are never redacted: a short string (for
 * example "key" or "ab") appears in ordinary text far too often, and
 * blanking every occurrence would destroy the log it was meant to
 * protect. Short secrets must be rotated, not logged around.
 */
export const MIN_SECRET_LENGTH = 8;

/** Env keys whose values are sensitive, matched case-insensitively. */
const SENSITIVE_ENV_KEY = /token|secret|password|key|auth/i;

/**
 * The honest capability table for this environment.
 *
 * - bwrap: real filesystem, process, and (via the `unshare --net`
 *   wrapper) network isolation; CPU/memory enforced via rlimits.
 * - process: a child process with rlimits and a cwd jail. It is NOT a
 *   security boundary — the guest can read the host filesystem subject
 *   to OS permissions.
 * - docker: real container isolation when present, but Docker is not
 *   installed in this environment, so it is reported unavailable.
 *
 * This table is static for this environment. The docker backend's own
 * `probe()` is the live availability check; this table is the security
 * model's statement of what each backend may be trusted to do.
 */
export function capabilityMatrix(): Record<BackendName, BackendCapabilities> {
  return {
    bwrap: {
      name: 'bwrap',
      available: true,
      isolatesFilesystem: true,
      isolatesNetwork: true,
      isolatesProcesses: true,
      enforcesCpu: true,
      enforcesMemory: true,
    },
    process: {
      name: 'process',
      available: true,
      isolatesFilesystem: false,
      isolatesNetwork: false,
      isolatesProcesses: false,
      enforcesCpu: true,
      enforcesMemory: true,
    },
    docker: {
      name: 'docker',
      available: false,
      reason: 'docker not available in this environment',
      isolatesFilesystem: true,
      isolatesNetwork: true,
      isolatesProcesses: true,
      enforcesCpu: true,
      enforcesMemory: true,
    },
  };
}

/**
 * Replace every occurrence of each secret in `text` with '[redacted]'.
 *
 * - Secrets shorter than {@link MIN_SECRET_LENGTH} characters (and empty
 *   strings) are skipped: redacting them would mangle ordinary text.
 * - Longer secrets are replaced first, so when one secret contains
 *   another the result is a single '[redacted]' instead of a partially
 *   redacted leak.
 * - Matching is literal, never a regular expression, so secrets
 *   containing regex metacharacters are handled safely.
 * - An empty secrets list returns the text unchanged.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  const usable = [
    ...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH)),
  ].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of usable) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Produce a log-safe copy of an env map: key names are kept, values of
 * keys matching /token|secret|password|key|auth/i (case-insensitive)
 * are replaced with '[set]', and all other values pass through
 * unchanged. The input object is not mutated.
 *
 * Call this before writing env anywhere — event logs, error messages,
 * API responses. Key names alone are not secret; values are.
 */
export function sanitizeEnvForLogging(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SENSITIVE_ENV_KEY.test(key) ? ENV_SET : value;
  }
  return out;
}

/**
 * Whether a guest-supplied relative path is safe to resolve inside the
 * sandbox workdir. Rejects absolute paths and any '..' segment, so a
 * file write or read cannot escape the workdir. Accepts ordinary
 * relative paths such as 'main.py' or 'src/app.py'.
 */
export function isSafePath(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  if (path.startsWith('/')) {
    return false;
  }
  const segments = path.split('/');
  return !segments.some((segment) => segment === '..');
}
