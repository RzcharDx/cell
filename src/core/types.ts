/**
 * Cell — shared core types.
 *
 * Every module depends on these definitions. Keep this file free of
 * implementation and free of imports from other Cell modules.
 */

export type Language = 'python' | 'node' | 'shell';

/** Network mode for a sandbox. Default is 'none' (no network access). */
export type NetworkMode = 'none' | 'allow';

export type BackendName = 'bwrap' | 'process' | 'docker';

export type SandboxStatus = 'creating' | 'running' | 'stopped' | 'destroyed';

/** Resource limits enforced per sandbox. All fields optional; unset means no limit. */
export interface Limits {
  /** CPU seconds (RLIMIT_CPU). */
  cpuSeconds?: number;
  /** Address-space cap in MiB (RLIMIT_AS). */
  memoryMB?: number;
  /** Wall-clock timeout for a single exec, in ms. */
  timeoutMs?: number;
  /** Max bytes captured across stdout+stderr per exec. */
  maxOutputBytes?: number;
  /** Max size of a single file the guest may create, in MiB (RLIMIT_FSIZE). */
  maxFileSizeMB?: number;
}

export interface ExecRequest {
  /** Code to run. Exactly one of `code` or `file` must be set. */
  code?: string;
  /** Path of a file already inside the sandbox workdir to execute. */
  file?: string;
  language: Language;
  stdin?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Overrides the sandbox default timeout for this exec, in ms. */
  timeoutMs?: number;
  network?: NetworkMode;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
  /** True when output was cut at maxOutputBytes. */
  truncated: boolean;
}

/** Public view of a sandbox (safe to return from the API). */
export interface SandboxInfo {
  id: string;
  backend: BackendName;
  language: Language;
  status: SandboxStatus;
  createdAt: string;
  lastUsedAt: string;
  limits: Limits;
  network: NetworkMode;
  labels?: Record<string, string>;
}

export interface BackendCapabilities {
  name: BackendName;
  available: boolean;
  /** Why the backend is unavailable, when it is not. */
  reason?: string;
  isolatesFilesystem: boolean;
  isolatesNetwork: boolean;
  isolatesProcesses: boolean;
  enforcesCpu: boolean;
  enforcesMemory: boolean;
}

export type ExecStreamEventType = 'stdout' | 'stderr' | 'exit' | 'error';

export interface ExecStreamEvent {
  type: ExecStreamEventType;
  data?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  message?: string;
}

export interface CreateSandboxOptions {
  id: string;
  language: Language;
  /** Docker image (docker backend only). */
  image?: string;
  limits: Limits;
  network: NetworkMode;
  /** Host-side directory that becomes the sandbox workdir. */
  workdir: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface SandboxHandle {
  readonly id: string;
  readonly backend: BackendName;
  exec(
    req: ExecRequest,
    onEvent?: (e: ExecStreamEvent) => void,
  ): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  kill(): Promise<void>;
  destroy(): Promise<void>;
}

/** A backend can create sandboxes and reports what it can do. */
export interface RuntimeBackend {
  readonly name: BackendName;
  probe(): Promise<BackendCapabilities>;
  create(opts: CreateSandboxOptions): Promise<SandboxHandle>;
}

export interface SandboxEvent {
  seq: number;
  at: string;
  type: string;
  detail?: string;
}

export interface ManagerOptions {
  defaultBackend?: BackendName;
  maxSandboxes?: number;
  poolSize?: number;
  defaultLimits?: Limits;
  /** Host root under which sandbox workdirs are created. */
  workdirRoot?: string;
  /** Idle seconds after which an unused sandbox is destroyed. */
  idleTimeoutSeconds?: number;
}
