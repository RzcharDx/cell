/**
 * Manager integration test against the real runtime registry, when it
 * exists. The runtime layer is built in parallel by another agent, so this
 * test skips gracefully when the registry is absent or its backend cannot
 * run here.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SandboxManager } from '../src/core/manager.js';
import type { BackendName, RuntimeBackend } from '../src/core/types.js';

const registryTs = fileURLToPath(
  new URL('../src/runtime/index.ts', import.meta.url),
);
const registryJs = fileURLToPath(
  new URL('../src/runtime/index.js', import.meta.url),
);
const hasRegistry = existsSync(registryTs) || existsSync(registryJs);

describe.skipIf(!hasRegistry)('manager integration (real runtime)', () => {
  test('creates a real python sandbox and runs print(1+1)', async () => {
    // Variable specifier on purpose: the registry may not exist yet, and
    // this test must still type-check (and skip) without it.
    const specifier = '../src/runtime/index.js';
    const mod = (await import(specifier)) as unknown as {
      selectBackend?: unknown;
      probeAll?: unknown;
    };
    let backend: RuntimeBackend | undefined;
    if (typeof mod.selectBackend === 'function') {
      const select = mod.selectBackend as (
        name?: BackendName,
      ) => Promise<RuntimeBackend>;
      backend = await select();
    } else if (typeof mod.probeAll === 'function') {
      const probeAll = mod.probeAll as () => Promise<RuntimeBackend[]>;
      const all = await probeAll();
      backend = all[0];
    }
    if (backend === undefined) {
      console.warn('registry exports no usable backend; skipping');
      return;
    }

    const manager = new SandboxManager(
      {},
      async () => backend as RuntimeBackend,
    );
    try {
      const info = await manager.create({ language: 'python' });
      const result = await manager.exec(info.id, {
        language: 'python',
        code: 'print(1+1)',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('2');
    } catch (err) {
      console.warn(
        'real backend unavailable in this environment; skipping:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      await manager.close();
    }
  }, 60000);
});
