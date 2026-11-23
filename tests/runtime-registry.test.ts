import { describe, expect, it } from 'vitest';
import { getBackend, probeAll, selectBackend } from '../src/runtime/index.js';

describe('backend registry', () => {
  it('probeAll lists all three backends', async () => {
    const all = await probeAll();
    expect(all.map((caps) => caps.name).sort()).toEqual([
      'bwrap',
      'docker',
      'process',
    ]);
    const byName = new Map(all.map((caps) => [caps.name, caps]));
    expect(byName.get('bwrap')?.available).toBe(true);
    expect(byName.get('process')?.available).toBe(true);
    expect(byName.get('docker')?.available).toBe(false);
    expect(byName.get('docker')?.reason).toMatch(/docker/i);
  });

  it('default selection is bwrap on this host', async () => {
    const backend = await selectBackend();
    expect(backend.name).toBe('bwrap');
  });

  it('explicit selection works', async () => {
    expect((await selectBackend('bwrap')).name).toBe('bwrap');
    expect((await selectBackend('process')).name).toBe('process');
  });

  it('explicit selection of an unavailable backend rejects', async () => {
    await expect(selectBackend('docker')).rejects.toThrow(/docker/i);
  });

  it('getBackend returns the backend instance by name', () => {
    expect(getBackend('bwrap').name).toBe('bwrap');
    expect(getBackend('process').name).toBe('process');
    expect(getBackend('docker').name).toBe('docker');
  });
});
