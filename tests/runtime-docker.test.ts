import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DockerBackend } from '../src/runtime/backends/docker.js';
import { selectBackend } from '../src/runtime/index.js';

const backend = new DockerBackend();

describe('docker backend', () => {
  it('probe() reports unavailable with a reason when Docker is absent', async () => {
    const caps = await backend.probe();
    expect(caps.name).toBe('docker');
    expect(caps.available).toBe(false);
    expect(caps.reason).toBeTruthy();
    expect(caps.reason).toMatch(/docker/i);
  });

  it("selectBackend('docker') rejects with a clear error", async () => {
    await expect(selectBackend('docker')).rejects.toThrow(/docker/i);
  });

  it('create() rejects with a clear error instead of pretending to work', async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), 'cell-docker-'));
    await expect(
      backend.create({
        id: 'docker-test',
        language: 'python',
        limits: {},
        network: 'none',
        workdir,
      }),
    ).rejects.toThrow(/docker/i);
  });
});
