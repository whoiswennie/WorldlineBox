import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import type { VcpMemoryEmbeddingConfig, VcpMemoryPluginConfiguration } from '../../src/main/vcp-memory/contracts';
import type { CompanionModelConfig } from '../../src/main/companions/model';
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
  interruptScope = vi.fn(async () => undefined);
  purgeScope = vi.fn(async () => undefined);
  retire = vi.fn(async () => { await this.close(); });
  constructor(readonly options: VcpMemoryClientOptions) { mocks.clients.push(this); }
} }));
vi.mock('../../src/main/vcp-memory/cold-service', () => ({ ColdKnowledgeService: class {
  close = vi.fn(async () => undefined);
  constructor(readonly options: ColdKnowledgeServiceOptions) { coldMocks.services.push(this); }
} }));
const chat = (model = 'focus-one', apiKey = 'secret-one', baseUrl = 'https://focus.invalid'): CompanionModelConfig => ({ apiFormat: 'openai_chat', model, apiKey, baseUrl });
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
  // These original identities now exercise explicit owner leases. Core get()
  // deliberately no longer means the old global chat+embedding singleton.
  it('rotates the behavior/focus profile during a session and keeps secret changes out of its public identity', async () => {
    const resolved: CompanionModelConfig[] = [], disposed = vi.fn(async () => undefined);
    const service = new CompanionVcpRuntime({ dataRoot: 'unused-data', vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      generationProfile: { maxOutputTokens: 8192 }, resolveGenerationPlugins: async input => { resolved.push(input.config); return { plugins: {}, dispose: disposed }; } });
    try {
      const original = await service.acquireGeneration({ ownerId: 'alice', config: chat() });
      expect(original.profileKey).toMatch(/^verified-space:owner-generation-v1-[a-f0-9]{20}$/u);
      const same = await service.acquireGeneration({ ownerId: 'alice', config: chat() }); expect(same.client).toBe(original.client);
      await same.release(); await original.release();
      const rotated = await service.acquireGeneration({ ownerId: 'alice', config: chat('focus-one', 'secret-two') });
      expect(rotated.profileKey).toBe(original.profileKey); expect(rotated.client).not.toBe(original.client); await rotated.release();
      const changed = await service.acquireGeneration({ ownerId: 'alice', config: chat('focus-two', 'secret-two') });
      expect(changed.profileKey).not.toBe(original.profileKey); await changed.release();
      expect(JSON.stringify(changed.profileKey)).not.toContain('secret'); expect(Object.isFrozen(resolved[0])).toBe(true);
      expect(mocks.clients[0]!.close).toHaveBeenCalledOnce(); expect(disposed).toHaveBeenCalledOnce();
      expect(mocks.clients[1]!.options.dataRoot).toBe(mocks.clients[0]!.options.dataRoot);
      expect(mocks.clients[2]!.options.dataRoot).not.toBe(mocks.clients[0]!.options.dataRoot);
    } finally { await service.close(); }
  });
  it('does not construct a client when closed during plugin configuration resolution', async () => {
    let finish!: (value: { plugins: VcpMemoryPluginConfiguration; dispose(): Promise<void> }) => void, started!: () => void;
    const configuring = new Promise<void>(resolve => { started = resolve; });
    const plugins = new Promise<{ plugins: VcpMemoryPluginConfiguration; dispose(): Promise<void> }>(resolve => { finish = resolve; });
    const dispose = vi.fn(async () => undefined);
    const service = new CompanionVcpRuntime({ dataRoot: 'unused-data', vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolveGenerationPlugins: () => { started(); return plugins; } });
    const getting = service.acquireGeneration({ ownerId: 'alice', config: chat() }); await configuring;
    const closing = service.close(), rejected = expect(getting).rejects.toThrow('关闭');
    finish({ plugins: {}, dispose }); await rejected; await closing;
    expect(mocks.clients).toHaveLength(0); expect(dispose).toHaveBeenCalledOnce();
  });
  it('keeps a signed gateway semantic space across port and credential changes while refreshing its transport', async () => {
    let port = 14001;
    const service = new CompanionVcpRuntime({ dataRoot: 'unused-data', vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolveGenerationPlugins: async () => ({ plugins: { chat: { baseUrl: 'http://127.0.0.1:' + port, model: 'owner-chat', apiKey: 'opaque-local-token' } }, dispose: async () => undefined }) });
    try {
      const first = await service.acquireGeneration({ ownerId: 'alice', config: chat() }); await first.release(); port = 24002;
      const credentials = await service.acquireGeneration({ ownerId: 'alice', config: chat('focus-one', 'new-key') }); await credentials.release();
      expect(credentials.profileKey).toBe(first.profileKey); expect(credentials.client).not.toBe(first.client);
      expect(mocks.clients[1]!.options.dataRoot).toBe(mocks.clients[0]!.options.dataRoot);
      const model = await service.acquireGeneration({ ownerId: 'alice', config: chat('focus-two', 'new-key') }); await model.release();
      expect(model.profileKey).not.toBe(first.profileKey); expect(mocks.clients[2]!.options.dataRoot).not.toBe(mocks.clients[0]!.options.dataRoot);
      expect((await service.get()).profileKey).toBe('verified-space');
    } finally { await service.close(); }
  });
  it.each([undefined, ''])('still rotates an external focus semantic space when its unsigned endpoint changes (%s)', async _sourceSignature => {
    expect(_sourceSignature || undefined).toBeUndefined();
    const service = new CompanionVcpRuntime({ dataRoot: 'unused', vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolveGenerationPlugins: async () => ({ plugins: {}, dispose: async () => undefined }) });
    try {
      const first = await service.acquireGeneration({ ownerId: 'alice', config: chat('focus', 'token', 'https://first-focus.invalid') }); await first.release();
      const changed = await service.acquireGeneration({ ownerId: 'alice', config: chat('focus', 'token', 'https://second-focus.invalid') }); await changed.release();
      expect(changed.profileKey).not.toBe(first.profileKey); expect(mocks.clients[1]!.options.dataRoot).not.toBe(mocks.clients[0]!.options.dataRoot);
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
  it('describes owner and embedding profiles without acquiring chat, a client, or a worker', async () => {
    const resolvePlugins = vi.fn(async () => ({ plugins: {}, dispose: async () => undefined }));
    const legacy = vi.fn(async () => ({}));
    const service = new CompanionVcpRuntime({ dataRoot: 'unused', vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolvePlugins: legacy, resolveGenerationPlugins: resolvePlugins });
    try {
      expect(await service.describeEmbedding()).toEqual({ profileKey: 'verified-space' });
      const description = await service.describeGeneration({ ownerId: 'alice', config: chat() }); expect(description.ownerId).toBe('alice');
      expect(mocks.clients).toHaveLength(0); expect(resolvePlugins).not.toHaveBeenCalled();
      const core = await service.get(); expect(core.profileKey).toBe('verified-space'); expect(mocks.clients[0]!.options.plugins).toBeUndefined(); expect(legacy).not.toHaveBeenCalled();
      const withoutRoute = runtime(async () => configuration());
      await expect(withoutRoute.acquireGeneration({ ownerId: 'alice', config: chat() })).rejects.toThrow('路由'); await withoutRoute.close();
    } finally { await service.close(); }
  });
  it('keeps parallel owners independent and cancels an over-capacity waiter without late route acquisition', async () => {
    const route = vi.fn(async () => ({ plugins: {}, dispose: vi.fn(async () => undefined) }));
    const service = new CompanionVcpRuntime({ dataRoot: 'unused', vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(), resolveGenerationPlugins: route });
    const leases = [];
    try {
      for (const ownerId of ['alice','bob','carol','dave']) leases.push(await service.acquireGeneration({ ownerId, config: chat() }));
      expect(new Set(mocks.clients.map(client => client.options.processBroker)).size).toBe(1);
      expect(new Set(mocks.clients.map(client => client.options.dataRoot)).size).toBe(4);
      const abort = new AbortController(), waiting = service.acquireGeneration({ ownerId: 'erin', config: chat(), signal: abort.signal });
      const rejected = expect(waiting).rejects.toThrow(); await new Promise(resolve => setTimeout(resolve, 30)); expect(route).toHaveBeenCalledTimes(4);
      // Capacity is full and erin is ahead in admission order. Alice already
      // owns a route and can continue recalling without waiting for erin.
      const resumed = await service.acquireGeneration({ ownerId: 'alice', config: chat() });
      expect(resumed.client).toBe(leases[0]!.client); await resumed.release();
      expect(route).toHaveBeenCalledTimes(4);
      const core = await service.get(), cold = await service.getCold(async () => true);
      expect(core.profileKey).toBe('verified-space'); expect(cold).toBeDefined();
      expect(await service.describeEmbedding()).toEqual({ profileKey: 'verified-space' });
      expect(route).toHaveBeenCalledTimes(4);
      abort.abort(); await rejected; await service.interruptOwner('alice');
      expect(mocks.clients[0]!.close).toHaveBeenCalledOnce(); expect(mocks.clients[1]!.close).not.toHaveBeenCalled();
      await leases[0]!.release(); const fifth = await service.acquireGeneration({ ownerId: 'erin', config: chat() }); await fifth.release();
      expect(route).toHaveBeenCalledTimes(5); expect(mocks.clients[1]!.close).not.toHaveBeenCalled();
    } finally { await Promise.all(leases.map(lease => lease.release())); await service.close(); }
  });
  it('drains a credential-rotated same-root lease before constructing its replacement writer', async () => {
    let finish!: () => void;
    const service = new CompanionVcpRuntime({ dataRoot: 'unused', vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolveGenerationPlugins: async () => ({ plugins: {}, dispose: async () => undefined }) });
    try {
      const first = await service.acquireGeneration({ ownerId: 'alice', config: chat() });
      mocks.clients[0]!.close.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      const pending = service.acquireGeneration({ ownerId: 'alice', config: chat('focus-one','rotated') });
      await vi.waitFor(() => expect(mocks.clients[0]!.close).toHaveBeenCalledOnce()); expect(mocks.clients).toHaveLength(1);
      finish(); await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.clients).toHaveLength(1);
      await first.release(); const next = await pending; expect(next.profileKey).toBe(first.profileKey); expect(next.connectionEpoch).toBeGreaterThan(first.connectionEpoch);
      expect(mocks.clients[1]!.options.dataRoot).toBe(mocks.clients[0]!.options.dataRoot); await next.release();
    } finally { await service.close(); }
  });
  it('purges exact legacy profile/scope pairs and owner generations without resolving any deleted owner configuration', async () => {
    const root = await mkdtemp(path.join(tmpdir(),'worldline-vcp-owner-cleanup-'));
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const resolveEmbedding = vi.fn(async (): Promise<VcpMemoryEmbeddingConfig> => { throw new Error('no encoder'); });
    const service = new CompanionVcpRuntime({ dataRoot: root, vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding });
    const pair = { profileKey: 'historical-global-chat', scopeId: 'exact-old-view' };
    try {
      for (const owner of ['alice','bob']) { const target = path.join(root,'generation',hash(owner),'old'); await mkdir(target,{recursive:true}); await writeFile(path.join(target,'sentinel'),owner); }
      const old = path.join(root,hash(pair.profileKey),hash(pair.scopeId)), peer = path.join(root,hash(pair.profileKey),hash('peer-view'));
      await mkdir(old,{recursive:true}); await mkdir(peer,{recursive:true}); await writeFile(path.join(peer,'sentinel'),'peer');
      await service.close(); await service.purgeOwner('alice',{historicalViews:[pair]});
      expect(resolveEmbedding).not.toHaveBeenCalled(); await expect(lstat(old)).rejects.toMatchObject({code:'ENOENT'});
      await expect(lstat(path.join(root,'generation',hash('alice')))).rejects.toMatchObject({code:'ENOENT'});
      expect(await readFile(path.join(root,'generation',hash('bob'),'old','sentinel'),'utf8')).toBe('bob');
      expect(await readFile(path.join(peer,'sentinel'),'utf8')).toBe('peer');
    } finally { await service.close(); await rm(root,{recursive:true,force:true}); }
  });

  it('retires revision readers while preserving clean historical vectors, purges dirty scopes, then fully removes a forgotten owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-revision-preserve-'));
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-vcp-revision-preserve-')) throw new Error('Unexpected revision test cleanup target.');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const disposed = vi.fn(async () => undefined), resolveEmbedding = vi.fn(async () => configuration());
    const service = new CompanionVcpRuntime({ dataRoot: root, vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding,
      resolveGenerationPlugins: async () => ({ plugins: {}, dispose: disposed }) });
    const sentinel = async (directory: string, value: string) => { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'vectors'), value); };
    try {
      const before = await service.acquireGeneration({ ownerId: 'alice', config: chat() }); await before.release();
      const ownerRoot = path.join(root, 'generation', hash('alice'));
      const clean = path.join(mocks.clients[0]!.options.dataRoot, hash('clean-view'));
      const dirty = path.join(mocks.clients[0]!.options.dataRoot, hash('dirty-view'));
      const oldProfile = 'historical-profile', oldClean = path.join(ownerRoot, hash(oldProfile), hash('old-clean'));
      const oldDirty = path.join(ownerRoot, hash(oldProfile), hash('old-dirty'));
      const bob = path.join(root, 'generation', hash('bob'), hash(oldProfile), hash('bob-clean'));
      const canonical = path.join(root, hash('verified-space'), hash('canonical-owner'));
      const peerCanonical = path.join(root, hash('verified-space'), hash('peer-canonical'));
      for (const [directory, value] of [[clean, 'CURRENT_CLEAN_VECTORS'], [dirty, 'UNSAFE_INTERRUPTED_WRITE'],
        [oldClean, 'HISTORICAL_CLEAN_VECTORS'], [oldDirty, 'OLD_UNSAFE_WRITE'], [bob, 'BOB_VECTORS'],
        [canonical, 'CANONICAL_VECTORS'], [peerCanonical, 'PEER_CANONICAL']] as const) await sentinel(directory, value);
      await service.purgeOwner('alice', { preserveIndexes: true, historicalViews: [
        { profileKey: before.profileKey, scopeId: 'dirty-view' }, { profileKey: oldProfile, scopeId: 'old-dirty' },
      ] });
      expect(mocks.clients[0]!.close).toHaveBeenCalledOnce(); expect(disposed).toHaveBeenCalledOnce();
      for (const directory of [dirty, oldDirty]) await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(clean, 'vectors'), 'utf8')).toBe('CURRENT_CLEAN_VECTORS');
      expect(await readFile(path.join(oldClean, 'vectors'), 'utf8')).toBe('HISTORICAL_CLEAN_VECTORS');
      expect(await readFile(path.join(canonical, 'vectors'), 'utf8')).toBe('CANONICAL_VECTORS');
      const after = await service.acquireGeneration({ ownerId: 'alice', config: chat() }); await after.release();
      expect(after.client).not.toBe(before.client); expect(after.profileKey).toBe(before.profileKey);
      expect(mocks.clients[1]!.options.dataRoot).toBe(mocks.clients[0]!.options.dataRoot);
      expect(after.connectionEpoch).toBeGreaterThan(before.connectionEpoch);

      // The default forgetting/reset path remains a full physical owner purge.
      await service.purgeOwner('alice', { canonicalScopes: ['canonical-owner'] });
      await expect(lstat(ownerRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(canonical)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(bob, 'vectors'), 'utf8')).toBe('BOB_VECTORS');
      expect(await readFile(path.join(peerCanonical, 'vectors'), 'utf8')).toBe('PEER_CANONICAL');
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

});
