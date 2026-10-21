import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import type { VcpMemoryEmbeddingConfig, VcpMemoryPluginConfiguration } from '../../src/main/vcp-memory/contracts';
import type { VcpMemoryClientOptions } from '../../src/main/vcp-memory/client';

const mocks = vi.hoisted(() => ({ clients: [] as Array<{ close: ReturnType<typeof vi.fn>; options: VcpMemoryClientOptions }> }));
vi.mock('../../src/main/vcp-memory/client', () => ({ VcpMemoryClient: class {
  close = vi.fn(async () => undefined);
  constructor(readonly options: VcpMemoryClientOptions) { mocks.clients.push(this); }
} }));
const configuration = (): VcpMemoryEmbeddingConfig => ({ baseUrl: 'http://127.0.0.1/internal', model: 'gemma',
  dimension: 768, apiKey: 'internal', modelSignature: 'verified-space' });
function runtime(resolveEmbedding: () => Promise<VcpMemoryEmbeddingConfig>, resolvePlugins?: () => Promise<VcpMemoryPluginConfiguration>) {
  return new CompanionVcpRuntime({ dataRoot: 'unused-data', vendorRoot: 'unused-vendor', workerPath: 'unused-worker', resolveEmbedding, resolvePlugins });
}
beforeEach(() => { mocks.clients.length = 0; });

describe('VCP semantic space and shutdown boundaries', () => {
  it('preserves the global profile key and refuses a changed model or width under the same signature', async () => {
    let embedding = configuration();
    const service = runtime(async () => embedding);
    try {
      const original = await service.get();
      expect(original.profileKey).toBe(embedding.modelSignature);
      expect((await service.get()).client).toBe(original.client);
      embedding = { ...embedding, dimension: 1024 };
      await expect(service.get()).rejects.toThrow('签名');
      embedding = { ...configuration(), model: 'changed-model' };
      await expect(service.get()).rejects.toThrow('签名');
      expect(mocks.clients).toHaveLength(1);
      embedding = { ...embedding, modelSignature: 'new-verified-space' };
      const changed = await service.get();
      expect(changed.client).not.toBe(original.client);
      expect(changed.profileKey).toBe(embedding.modelSignature);
      expect(mocks.clients[0]!.close).toHaveBeenCalledTimes(1);
      expect(mocks.clients[1]!.options.dataRoot).not.toBe(mocks.clients[0]!.options.dataRoot);
    } finally { await service.close(); }
  });

  it('does not construct a client when closed during embedding resolution', async () => {
    let finish!: (value: VcpMemoryEmbeddingConfig) => void;
    const embedding = new Promise<VcpMemoryEmbeddingConfig>(resolve => { finish = resolve; });
    const service = runtime(() => embedding), getting = service.get();
    await Promise.resolve();
    const closing = service.close(), rejected = expect(getting).rejects.toThrow('关闭');
    finish(configuration()); await rejected; await closing;
    expect(mocks.clients).toHaveLength(0);
  });

  it('does not construct a client when closed during plugin configuration resolution', async () => {
    let finish!: (value: VcpMemoryPluginConfiguration) => void, started!: () => void;
    const plugins = new Promise<VcpMemoryPluginConfiguration>(resolve => { finish = resolve; });
    const configuring = new Promise<void>(resolve => { started = resolve; });
    const service = runtime(async () => configuration(), () => { started(); return plugins; });
    const getting = service.get(); await configuring;
    const closing = service.close(), rejected = expect(getting).rejects.toThrow('关闭');
    finish({}); await rejected; await closing;
    expect(mocks.clients).toHaveLength(0);
  });
});
