/**
 * Cell — sandbox manager (core).
 *
 * Owns the lifecycle of every sandbox: creation (via an injected backend
 * resolver, so the manager never imports the runtime layer directly),
 * lookup, exec, file access, kill/stop, destroy, and the warm pool and idle
 * reaper.
 *
 * Lifecycle: creating -> running -> stopped -> destroyed. `destroy` is
 * terminal. `stop()` kills the sandbox's current work and marks it stopped;
 * a later `exec()` restarts a stopped sandbox back to running. An exec that
 * fails or crashes does NOT destroy the sandbox; it stays running.
 *
 * Idempotency: `create()` with an `idempotencyKey` returns the existing
 * sandbox instead of creating a second one, as long as that sandbox still
 * exists. Once it is destroyed, the same key creates a fresh sandbox.
 *
 * Warm pool: when `poolSize > 0`, the manager pre-creates that many idle
 * sandboxes (default backend, python) in the background and hands them out
 * on `create()` when the request asks for nothing beyond a backend and a
 * language (no custom limits, network, env, labels, or image). The pool
 * refills asynchronously after each checkout. Pooled sandboxes count toward
 * `maxSandboxes` and are exempt from the idle reaper.
 *
 * Idle reaper: a timer (unref'd, so it never keeps the process alive)
 * destroys sandboxes idle longer than `idleTimeoutSeconds` (0 disables it).
 * Note the reaper destroys, it does not merely stop.
 *
 * The manager takes no dependency on `src/runtime/` at compile time. The
 * backend resolver is injected through the constructor; when none is given,
 * the manager lazily tries the runtime registry via a dynamic import and
 * reports `backend_unavailable` if it is not there.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CellError } from './errors.js';
import type {
  BackendName,
  CreateSandboxOptions,
  ExecRequest,
  ExecResult,
  ExecStreamEvent,
  Language,
  Limits,
  ManagerOptions,
  NetworkMode,
  RuntimeBackend,
  SandboxEvent,
  SandboxHandle,
  SandboxInfo,
} from './types.js';

/** Resolves a backend by name. `undefined` means "the default backend". */
export type BackendResolver = (name?: BackendName) => Promise<RuntimeBackend>;

export interface CreateOptions {
  backend?: BackendName;
  language?: Language;
  /** Docker image (docker backend only). */
  image?: string;
  limits?: Limits;
  network?: NetworkMode;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  idempotencyKey?: string;
}

const MAX_EVENTS_PER_SANDBOX = 500;
const MAX_TOMBSTONES = 100;
const DEFAULT_MAX_SANDBOXES = 32;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 3600;
const POOL_LANGUAGE: Language = 'python';

type LiveStatus = 'creating' | 'running' | 'stopped';

interface SandboxRecord {
  id: string;
  handle: SandboxHandle | undefined;
  backend: BackendName;
  language: Language;
  status: LiveStatus;
  createdAt: string;
  lastUsedAt: string;
  limits: Limits;
  network: NetworkMode;
  labels: Record<string, string> | undefined;
  workdir: string;
  idempotencyKey: string | undefined;
  inPool: boolean;
  events: SandboxEvent[];
  nextSeq: number;
  listeners: Set<(event: SandboxEvent) => void>;
}

export class SandboxManager {
  private readonly options: ManagerOptions;
  private readonly resolver: BackendResolver | undefined;
  private readonly workdirRoot: string;
  private readonly maxSandboxes: number;
  private readonly poolSize: number;
  private readonly idleTimeoutSeconds: number;
  private readonly defaultLimits: Limits;
  private readonly sandboxes = new Map<string, SandboxRecord>();
  private readonly pool: string[] = [];
  private readonly idempotency = new Map<string, string>();
  private readonly inflightCreations = new Map<string, Promise<SandboxInfo>>();
  private readonly destroyedIds = new Set<string>();
  private readonly tombstones = new Map<string, SandboxEvent[]>();
  private refilling = false;
  private reaperTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: ManagerOptions = {}, resolver?: BackendResolver) {
    this.options = options;
    this.resolver = resolver;
    this.workdirRoot = options.workdirRoot ?? join(tmpdir(), 'cell-sandboxes');
    this.maxSandboxes = options.maxSandboxes ?? DEFAULT_MAX_SANDBOXES;
    this.poolSize = options.poolSize ?? 0;
    this.idleTimeoutSeconds =
      options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
    this.defaultLimits = { ...(options.defaultLimits ?? {}) };
    if (this.poolSize > 0) {
      void this.refillPool();
    }
    if (this.idleTimeoutSeconds > 0) {
      this.startReaper();
    }
  }

  // -- creation -----------------------------------------------------------

  async create(opts: CreateOptions = {}): Promise<SandboxInfo> {
    this.assertOpen();
    const key = opts.idempotencyKey;
    if (key !== undefined) {
      const existing = this.lookupIdempotent(key);
      if (existing !== undefined) return existing;
      const inflight = this.inflightCreations.get(key);
      if (inflight !== undefined) return inflight;
    }
    const promise = this.doCreate(opts);
    if (key !== undefined) {
      this.inflightCreations.set(key, promise);
      const cleanup = (): void => {
        this.inflightCreations.delete(key);
      };
      promise.then(cleanup, cleanup);
    }
    return promise;
  }

  private lookupIdempotent(key: string): SandboxInfo | undefined {
    const id = this.idempotency.get(key);
    if (id === undefined) return undefined;
    const rec = this.sandboxes.get(id);
    if (rec === undefined) {
      // The sandbox is gone (destroyed); the key may be reused.
      this.idempotency.delete(key);
      return undefined;
    }
    return this.toInfo(rec);
  }

  private async doCreate(
    opts: CreateOptions,
    inPool = false,
  ): Promise<SandboxInfo> {
    if (!inPool) {
      const pooled = this.tryPoolCheckout(opts);
      if (pooled !== undefined) {
        if (opts.idempotencyKey !== undefined) {
          this.idempotency.set(opts.idempotencyKey, pooled.id);
        }
        return this.toInfo(pooled);
      }
    }
    if (this.sandboxes.size >= this.maxSandboxes) {
      throw CellError.limitExceeded(
        `max sandboxes reached (${this.maxSandboxes})`,
      );
    }
    const id = `sb_${randomUUID()}`;
    const language = opts.language ?? POOL_LANGUAGE;
    const backendName = opts.backend ?? this.options.defaultBackend;
    const limits = { ...this.defaultLimits, ...(opts.limits ?? {}) };
    const network = opts.network ?? 'none';
    const workdir = join(this.workdirRoot, id);
    const now = new Date().toISOString();
    const record: SandboxRecord = {
      id,
      handle: undefined,
      backend: backendName ?? 'process',
      language,
      status: 'creating',
      createdAt: now,
      lastUsedAt: now,
      limits,
      network,
      labels: opts.labels !== undefined ? { ...opts.labels } : undefined,
      workdir,
      idempotencyKey: opts.idempotencyKey,
      inPool,
      events: [],
      nextSeq: 1,
      listeners: new Set(),
    };
    // Reserve the slot synchronously so concurrent creates cannot
    // overshoot maxSandboxes while the backend call is in flight.
    this.sandboxes.set(id, record);
    try {
      await mkdir(workdir, { recursive: true });
      const backend = await this.resolveBackend(backendName);
      const createOpts: CreateSandboxOptions = {
        id,
        language,
        limits,
        network,
        workdir,
        ...(opts.image !== undefined ? { image: opts.image } : {}),
        ...(opts.env !== undefined ? { env: { ...opts.env } } : {}),
        ...(opts.labels !== undefined ? { labels: { ...opts.labels } } : {}),
      };
      const handle = await backend.create(createOpts);
      record.handle = handle;
      record.backend = handle.backend;
      record.status = 'running';
    } catch (err) {
      this.sandboxes.delete(id);
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof CellError) throw err;
      throw CellError.backendUnavailable(
        `failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (inPool) {
      this.pool.push(id);
    }
    this.appendEvent(
      record,
      'created',
      `backend=${record.backend} language=${language}`,
    );
    if (opts.idempotencyKey !== undefined) {
      this.idempotency.set(opts.idempotencyKey, id);
    }
    return this.toInfo(record);
  }

  // -- lookup -------------------------------------------------------------

  get(id: string): SandboxInfo {
    return this.toInfo(this.requireLive(id));
  }

  /** All sandboxes that have not been destroyed (pooled ones included). */
  list(): SandboxInfo[] {
    return [...this.sandboxes.values()].map((rec) => this.toInfo(rec));
  }

  // -- exec and files ------------------------------------------------------

  async exec(
    id: string,
    req: ExecRequest,
    onEvent?: (e: ExecStreamEvent) => void,
  ): Promise<ExecResult> {
    this.assertOpen();
    const rec = this.requireLive(id);
    const handle = this.requireHandle(rec);
    const hasCode = req.code !== undefined;
    const hasFile = req.file !== undefined;
    if (hasCode === hasFile) {
      throw CellError.invalidRequest('exactly one of code or file must be set');
    }
    if (rec.status === 'stopped') {
      // A stopped sandbox restarts on exec.
      rec.status = 'running';
      this.appendEvent(rec, 'started', 'sandbox restarted by exec');
    }
    const effective: ExecRequest = {
      ...req,
      timeoutMs: req.timeoutMs ?? rec.limits.timeoutMs,
    };
    rec.lastUsedAt = new Date().toISOString();
    this.appendEvent(rec, 'exec_started', `language=${req.language}`);
    try {
      const result = await handle.exec(effective, onEvent);
      rec.lastUsedAt = new Date().toISOString();
      this.appendEvent(
        rec,
        'exec_finished',
        `exitCode=${result.exitCode} durationMs=${result.durationMs}`,
      );
      return result;
    } catch (err) {
      // A failed or crashing exec does NOT destroy the sandbox; it stays
      // running unless explicitly killed or destroyed.
      rec.lastUsedAt = new Date().toISOString();
      this.appendEvent(
        rec,
        'exec_finished',
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (err instanceof CellError) throw err;
      throw CellError.backendUnavailable(
        `exec failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    this.assertOpen();
    const rec = this.requireLive(id);
    const handle = this.requireHandle(rec);
    await handle.writeFile(path, content);
    rec.lastUsedAt = new Date().toISOString();
  }

  async readFile(id: string, path: string): Promise<string> {
    this.assertOpen();
    const rec = this.requireLive(id);
    const handle = this.requireHandle(rec);
    const content = await handle.readFile(path);
    rec.lastUsedAt = new Date().toISOString();
    return content;
  }

  // -- kill / stop / destroy ------------------------------------------------

  /** Kills the sandbox's current work. The sandbox itself stays running. */
  async kill(id: string): Promise<SandboxInfo> {
    this.assertOpen();
    const rec = this.requireLive(id);
    const handle = this.requireHandle(rec);
    await handle.kill();
    rec.lastUsedAt = new Date().toISOString();
    this.appendEvent(rec, 'killed');
    return this.toInfo(rec);
  }

  /**
   * Kills the sandbox's current work and marks it stopped. A later exec()
   * restarts it. Stopping an already-stopped sandbox is a no-op.
   */
  async stop(id: string): Promise<SandboxInfo> {
    this.assertOpen();
    const rec = this.requireLive(id);
    if (rec.status === 'stopped') return this.toInfo(rec);
    const handle = this.requireHandle(rec);
    await handle.kill().catch(() => {});
    rec.status = 'stopped';
    rec.lastUsedAt = new Date().toISOString();
    this.appendEvent(rec, 'stopped');
    return this.toInfo(rec);
  }

  /** Terminal: destroys the backend sandbox, removes its workdir. */
  async destroy(id: string): Promise<void> {
    this.assertOpen();
    const rec = this.sandboxes.get(id);
    if (rec === undefined) {
      if (this.destroyedIds.has(id)) {
        throw CellError.sandboxDestroyed(`sandbox ${id} has been destroyed`);
      }
      throw CellError.notFound(`sandbox ${id} not found`);
    }
    await this.destroyInternal(rec);
  }

  private async destroyInternal(rec: SandboxRecord): Promise<void> {
    if (rec.handle !== undefined) {
      await rec.handle.destroy().catch(() => {});
    }
    this.appendEvent(rec, 'destroyed');
    this.tombstones.set(rec.id, rec.events);
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
    this.sandboxes.delete(rec.id);
    const poolIndex = this.pool.indexOf(rec.id);
    if (poolIndex !== -1) this.pool.splice(poolIndex, 1);
    if (rec.idempotencyKey !== undefined) {
      const mapped = this.idempotency.get(rec.idempotencyKey);
      if (mapped === rec.id) this.idempotency.delete(rec.idempotencyKey);
    }
    this.destroyedIds.add(rec.id);
    await rm(rec.workdir, { recursive: true, force: true }).catch(() => {});
  }

  // -- warm pool ------------------------------------------------------------

  /** Number of idle sandboxes currently sitting in the warm pool. */
  poolCount(): number {
    return this.pool.length;
  }

  /**
   * Resolves once the warm pool is full (or immediately when pooling is
   * disabled). Rejects when the pool cannot fill within `timeoutMs`.
   */
  async waitForPool(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pool.length < this.poolSize) {
      if (Date.now() > deadline) {
        throw CellError.backendUnavailable(
          `timed out waiting for warm pool (${this.pool.length}/${this.poolSize} ready)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private tryPoolCheckout(opts: CreateOptions): SandboxRecord | undefined {
    if (this.poolSize <= 0 || this.pool.length === 0) return undefined;
    // A pooled sandbox was built with defaults; only hand it out when the
    // request asks for nothing beyond a backend and a language.
    if (
      opts.limits !== undefined ||
      opts.network !== undefined ||
      opts.env !== undefined ||
      opts.labels !== undefined ||
      opts.image !== undefined
    ) {
      return undefined;
    }
    const requestedBackend = opts.backend ?? this.options.defaultBackend;
    const requestedLanguage = opts.language ?? POOL_LANGUAGE;
    const index = this.pool.findIndex((id) => {
      const rec = this.sandboxes.get(id);
      if (rec === undefined) return false;
      if (rec.language !== requestedLanguage) return false;
      // An unspecified backend means "the default", which is what the pool
      // was built from, so it matches any pooled backend.
      if (requestedBackend !== undefined && rec.backend !== requestedBackend) {
        return false;
      }
      return true;
    });
    if (index === -1) return undefined;
    const [id] = this.pool.splice(index, 1);
    if (id === undefined) return undefined;
    const rec = this.sandboxes.get(id);
    if (rec === undefined) return undefined;
    rec.inPool = false;
    rec.lastUsedAt = new Date().toISOString();
    this.appendEvent(
      rec,
      'pool_checkout',
      `backend=${rec.backend} language=${rec.language}`,
    );
    void this.refillPool();
    return rec;
  }

  private async refillPool(): Promise<void> {
    if (this.closed || this.poolSize <= 0 || this.refilling) return;
    this.refilling = true;
    try {
      while (!this.closed && this.pool.length < this.poolSize) {
        if (this.sandboxes.size >= this.maxSandboxes) return;
        try {
          await this.doCreate(
            { backend: this.options.defaultBackend, language: POOL_LANGUAGE },
            true,
          );
        } catch {
          // Backend unavailable (or workdir failure): stop refilling for
          // now. The next checkout or create retries.
          return;
        }
      }
    } finally {
      this.refilling = false;
    }
  }

  // -- events ---------------------------------------------------------------

  /** Append-only event log for a sandbox (also available after destroy). */
  getEvents(id: string): SandboxEvent[] {
    const rec = this.sandboxes.get(id);
    if (rec !== undefined) return rec.events.map((e) => ({ ...e }));
    const tombstone = this.tombstones.get(id);
    if (tombstone !== undefined) return tombstone.map((e) => ({ ...e }));
    throw CellError.notFound(`sandbox ${id} not found`);
  }

  /**
   * Subscribe to a sandbox's events. Returns an unsubscribe function.
   * Throws `sandbox_destroyed` for a destroyed sandbox (no future events
   * can occur) and `not_found` for an unknown id.
   */
  onEvent(id: string, listener: (event: SandboxEvent) => void): () => void {
    const rec = this.sandboxes.get(id);
    if (rec === undefined) {
      if (this.destroyedIds.has(id)) {
        throw CellError.sandboxDestroyed(`sandbox ${id} has been destroyed`);
      }
      throw CellError.notFound(`sandbox ${id} not found`);
    }
    rec.listeners.add(listener);
    return () => {
      rec.listeners.delete(listener);
    };
  }

  private appendEvent(
    rec: SandboxRecord,
    type: string,
    detail?: string,
  ): SandboxEvent {
    const event: SandboxEvent = {
      seq: rec.nextSeq,
      at: new Date().toISOString(),
      type,
      ...(detail !== undefined ? { detail } : {}),
    };
    rec.nextSeq += 1;
    rec.events.push(event);
    while (rec.events.length > MAX_EVENTS_PER_SANDBOX) {
      rec.events.shift();
    }
    for (const listener of [...rec.listeners]) {
      try {
        listener({ ...event });
      } catch {
        // A failing listener must not break the manager or other listeners.
      }
    }
    return event;
  }

  // -- idle reaper ----------------------------------------------------------

  /**
   * Destroys sandboxes idle longer than `idleTimeoutSeconds` (pooled
   * sandboxes are exempt). Returns how many were destroyed. Also run
   * periodically by the internal timer; 0 timeout disables it entirely.
   */
  async reapIdle(): Promise<number> {
    if (this.closed || this.idleTimeoutSeconds <= 0) return 0;
    const now = Date.now();
    const cutoffMs = this.idleTimeoutSeconds * 1000;
    let destroyed = 0;
    for (const rec of [...this.sandboxes.values()]) {
      if (rec.inPool) continue;
      if (now - Date.parse(rec.lastUsedAt) > cutoffMs) {
        await this.destroyInternal(rec);
        destroyed += 1;
      }
    }
    return destroyed;
  }

  private startReaper(): void {
    const intervalMs = Math.max(
      100,
      Math.min(this.idleTimeoutSeconds, 60) * 1000,
    );
    const timer = setInterval(() => {
      void this.reapIdle().catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.reaperTimer = timer;
  }

  // -- shutdown ---------------------------------------------------------------

  /** Stops the reaper timer and destroys every sandbox (pool included). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reaperTimer !== undefined) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
    for (const rec of [...this.sandboxes.values()]) {
      await this.destroyInternal(rec);
    }
  }

  /** Alias for close(). */
  async shutdown(): Promise<void> {
    await this.close();
  }

  // -- internals ------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw CellError.invalidRequest('SandboxManager is closed');
    }
  }

  private requireLive(id: string): SandboxRecord {
    const rec = this.sandboxes.get(id);
    if (rec !== undefined) return rec;
    if (this.destroyedIds.has(id)) {
      throw CellError.sandboxDestroyed(`sandbox ${id} has been destroyed`);
    }
    throw CellError.notFound(`sandbox ${id} not found`);
  }

  private requireHandle(rec: SandboxRecord): SandboxHandle {
    if (rec.handle === undefined || rec.status === 'creating') {
      throw CellError.invalidRequest(
        `sandbox ${rec.id} is still being created`,
      );
    }
    return rec.handle;
  }

  private async resolveBackend(name?: BackendName): Promise<RuntimeBackend> {
    if (this.resolver !== undefined) {
      return this.resolver(name);
    }
    // No resolver injected: lazily try the runtime registry. The specifier
    // is a variable on purpose, so this module still compiles before the
    // registry exists.
    const specifier = '../runtime/index.js';
    let mod: unknown;
    try {
      mod = await import(specifier);
    } catch {
      throw CellError.backendUnavailable(
        'no backend resolver configured and the runtime registry is unavailable',
      );
    }
    const candidate = mod as {
      selectBackend?: unknown;
      defaultResolver?: unknown;
    };
    const fn = candidate.selectBackend ?? candidate.defaultResolver;
    if (typeof fn !== 'function') {
      throw CellError.backendUnavailable(
        'runtime registry does not export a backend resolver',
      );
    }
    return (fn as BackendResolver)(name);
  }

  private toInfo(rec: SandboxRecord): SandboxInfo {
    return {
      id: rec.id,
      backend: rec.backend,
      language: rec.language,
      status: rec.status,
      createdAt: rec.createdAt,
      lastUsedAt: rec.lastUsedAt,
      limits: { ...rec.limits },
      network: rec.network,
      ...(rec.labels !== undefined ? { labels: { ...rec.labels } } : {}),
    };
  }
}
