import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColdKnowledgeServiceOptions as ColdOptions } from '../../src/main/vcp-memory/cold-service';
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
  setOwnerPrompts = vi.fn();
  close = vi.fn(async () => undefined);
  interruptScope = vi.fn(async () => undefined);
  purgeScope = vi.fn(async () => undefined);
  retire = vi.fn(async () => { await this.close(); });
  forget = vi.fn(async () => undefined);
  constructor(readonly options: VcpMemoryClientOptions) { mocks.clients.push(this); }
} }));
vi.mock('../../src/main/vcp-memory/cold-service', () => ({ ColdKnowledgeService: class {
  close = vi.fn(async () => undefined);
  constructor(readonly options: ColdKnowledgeServiceOptions) { coldMocks.services.push(this); }
} }));
const storage = (base: string) => async (ownerId: string) => {
  const workspaceRoot = path.resolve(base), ownerRoot = path.join(workspaceRoot, ownerId);
  return { ownerId, workspaceRoot, ownerRoot, indexRoot: path.join(ownerRoot, '.认知索引'), ownerPrompts: { aimemoTemplate: 'fixture {{knowledge_base}}', timelineTemplate: 'fixture {{agentName}} {{month}}', summaryTemplate: 'fixture summary {{agentName}} {{month}}' } };
};
async function getCore(service: CompanionVcpRuntime) {
  const lease = await service.get({ ownerId: 'alice' }); await lease.release?.(); return lease;
}
async function getCold(service: CompanionVcpRuntime, authorize: ColdOptions['authorize']) {
  const lease = await service.getCold({ ownerId: 'alice' }, authorize); await lease.release?.(); return lease;
}
const chat = (model = 'focus-one', apiKey = 'secret-one', baseUrl = 'https://focus.invalid'): CompanionModelConfig => ({ apiFormat: 'openai_chat', model, apiKey, baseUrl });
const configuration = (): VcpMemoryEmbeddingConfig => ({ baseUrl: 'http://127.0.0.1/internal', model: 'gemma',
  dimension: 768, apiKey: 'internal', modelSignature: 'verified-space' });
function runtime(resolveEmbedding: () => Promise<VcpMemoryEmbeddingConfig>, resolvePlugins?: () => Promise<VcpMemoryPluginConfiguration>) {
  return new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused-data'), resolveOwnerCleanupStorage: storage('unused-data'), vendorRoot: 'unused-vendor', workerPath: 'unused-worker', resolveEmbedding, resolvePlugins });
}
beforeEach(() => { mocks.clients.length = 0; coldMocks.services.length = 0; });

describe('VCP semantic space and shutdown boundaries', () => {
  it.each(['memory', 'knowledge'] as const)('cleans one owner’s %s while another owner waits for a full pool', async kind => {
    const service = runtime(async () => configuration()), leases = [];
    const abort = new AbortController(); let waiting: Promise<unknown> | undefined;
    try {
      for (const ownerId of ['alice', 'bob', 'carol', 'dave']) leases.push(await service.get({ ownerId }));
      waiting = service.get({ ownerId: 'erin', signal: abort.signal }).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(mocks.clients).toHaveLength(4);
      let cleaned = false;
      const cleanup = (kind === 'memory' ? service.purgeOwner('reset_owner') : service.resetCold('reset_owner')).then(() => { cleaned = true; });
      await vi.waitFor(() => expect(cleaned).toBe(true), { timeout: 1000 }); await cleanup;
      expect(mocks.clients.every(client => client.close.mock.calls.length === 0)).toBe(true);
    } finally { abort.abort(); await waiting; await Promise.all(leases.map(lease => lease.release?.())); await service.close(); }
  });
  it('allows trusted index withdrawal with a missing live prompt while queries reject, then rereads repaired prompts without index clearing them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldline-index-prompt-')), prompt = path.join(root, 'live-focus.md');
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-index-prompt-')) throw new Error('Unsafe index prompt fixture cleanup.');
    await writeFile(prompt, 'OLD {{knowledge_base}}');
    const resolveOwnerStorage = vi.fn(async (owner: string) => ({ ...await storage(root)(owner), ownerPrompts: {
      ...(await storage(root)(owner)).ownerPrompts, aimemoTemplate: await readFile(prompt, 'utf8') } }));
    const service = new CompanionVcpRuntime({ resolveOwnerStorage, resolveOwnerCleanupStorage: storage(root), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration() });
    try {
      const query = await service.get({ ownerId: 'alice' }), setPrompts = query.client.setOwnerPrompts as ReturnType<typeof vi.fn>;
      await query.release?.(); const before = setPrompts.mock.calls.length; await rm(prompt);
      const index = await service.get({ ownerId: 'alice', purpose: 'index' });
      await index.client.forget({ scopeId: 'synthetic-index' }, 'withdrawn_note'); await index.release?.();
      expect(index.client).toBe(query.client); expect(setPrompts.mock.calls).toHaveLength(before);
      await expect(service.get({ ownerId: 'alice' })).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(prompt, 'REPAIRED live {{knowledge_base}}'); const repaired = await service.get({ ownerId: 'alice' });
      expect(repaired.client).toBe(query.client); expect(setPrompts.mock.calls.at(-1)![0].aimemoTemplate).toBe('REPAIRED live {{knowledge_base}}');
      await repaired.release?.();
    } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('bounds core and cold admission before resolving another owner or creating a client', async () => {
    let finish!: (value: VcpMemoryEmbeddingConfig) => void;
    const resolveEmbedding = vi.fn(() => new Promise<VcpMemoryEmbeddingConfig>(resolve => { finish = resolve; }));
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused'), resolveOwnerCleanupStorage: storage('unused'), vendorRoot: 'unused', workerPath: 'unused',
      resolveEmbedding, maxPendingAdmissions: 1 });
    const first = service.get({ ownerId: 'alice' });
    try {
      await vi.waitFor(() => expect(resolveEmbedding).toHaveBeenCalledOnce());
      await expect(service.getCold({ ownerId: 'bob' }, async () => true)).rejects.toMatchObject({ code: 'VCP_MEMORY_NATIVE_CAPACITY' });
      expect(service.resourceSnapshot().admissions.coreAndCold).toBe(1); expect(resolveEmbedding).toHaveBeenCalledOnce();
      finish(configuration()); const lease = await first; await lease.release?.();
      expect(service.resourceSnapshot().admissions.coreAndCold).toBe(0);
    } finally { finish(configuration()); await service.close(); }
  });
  it('binds every hot, generating and cold client to the trusted owner asset tree', async () => {
    const root = path.resolve('synthetic-owner-assets'), service = new CompanionVcpRuntime({ resolveOwnerStorage: storage(root), resolveOwnerCleanupStorage: storage(root),
      vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolveGenerationPlugins: async () => ({ plugins: {}, dispose: async () => undefined }) });
    const alice = await service.get({ ownerId: 'alice' }), bob = await service.get({ ownerId: 'bob' });
    const generation = await service.acquireGeneration({ ownerId: 'alice', config: chat() });
    const cold = await service.getCold({ ownerId: 'alice' }, async () => true);
    try {
      expect(mocks.clients[0]!.options.dataRoot).toContain(path.join(root, 'alice', '.认知索引', 'hot'));
      expect(mocks.clients[1]!.options.dataRoot).toContain(path.join(root, 'bob', '.认知索引', 'hot'));
      expect(mocks.clients[2]!.options.dataRoot).toContain(path.join(root, 'alice', '.认知索引', 'generation'));
      expect(coldMocks.services[0]!.options.dataRoot).toContain(path.join(root, 'alice', '.认知索引', 'cold'));
      expect(coldMocks.services[0]!.options.boundOwnerId).toBe('alice');
      expect(coldMocks.services[0]!.options.processBroker).toBe(mocks.clients[0]!.options.processBroker);
      expect(mocks.clients.every(client => client.options.preparedRecallBudget?.workspaceRoot === root)).toBe(true);
      expect(new Set(mocks.clients.map(client => client.options.processBroker)).size).toBe(1);
    } finally { await alice.release?.(); await bob.release?.(); await generation.release(); await cold.release?.(); await service.close(); }
    const wrong = new CompanionVcpRuntime({ resolveOwnerStorage: async () => storage(root)('bob'), resolveOwnerCleanupStorage: storage(root), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration() });
    try { await expect(wrong.get({ ownerId: 'alice' })).rejects.toThrow('可信伙伴'); }
    finally { await wrong.close(); }
  });
  it('does not evict a referenced core client and reuses an existing owner while a fifth waits', async () => {
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage(path.resolve('synthetic-bounded-assets')), resolveOwnerCleanupStorage: storage(path.resolve('synthetic-bounded-assets')), vendorRoot: 'unused', workerPath: 'unused',
      resolveEmbedding: async () => configuration() });
    const leases = [];
    try {
      for (const ownerId of ['alice', 'bob', 'carol', 'dave']) leases.push(await service.get({ ownerId }));
      const controller = new AbortController(), waiting = service.get({ ownerId: 'erin', signal: controller.signal });
      const rejected = expect(waiting).rejects.toThrow(); await new Promise(resolve => setTimeout(resolve, 30));
      expect(mocks.clients).toHaveLength(4); expect(mocks.clients.every(client => !client.close.mock.calls.length)).toBe(true);
      const same = await service.get({ ownerId: 'alice' }); expect(same.client).toBe(leases[0]!.client); await same.release?.();
      controller.abort(); await rejected; await leases[0]!.release?.();
      const fifth = await service.get({ ownerId: 'erin' }); expect(mocks.clients).toHaveLength(5); expect(mocks.clients[0]!.close).toHaveBeenCalledOnce();
      expect(mocks.clients[1]!.close).not.toHaveBeenCalled(); await fifth.release?.();
    } finally { await Promise.all(leases.map(lease => lease.release?.())); await service.close(); }
  });
  it('refreshes a live owner template without retiring a valid generation lease or changing its profile', async () => {
    let template = 'OLD {{knowledge_base}}';
    const service = new CompanionVcpRuntime({ resolveOwnerCleanupStorage: storage(path.resolve('synthetic-live-prompts')), resolveOwnerStorage: async owner => ({ ...await storage(path.resolve('synthetic-live-prompts'))(owner), ownerPrompts: { ...((await storage(path.resolve('synthetic-live-prompts'))(owner)).ownerPrompts), aimemoTemplate: template } }),
      vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(), resolveGenerationPlugins: async () => ({ plugins: {}, dispose: async () => undefined }) });
    const first = await service.acquireGeneration({ ownerId: 'alice', config: chat() });
    try {
      template = 'NEW {{knowledge_base}}'; const second = await service.acquireGeneration({ ownerId: 'alice', config: chat() });
      try { expect(second.client).toBe(first.client); expect(second.profileKey).toBe(first.profileKey);
        expect(mocks.clients[0]!.close).not.toHaveBeenCalled(); expect(Reflect.get(first.client, 'setOwnerPrompts')).toHaveBeenCalledWith(expect.objectContaining({ aimemoTemplate: template })); }
      finally { await second.release(); }
    } finally { await first.release(); await service.close(); }
  });
  it('preserves the global profile key and refuses a changed model or width under the same signature', async () => {
    let embedding = configuration();
    const service = runtime(async () => embedding);
    try {
      const original = await getCore(service);
      expect(original.profileKey).toBe(embedding.modelSignature + ':narrative-v2');
      expect((await getCore(service)).client).toBe(original.client);
      embedding = { ...embedding, dimension: 1024 };
      await expect(getCore(service)).rejects.toThrow('签名');
      embedding = { ...configuration(), model: 'changed-model' };
      await expect(getCore(service)).rejects.toThrow('签名');
      expect(mocks.clients).toHaveLength(1);
      embedding = { ...embedding, modelSignature: 'new-verified-space' };
      const changed = await getCore(service);
      expect(changed.client).not.toBe(original.client);
      expect(changed.profileKey).toBe(embedding.modelSignature + ':narrative-v2');
      expect(mocks.clients[0]!.close).toHaveBeenCalledTimes(1);
      expect(mocks.clients[1]!.options.dataRoot).not.toBe(mocks.clients[0]!.options.dataRoot);
    } finally { await service.close(); }
  });

  it('does not construct a client when closed during embedding resolution', async () => {
    let finish!: (value: VcpMemoryEmbeddingConfig) => void;
    const embedding = new Promise<VcpMemoryEmbeddingConfig>(resolve => { finish = resolve; });
    const service = runtime(() => embedding), getting = getCore(service);
    await Promise.resolve();
    const closing = service.close(), rejected = expect(getting).rejects.toThrow('关闭');
    finish(configuration()); await rejected; await closing;
    expect(mocks.clients).toHaveLength(0);
  });
  // These original identities now exercise explicit owner leases. Core get()
  // deliberately no longer means the old global chat+embedding singleton.
  it('rotates the behavior/focus profile during a session and keeps secret changes out of its public identity', async () => {
    const resolved: CompanionModelConfig[] = [], disposed = vi.fn(async () => undefined);
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused-data'), resolveOwnerCleanupStorage: storage('unused-data'), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      generationProfile: { maxOutputTokens: 8192 }, resolveGenerationPlugins: async input => { resolved.push(input.config); return { plugins: {}, dispose: disposed }; } });
    try {
      const original = await service.acquireGeneration({ ownerId: 'alice', config: chat() });
      expect(original.profileKey).toMatch(/^verified-space:narrative-v2:owner-generation-v1-[a-f0-9]{20}$/u);
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
  it('preserves host live-file and provider-budget callbacks on the owner generation route without adding them to semantic identities', async () => {
    const resolved: CompanionModelConfig[] = [], beforeRequest = vi.fn(async () => async () => undefined);
    const resolveAssetContext = vi.fn(async (context: { system: string; user: string }) => context);
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused-data'), resolveOwnerCleanupStorage: storage('unused-data'), vendorRoot: 'unused', workerPath: 'unused',
      resolveEmbedding: async () => configuration(), resolveGenerationPlugins: async input => { resolved.push(input.config); return { plugins: {}, dispose: async () => undefined }; } });
    try {
      const plain = await service.describeGeneration({ ownerId: 'alice', config: chat() });
      const config = { ...chat(), providerBudget: { beforeRequest }, resolveAssetContext };
      const lease = await service.acquireGeneration({ ownerId: 'alice', config });
      expect(lease.profileKey).toBe(plain.profileKey); expect(resolved[0]!.providerBudget?.beforeRequest).toBe(beforeRequest);
      expect(resolved[0]!.resolveAssetContext).toBe(resolveAssetContext);
      await resolved[0]!.providerBudget!.beforeRequest(12, 8192, 'timeline'); expect(beforeRequest).toHaveBeenCalledWith(12, 8192, 'timeline');
      await lease.release();
      const anotherCallback = await service.acquireGeneration({ ownerId: 'alice', config: { ...chat(), providerBudget: { beforeRequest: async () => async () => undefined } } });
      expect(anotherCallback.client).toBe(lease.client); await anotherCallback.release();
    } finally { await service.close(); }
  });
  it('does not construct a client when closed during plugin configuration resolution', async () => {
    let finish!: (value: { plugins: VcpMemoryPluginConfiguration; dispose(): Promise<void> }) => void, started!: () => void;
    const configuring = new Promise<void>(resolve => { started = resolve; });
    const plugins = new Promise<{ plugins: VcpMemoryPluginConfiguration; dispose(): Promise<void> }>(resolve => { finish = resolve; });
    const dispose = vi.fn(async () => undefined);
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused-data'), resolveOwnerCleanupStorage: storage('unused-data'), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolveGenerationPlugins: () => { started(); return plugins; } });
    const getting = service.acquireGeneration({ ownerId: 'alice', config: chat() }); await configuring;
    const closing = service.close(), rejected = expect(getting).rejects.toThrow('关闭');
    finish({ plugins: {}, dispose }); await rejected; await closing;
    expect(mocks.clients).toHaveLength(0); expect(dispose).toHaveBeenCalledOnce();
  });
  it('keeps a signed gateway semantic space across port and credential changes while refreshing its transport', async () => {
    let port = 14001;
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused-data'), resolveOwnerCleanupStorage: storage('unused-data'), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolveGenerationPlugins: async () => ({ plugins: { chat: { baseUrl: 'http://127.0.0.1:' + port, model: 'owner-chat', apiKey: 'opaque-local-token' } }, dispose: async () => undefined }) });
    try {
      const first = await service.acquireGeneration({ ownerId: 'alice', config: chat() }); await first.release(); port = 24002;
      const credentials = await service.acquireGeneration({ ownerId: 'alice', config: chat('focus-one', 'new-key') }); await credentials.release();
      expect(credentials.profileKey).toBe(first.profileKey); expect(credentials.client).not.toBe(first.client);
      expect(mocks.clients[1]!.options.dataRoot).toBe(mocks.clients[0]!.options.dataRoot);
      const model = await service.acquireGeneration({ ownerId: 'alice', config: chat('focus-two', 'new-key') }); await model.release();
      expect(model.profileKey).not.toBe(first.profileKey); expect(mocks.clients[2]!.options.dataRoot).not.toBe(mocks.clients[0]!.options.dataRoot);
      expect((await getCore(service)).profileKey).toBe('verified-space:narrative-v2');
    } finally { await service.close(); }
  });
  it.each([undefined, ''])('still rotates an external focus semantic space when its unsigned endpoint changes (%s)', async _sourceSignature => {
    expect(_sourceSignature || undefined).toBeUndefined();
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused'), resolveOwnerCleanupStorage: storage('unused'), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
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
      const cold = await getCold(service, authorize); await getCore(service);
      plugins = { ...plugins, chat: { ...plugins.chat!, model: 'two' }, behaviorProfile: 'upstream' };
      await getCore(service); expect(await getCold(service, authorize)).toBeDefined();
      expect(coldMocks.services).toHaveLength(1);
      const deny = vi.fn(async () => false);
      expect(await getCold(service, deny)).toBeDefined();
      expect(await coldMocks.services[0]!.options.authorize('owner', 'source', 'digest', {})).toBe(false);
      embedding = { ...embedding, queryBaseUrl: 'http://127.0.0.1/refreshed-query' };
      expect(await getCold(service, authorize)).not.toBe(cold);
      expect(coldMocks.services[1]!.options.dataRoot).toBe(coldMocks.services[0]!.options.dataRoot);
      expect(coldMocks.services[0]!.close).toHaveBeenCalledTimes(1);
      embedding = { ...embedding, dimension: 1024 };
      await expect(getCold(service, authorize)).rejects.toThrow('签名');
      embedding = { ...embedding, modelSignature: 'new-space' };
      await getCold(service, authorize);
      expect(coldMocks.services[2]!.options.dataRoot).not.toBe(coldMocks.services[1]!.options.dataRoot);
    } finally { await service.close(); }
  });
  it('resets one cold owner across historical profiles after shutdown without resolving an embedding model', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldline-cold-reset-'));
    const ownerHash = (owner: string) => createHash('sha256').update(owner).digest('hex');
    const resolveEmbedding = vi.fn(async (): Promise<VcpMemoryEmbeddingConfig> => { throw new Error('No encoder configured'); });
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage(root), resolveOwnerCleanupStorage: storage(root), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding });
    const cleanup = async () => {
      if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-cold-reset-')) throw new Error('Unsafe test cleanup');
      await rm(root, { recursive: true, force: true });
    };
    try {
      for (const profile of ['a'.repeat(64), 'b'.repeat(64)]) for (const owner of ['alice', 'bob']) {
        const directory = path.join(root, owner, '.认知索引', 'cold', profile, 'owners', ownerHash(owner));
        await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'receipt'), owner);
      }
      await service.close(); await service.resetCold('alice');
      expect(resolveEmbedding).not.toHaveBeenCalled();
      for (const profile of ['a'.repeat(64), 'b'.repeat(64)]) {
        await expect(lstat(path.join(root, 'alice', '.认知索引', 'cold', profile, 'owners', ownerHash('alice')))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(path.join(root, 'bob', '.认知索引', 'cold', profile, 'owners', ownerHash('bob'), 'receipt'), 'utf8')).toBe('bob');
      }
    } finally {
      await service.close();
      await cleanup();
    }
  });
  it('describes owner and embedding profiles without acquiring chat, a client, or a worker', async () => {
    const resolvePlugins = vi.fn(async () => ({ plugins: {}, dispose: async () => undefined }));
    const legacy = vi.fn(async () => ({}));
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused'), resolveOwnerCleanupStorage: storage('unused'), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
      resolvePlugins: legacy, resolveGenerationPlugins: resolvePlugins });
    try {
      expect(await service.describeEmbedding()).toEqual({ profileKey: 'verified-space:narrative-v2' });
      const description = await service.describeGeneration({ ownerId: 'alice', config: chat() }); expect(description.ownerId).toBe('alice');
      expect(mocks.clients).toHaveLength(0); expect(resolvePlugins).not.toHaveBeenCalled();
      const core = await getCore(service); expect(core.profileKey).toBe('verified-space:narrative-v2'); expect(mocks.clients[0]!.options.plugins?.chat).toBeUndefined(); expect(legacy).not.toHaveBeenCalled();
      const withoutRoute = runtime(async () => configuration());
      await expect(withoutRoute.acquireGeneration({ ownerId: 'alice', config: chat() })).rejects.toThrow('路由'); await withoutRoute.close();
    } finally { await service.close(); }
  });
  it('keeps parallel owners independent and cancels an over-capacity waiter without late route acquisition', async () => {
    const route = vi.fn(async () => ({ plugins: {}, dispose: vi.fn(async () => undefined) }));
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused'), resolveOwnerCleanupStorage: storage('unused'), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(), resolveGenerationPlugins: route });
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
      const core = await getCore(service), cold = await getCold(service, async () => true);
      expect(core.profileKey).toBe('verified-space:narrative-v2'); expect(cold).toBeDefined();
      expect(await service.describeEmbedding()).toEqual({ profileKey: 'verified-space:narrative-v2' });
      expect(route).toHaveBeenCalledTimes(4);
      abort.abort(); await rejected; await service.interruptOwner('alice');
      expect(mocks.clients[0]!.close).toHaveBeenCalledOnce(); expect(mocks.clients[1]!.close).not.toHaveBeenCalled();
      await leases[0]!.release(); const fifth = await service.acquireGeneration({ ownerId: 'erin', config: chat() }); await fifth.release();
      expect(route).toHaveBeenCalledTimes(5); expect(mocks.clients[1]!.close).not.toHaveBeenCalled();
    } finally { await Promise.all(leases.map(lease => lease.release())); await service.close(); }
  });
  it('drains a credential-rotated same-root lease before constructing its replacement writer', async () => {
    let finish!: () => void;
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage('unused'), resolveOwnerCleanupStorage: storage('unused'), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding: async () => configuration(),
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
  it('purges exact owner profile views and generations without resolving any model configuration', async () => {
    const root = await mkdtemp(path.join(tmpdir(),'worldline-vcp-owner-cleanup-'));
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const resolveEmbedding = vi.fn(async (): Promise<VcpMemoryEmbeddingConfig> => { throw new Error('no encoder'); });
    const resolveOwnerStorage = vi.fn(async (): Promise<never> => { throw new Error('owner prompt file was removed'); });
    const resolveOwnerCleanupStorage = vi.fn(storage(root));
    const service = new CompanionVcpRuntime({ resolveOwnerStorage, resolveOwnerCleanupStorage, vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding });
    const pair = { profileKey: 'historical-global-chat', scopeId: 'exact-old-view' };
    try {
      for (const owner of ['alice','bob']) { const target = path.join(root,owner,'.认知索引','generation','old'); await mkdir(target,{recursive:true}); await writeFile(path.join(target,'sentinel'),owner); }
      const old = path.join(root,'alice','.认知索引','hot',hash(pair.profileKey),hash(pair.scopeId)), peer = path.join(root,'bob','.认知索引','hot',hash(pair.profileKey),hash('peer-view'));
      await mkdir(old,{recursive:true}); await mkdir(peer,{recursive:true}); await writeFile(path.join(peer,'sentinel'),'peer');
      await service.close(); await service.purgeOwner('alice',{historicalViews:[pair]});
      expect(resolveEmbedding).not.toHaveBeenCalled(); await expect(lstat(old)).rejects.toMatchObject({code:'ENOENT'});
      await expect(lstat(path.join(root,'alice','.认知索引','generation'))).rejects.toMatchObject({code:'ENOENT'});
      expect(await readFile(path.join(root,'bob','.认知索引','generation','old','sentinel'),'utf8')).toBe('bob');
      expect(await readFile(path.join(peer,'sentinel'),'utf8')).toBe('peer');
      const cold = path.join(root, 'alice', '.认知索引', 'cold', 'historical-encoder');
      await mkdir(cold, { recursive: true }); await writeFile(path.join(cold, 'sentinel'), 'cold derived material');
      await service.resetCold('alice'); await expect(lstat(cold)).rejects.toMatchObject({ code: 'ENOENT' });
      await service.purgeOwner('absent'); await service.resetCold('absent');
      await expect(lstat(path.join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(resolveOwnerStorage).not.toHaveBeenCalled(); expect(resolveOwnerCleanupStorage).toHaveBeenCalledTimes(4);
    } finally { await service.close(); await rm(root,{recursive:true,force:true}); }
  });

  it('retires revision readers while preserving clean historical vectors, purges dirty scopes, then fully removes a forgotten owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-revision-preserve-'));
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-vcp-revision-preserve-')) throw new Error('Unexpected revision test cleanup target.');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const disposed = vi.fn(async () => undefined), resolveEmbedding = vi.fn(async () => configuration());
    const service = new CompanionVcpRuntime({ resolveOwnerStorage: storage(root), resolveOwnerCleanupStorage: storage(root), vendorRoot: 'unused', workerPath: 'unused', resolveEmbedding,
      resolveGenerationPlugins: async () => ({ plugins: {}, dispose: disposed }) });
    const sentinel = async (directory: string, value: string) => { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'vectors'), value); };
    try {
      const before = await service.acquireGeneration({ ownerId: 'alice', config: chat() }); await before.release();
      const ownerRoot = path.join(root, 'alice', '.认知索引', 'generation');
      const clean = path.join(mocks.clients[0]!.options.dataRoot, hash('clean-view'));
      const dirty = path.join(mocks.clients[0]!.options.dataRoot, hash('dirty-view'));
      const oldProfile = 'historical-profile', oldClean = path.join(ownerRoot, hash(oldProfile), hash('old-clean'));
      const oldDirty = path.join(ownerRoot, hash(oldProfile), hash('old-dirty'));
      const bob = path.join(root, 'bob', '.认知索引', 'generation', hash(oldProfile), hash('bob-clean'));
      const canonical = path.join(root, 'alice', '.认知索引', 'hot', hash('verified-space'), hash('canonical-owner'));
      const peerCanonical = path.join(root, 'bob', '.认知索引', 'hot', hash('verified-space'), hash('peer-canonical'));
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
