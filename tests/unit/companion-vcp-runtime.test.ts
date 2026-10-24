import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import type { VcpMemoryEmbeddingConfig, VcpMemoryPluginConfiguration } from '../../src/main/vcp-memory/contracts';
import type { VcpMemoryClientOptions } from '../../src/main/vcp-memory/client';
import type { ColdKnowledgeServiceOptions } from '../../src/main/vcp-memory/cold-service';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ clients: [] as Array<{ close: ReturnType<typeof vi.fn>; options: VcpMemoryClientOptions }> }));
const coldMocks = vi.hoisted(() => ({ services: [] as Array<{ close: ReturnType<typeof vi.fn>; options: ColdKnowledgeServiceOptions }> }));
vi.mock('../../src/main/vcp-memory/client', () => ({ VcpMemoryClient: class {
  close = vi.fn(async () => undefined);
  retire = vi.fn(async () => { await this.close(); });
  constructor(readonly options: VcpMemoryClientOptions) { mocks.clients.push(this); }
} }));
vi.mock('../../src/main/vcp-memory/cold-service', () => ({ ColdKnowledgeService: class {
  close = vi.fn(async () => undefined);
  constructor(readonly options: ColdKnowledgeServiceOptions) { coldMocks.services.push(this); }
} }));
const configuration = (): VcpMemoryEmbeddingConfig => ({ baseUrl: 'http://127.0.0.1/internal', model: 'gemma',
  dimension: 768, apiKey: 'internal', modelSignature: 'verified-space' });
function runtime(resolveEmbedding: () => Promise<VcpMemoryEmbeddingConfig>, resolvePlugins?: () => Promise<VcpMemoryPluginConfiguration>) {
  return new CompanionVcpRuntime({ dataRoot: 'unused-data', vendorRoot: 'unused-vendor', workerPath: 'unused-worker', resolveEmbedding, resolvePlugins });
}
beforeEach(() => { mocks.clients.length = 0; coldMocks.services.length = 0; });

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
  it('rotates the behavior/focus profile during a session and keeps secret changes out of its public identity', async () => {
    let plugins: VcpMemoryPluginConfiguration = { chat: { baseUrl: 'https://focus.invalid', model: 'focus-one', apiKey: 'secret-one' } };
    const service = runtime(async () => configuration(), async () => plugins);
    try {
      const original = await service.get();
      expect(original.profileKey).toMatch(/^verified-space:vcp-[a-f0-9]{20}$/u);
      expect((await service.get()).client).toBe(original.client);
      plugins = { ...plugins, chat: { ...plugins.chat!, apiKey: 'secret-two' } };
      const credentials = await service.get();
      expect(credentials.profileKey).toBe(original.profileKey); expect(credentials.client).not.toBe(original.client);
      plugins = { ...plugins, chat: { ...plugins.chat!, model: 'focus-two' } };
      const model = await service.get(); expect(model.profileKey).not.toBe(original.profileKey);
      plugins = { ...plugins, chat: { ...plugins.chat!, sourceSignature: 'non-secret-global-provider-signature' } };
      const source = await service.get(); expect(source.profileKey).not.toBe(model.profileKey);
      plugins = { ...plugins, chat: { ...plugins.chat!, connectionGeneration: 2 } };
      const sourceCredentials = await service.get(); expect(sourceCredentials.profileKey).toBe(source.profileKey); expect(sourceCredentials.client).not.toBe(source.client);
      plugins = { ...plugins, behaviorProfile: 'upstream' };
      const behavior = await service.get(); expect(behavior.profileKey).not.toBe(source.profileKey);
      expect(behavior.profileKey).not.toContain('secret');
      expect(mocks.clients.slice(0, -1).every(client => client.close.mock.calls.length === 1)).toBe(true);
      expect(mocks.clients[0]!.options.dataRoot).not.toBe(mocks.clients[2]!.options.dataRoot);
    } finally { await service.close(); }
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
  it('keeps a signed gateway semantic space across port and credential changes while refreshing its transport', async () => {
    let plugins: VcpMemoryPluginConfiguration = { chat: { baseUrl: 'http://127.0.0.1:14001', model: 'global-chat',
      apiKey: 'first-local-token', sourceSignature: 'actual-global-provider-profile' } };
    const service = runtime(async () => configuration(), async () => plugins);
    try {
      const first = await service.get();
      plugins = { chat: { ...plugins.chat!, baseUrl: 'http://127.0.0.1:24002', apiKey: 'second-local-token' } };
      const reconnected = await service.get();
      expect(reconnected.profileKey).toBe(first.profileKey);
      expect(reconnected.client).not.toBe(first.client);
      expect(mocks.clients[1]!.options.dataRoot).toBe(mocks.clients[0]!.options.dataRoot);
      expect(mocks.clients[0]!.close).toHaveBeenCalledTimes(1);
      plugins = { chat: { ...plugins.chat!, sourceSignature: 'changed-global-provider-profile' } };
      const changed = await service.get();
      expect(changed.profileKey).not.toBe(first.profileKey);
      expect(mocks.clients[2]!.options.dataRoot).not.toBe(mocks.clients[0]!.options.dataRoot);
      plugins = { chat: { ...plugins.chat!, model: 'different-focus-model' } };
      expect((await service.get()).profileKey).not.toBe(changed.profileKey);
    } finally { await service.close(); }
  });
  it.each([undefined, ''])('still rotates an external focus semantic space when its unsigned endpoint changes (%s)', async sourceSignature => {
    let plugins: VcpMemoryPluginConfiguration = { chat: { baseUrl: 'https://first-focus.invalid', model: 'focus', apiKey: 'token', sourceSignature } };
    const service = runtime(async () => configuration(), async () => plugins);
    try {
      const first = await service.get();
      plugins = { chat: { ...plugins.chat!, baseUrl: 'https://second-focus.invalid' } };
      const changed = await service.get();
      expect(changed.profileKey).not.toBe(first.profileKey);
      expect(mocks.clients[1]!.options.dataRoot).not.toBe(mocks.clients[0]!.options.dataRoot);
    } finally { await service.close(); }
  });
  it('keeps cold knowledge in the embedding space across focus changes and refreshes transport without losing its registry', async () => {
    let embedding = configuration(), plugins: VcpMemoryPluginConfiguration = { chat: { baseUrl: 'https://focus.invalid', model: 'one', apiKey: 'secret' } };
    const service = runtime(async () => embedding, async () => plugins), authorize = vi.fn(async () => true);
    try {
      const cold = await service.getCold(authorize); await service.get();
      plugins = { ...plugins, chat: { ...plugins.chat!, model: 'two' }, behaviorProfile: 'upstream' };
      await service.get(); expect(await service.getCold(authorize)).toBe(cold);
      expect(coldMocks.services).toHaveLength(1);
      const deny = vi.fn(async () => false);
      expect(await service.getCold(deny)).toBe(cold);
      expect(await coldMocks.services[0]!.options.authorize('owner', 'source', 'digest', {})).toBe(false);
      embedding = { ...embedding, queryBaseUrl: 'http://127.0.0.1/refreshed-query' };
      expect(await service.getCold(authorize)).not.toBe(cold);
      expect(coldMocks.services[1]!.options.dataRoot).toBe(coldMocks.services[0]!.options.dataRoot);
      expect(coldMocks.services[0]!.close).toHaveBeenCalledTimes(1);
      embedding = { ...embedding, dimension: 1024 };
      await expect(service.getCold(authorize)).rejects.toThrow('签名');
      embedding = { ...embedding, modelSignature: 'new-space' };
      await service.getCold(authorize);
      expect(coldMocks.services[2]!.options.dataRoot).not.toBe(coldMocks.services[1]!.options.dataRoot);
    } finally { await service.close(); }
  });
  it('resets one cold owner across historical profiles after shutdown without resolving an embedding model', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldline-cold-reset-'));
    const ownerHash = (owner: string) => createHash('sha256').update(owner).digest('hex');
    const resolveEmbedding = vi.fn(async (): Promise<VcpMemoryEmbeddingConfig> => { throw new Error('No encoder configured'); });
    const service = new CompanionVcpRuntime({ dataRoot: root, vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding });
    const cleanup = async () => {
      if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-cold-reset-')) throw new Error('Unsafe test cleanup');
      await rm(root, { recursive: true, force: true });
    };
    try {
      for (const profile of ['a'.repeat(64), 'b'.repeat(64)]) for (const owner of ['alice', 'bob']) {
        const directory = path.join(root, 'cold-knowledge', profile, 'owners', ownerHash(owner));
        await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'receipt'), owner);
      }
      await service.close(); await service.resetCold('alice');
      expect(resolveEmbedding).not.toHaveBeenCalled();
      for (const profile of ['a'.repeat(64), 'b'.repeat(64)]) {
        await expect(lstat(path.join(root, 'cold-knowledge', profile, 'owners', ownerHash('alice')))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(path.join(root, 'cold-knowledge', profile, 'owners', ownerHash('bob'), 'receipt'), 'utf8')).toBe('bob');
      }
    } finally {
      await service.close();
      await cleanup();
    }
  });
});
