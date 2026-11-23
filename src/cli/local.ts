import type {
  BackendCapabilities,
  BackendName,
  ExecRequest,
  ExecResult,
  ExecStreamEvent,
  Language,
  NetworkMode,
  SandboxEvent,
  SandboxInfo,
} from '../core/types.js';

export interface LocalRunOptions {
  code: string;
  lang: Language;
  timeoutMs?: number;
  memoryMB?: number;
  network?: NetworkMode;
  backend?: BackendName;
  env?: Record<string, string>;
  stdin?: string;
}

/** A sandbox handle as produced by the local manager, normalized. */
export interface LocalSandboxHandle {
  id: string;
  exec(req: ExecRequest): Promise<ExecResult>;
  destroy(): Promise<void>;
}

export interface LocalManager {
  createSandbox(opts: {
    language: Language;
    backend?: BackendName;
    network?: NetworkMode;
    limits?: { timeoutMs?: number; memoryMB?: number };
    env?: Record<string, string>;
  }): Promise<LocalSandboxHandle>;
}

/**
 * The slice of the manager the HTTP server needs (mirrors the server's
 * ManagerPort). The real SandboxManager exposes everything here except
 * `backends()`, which this adapter fills in from the runtime registry.
 */
export interface ManagerPortLike {
  create(input: unknown): Promise<SandboxInfo>;
  get(id: string): Promise<SandboxInfo>;
  list(): SandboxInfo[] | Promise<SandboxInfo[]>;
  destroy(id: string): Promise<void>;
  exec(
    id: string,
    req: ExecRequest,
    onEvent?: (e: ExecStreamEvent) => void,
  ): Promise<ExecResult>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  getEvents(id: string): SandboxEvent[];
  onEvent(id: string, listener: (e: SandboxEvent) => void): () => void;
  backends(): Promise<BackendCapabilities[]>;
}

/** The manager's own method shapes (get/list are synchronous on it). */
interface RawManagerShape {
  create: (opts: unknown) => Promise<SandboxInfo>;
  get: (id: string) => SandboxInfo;
  list: () => SandboxInfo[];
  destroy: (id: string) => Promise<void>;
  exec: (
    id: string,
    req: ExecRequest,
    onEvent?: (e: ExecStreamEvent) => void,
  ) => Promise<ExecResult>;
  writeFile: (id: string, path: string, content: string) => Promise<void>;
  getEvents: (id: string) => SandboxEvent[];
  onEvent: (id: string, listener: (e: SandboxEvent) => void) => () => void;
  getSandbox?: (id: string) => Promise<unknown> | unknown;
}

const MANAGER_LOAD_ERROR =
  'local execution is unavailable: the Cell manager/runtime modules ' +
  'could not be loaded (they may not be built yet). Run `cell up` against ' +
  'a running server, or build the runtime first.';

/**
 * Dynamically load the Cell manager (src/core/manager.ts, built as
 * dist/core/manager.js) and return the raw instance. The manager is
 * built by a sibling module, so this probes the shapes it may export —
 * a `createManager` factory, a `SandboxManager`/`Manager` class, a
 * default export, or a ready-made instance — instead of assuming one.
 * The real SandboxManager takes (options, backendResolver), so a
 * resolver built from the runtime registry is injected when available.
 * Throws a clear error when the module cannot be loaded at all.
 */
export async function loadRawManager(): Promise<RawManagerShape> {
  let mod: Record<string, unknown>;
  try {
    // Specifier kept in a variable so TypeScript does not try to resolve
    // the not-yet-built manager module at compile time.
    const managerSpecifier = '../core/manager.js';
    mod = (await import(managerSpecifier)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${MANAGER_LOAD_ERROR} (${errorMessage(err)})`);
  }

  const instance = instantiateManager(mod, await loadBackendResolver());
  if (!instance || typeof instance.create !== 'function') {
    throw new Error(
      'local execution is unavailable: the loaded manager module does ' +
        'not expose a usable create() — expected createManager(), a ' +
        'SandboxManager/Manager class, or a manager instance.',
    );
  }
  return instance as unknown as RawManagerShape;
}

/** The raw manager wrapped for one-shot local exec (`cell run`). */
export async function loadLocalManager(): Promise<LocalManager> {
  const manager = await loadRawManager();
  return {
    async createSandbox(opts) {
      const created = (await manager.create({
        language: opts.language,
        backend: opts.backend,
        network: opts.network,
        limits: opts.limits,
        env: opts.env,
      })) as unknown as Record<string, unknown> | null;
      if (!created || typeof created !== 'object') {
        throw new Error('manager.create() returned no sandbox');
      }
      const id = created.id;
      if (typeof id !== 'string' || !id) {
        throw new Error('manager.create() returned a sandbox without an id');
      }
      if (typeof created.exec === 'function') {
        const handle = created as unknown as LocalSandboxHandle;
        return {
          id,
          exec: (req) => handle.exec(req),
          destroy: async () => {
            if (typeof handle.destroy === 'function') await handle.destroy();
            else await manager.destroy(id);
          },
        };
      }
      return {
        id,
        exec: (req) => manager.exec(id, req),
        destroy: async () => {
          await manager.destroy(id);
        },
      };
    },
  };
}

/**
 * The raw manager adapted to the shape the API server expects
 * (ManagerPort). Delegates everything to the manager except
 * `backends()`, which comes from the runtime registry's `probeAll()`.
 */
export async function loadManagerPort(): Promise<ManagerPortLike> {
  const manager = await loadRawManager();
  const probeBackends = await loadProbeBackends();
  return {
    create: (input) => manager.create(input),
    get: async (id) => manager.get(id),
    list: () => manager.list(),
    destroy: (id) => manager.destroy(id),
    exec: (id, req, onEvent) => manager.exec(id, req, onEvent),
    writeFile: (id, path, content) => manager.writeFile(id, path, content),
    getEvents: (id) => manager.getEvents(id),
    onEvent: (id, listener) => manager.onEvent(id, listener),
    backends: () => probeBackends(),
  };
}

/**
 * Dynamically import the runtime registry (src/runtime/index.ts).
 * The specifier is kept in a variable so TypeScript does not try to
 * resolve the module at compile time.
 */
async function importRuntime(): Promise<Record<string, unknown>> {
  const runtimeSpecifier = '../runtime/index.js';
  return (await import(runtimeSpecifier)) as Record<string, unknown>;
}

/**
 * Build a backend resolver from the runtime registry
 * (src/runtime/index.ts, `selectBackend`). Returns undefined when the
 * runtime module cannot be loaded, in which case the manager falls back
 * to its own (registry) lookup and reports a clear error if that fails.
 */
async function loadBackendResolver(): Promise<
  ((name?: BackendName) => Promise<unknown>) | undefined
> {
  try {
    const runtime = await importRuntime();
    const select = runtime.selectBackend;
    if (typeof select === 'function') {
      return (name?: BackendName) =>
        (select as (name?: BackendName) => Promise<unknown>)(name);
    }
    const get = runtime.getBackend;
    if (typeof get === 'function') {
      return async (name?: BackendName) =>
        (get as (name: BackendName) => unknown)(name ?? 'process');
    }
  } catch {
    // No runtime available; the manager will report this itself.
  }
  return undefined;
}

/**
 * Backend capabilities from the runtime registry's `probeAll()`. When
 * the registry cannot be loaded, every known backend is reported
 * unavailable so `/health` still answers instead of failing.
 */
async function loadProbeBackends(): Promise<
  () => Promise<BackendCapabilities[]>
> {
  try {
    const runtime = await importRuntime();
    const probeAll = runtime.probeAll;
    if (typeof probeAll === 'function') {
      return () => (probeAll as () => Promise<BackendCapabilities[]>)();
    }
  } catch {
    // Fall through to the unavailable report below.
  }
  return async () =>
    (['bwrap', 'process', 'docker'] as BackendName[]).map((name) => ({
      name,
      available: false,
      reason: 'runtime registry is unavailable',
      isolatesFilesystem: false,
      isolatesNetwork: false,
      isolatesProcesses: false,
      enforcesCpu: false,
      enforcesMemory: false,
    }));
}

function instantiateManager(
  mod: Record<string, unknown>,
  resolver: ((name?: BackendName) => Promise<unknown>) | undefined,
): Record<string, unknown> | null {
  const candidates: unknown[] = [
    mod.createManager,
    mod.SandboxManager,
    mod.Manager,
    mod.default,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      try {
        // Factories are plain functions; classes throw when called
        // without `new`, so try a call first, then construction.
        // The real SandboxManager takes (options, backendResolver).
        const called = (
          candidate as (opts: unknown, resolver: unknown) => unknown
        )({}, resolver);
        if (called && typeof called === 'object') {
          return called as Record<string, unknown>;
        }
      } catch {
        // Fall through to `new`.
      }
      try {
        const built = new (
          candidate as new (opts: unknown, resolver: unknown) => unknown
        )({}, resolver);
        if (built && typeof built === 'object') {
          return built as Record<string, unknown>;
        }
      } catch {
        // Try the next candidate.
      }
    }
    if (candidate && typeof candidate === 'object') {
      return candidate as Record<string, unknown>;
    }
  }
  if (typeof mod.create === 'function') return mod;
  return null;
}

/**
 * One-shot local exec: create a sandbox, run the code, destroy the
 * sandbox, and return the result. The sandbox is destroyed even when
 * the exec throws.
 */
export async function runLocalExec(opts: LocalRunOptions): Promise<ExecResult> {
  const manager = await loadLocalManager();
  const handle = await manager.createSandbox({
    language: opts.lang,
    backend: opts.backend,
    network: opts.network,
    limits: {
      timeoutMs: opts.timeoutMs,
      memoryMB: opts.memoryMB,
    },
    env: opts.env,
  });
  try {
    const req: ExecRequest = {
      code: opts.code,
      language: opts.lang,
      stdin: opts.stdin,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      network: opts.network,
    };
    return await handle.exec(req);
  } finally {
    try {
      await handle.destroy();
    } catch {
      // Best effort: the exec result matters more than cleanup here.
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
