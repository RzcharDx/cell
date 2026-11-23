/**
 * Backend registry: probe all backends and pick one.
 *
 * Default preference is bwrap → process. Docker is never selected by
 * default — only when explicitly requested (and available) — because it
 * depends on an external daemon that may not exist.
 */
import type {
  BackendCapabilities,
  BackendName,
  RuntimeBackend,
} from '../core/types.js';
import { BackendError } from './errors.js';
import { BwrapBackend } from './backends/bwrap.js';
import { DockerBackend } from './backends/docker.js';
import { ProcessBackend } from './backends/process.js';

export { BwrapBackend } from './backends/bwrap.js';
export { DockerBackend } from './backends/docker.js';
export { ProcessBackend } from './backends/process.js';
export { BackendError } from './errors.js';

const BACKENDS: Record<BackendName, RuntimeBackend> = {
  bwrap: new BwrapBackend(),
  process: new ProcessBackend(),
  docker: new DockerBackend(),
};

const PREFERENCE_ORDER: BackendName[] = ['bwrap', 'process'];

export function getBackend(name: BackendName): RuntimeBackend {
  return BACKENDS[name];
}

/** Probe every backend. A probe that throws is reported as unavailable. */
export async function probeAll(): Promise<BackendCapabilities[]> {
  const names = Object.keys(BACKENDS) as BackendName[];
  return Promise.all(
    names.map(async (name) => {
      try {
        return await BACKENDS[name].probe();
      } catch (err) {
        return {
          name,
          available: false,
          reason: err instanceof Error ? err.message : String(err),
          isolatesFilesystem: false,
          isolatesNetwork: false,
          isolatesProcesses: false,
          enforcesCpu: false,
          enforcesMemory: false,
        } satisfies BackendCapabilities;
      }
    }),
  );
}

/**
 * Select a backend. An explicit name wins (and fails loudly when that
 * backend is unavailable); otherwise the first available backend in
 * preference order (bwrap → process) is returned.
 */
export async function selectBackend(
  name?: BackendName,
): Promise<RuntimeBackend> {
  if (name !== undefined) {
    const backend = BACKENDS[name];
    const caps = await backend.probe();
    if (!caps.available) {
      throw new BackendError(
        'backend_unavailable',
        `backend '${name}' is not available: ${caps.reason ?? 'unknown reason'}`,
      );
    }
    return backend;
  }
  for (const candidate of PREFERENCE_ORDER) {
    const caps = await BACKENDS[candidate].probe();
    if (caps.available) return BACKENDS[candidate];
  }
  throw new BackendError(
    'no_backend_available',
    'no runtime backend is available on this host',
  );
}
