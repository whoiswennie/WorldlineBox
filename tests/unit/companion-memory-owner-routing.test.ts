import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryViewCache } from '../../src/main/companions/memory-view-cache';
import type { CompanionMemoryRuntime, CompanionGenerationSelection } from '../../src/main/companions/vcp-runtime';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope, VcpMemoryMessage } from '../../src/main/vcp-memory/contracts';
import type { CompanionModelConfig } from '../../src/main/companions/model';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class RoutedClient extends VcpMemoryClient {
  override readonly supportsDetachedRecall = false;
  notes = new Map<string, VcpMemoryNote[]>();
  constructor() { super({ dataRoot: 'unused', vendorRoot: 'unused', workerPath: 'unused', embedding: { baseUrl: 'unused', model: 'local', dimension: 4, apiKey: '' } }); }
  override replace = vi.fn(async (scope: VcpMemoryScope, notes: VcpMemoryNote[]) => { this.notes.set(scope.scopeId, notes); return { count: notes.length, replaced: true as const }; });
  override search = vi.fn(async (scope: VcpMemoryScope) => ({ results: (this.notes.get(scope.scopeId) ?? []).map(note => ({ ...note, sourceFile: note.id, engine: 'river' as const })), diagnostics: {}, degraded: false }));
  override preprocess = vi.fn(async (scope: VcpMemoryScope, messages: VcpMemoryMessage[]) => { void messages;
    return { messages: [{ role: 'system', content: (this.notes.get(scope.scopeId) ?? []).map(note => note.content).join('\n') }], events: [] }; });
  override capabilities = vi.fn(async () => ({ plugins: {}, coldKnowledge: false, timelineGenerationConfigured: true, modes: {
    passive: { available: true, configured: true, enabledByDefault: true, exposure: 'RAGDiaryPlugin::RiverMemo', cost: 'native', observedCalls: 0 },
    focus: { available: true, configured: true, enabledByDefault: false, exposure: 'explicit_AIMemo+', cost: 'model', observedCalls: 0 },
  } }));
  override pluginCall = vi.fn(async (scope: VcpMemoryScope, name: string, args: Record<string, unknown>) => { void name; void args;
    return { result: (this.notes.get(scope.scopeId) ?? []).map(note => note.content).join('\n'), indexed: true }; });
  override interruptScope = vi.fn(async () => undefined);
  override purgeScope = vi.fn(async () => undefined);
  override close = vi.fn(async () => undefined);
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-owner-route-'));
  cleanup.push(async () => { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-owner-route-')) throw Error('Unexpected owner route directory'); await rm(root, { recursive: true }); });
  const store = new CompanionsStore(path.join(root, 'ledger.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: 'actual source only', avatar: 'sister', model: '', proactive: false, active: true })));
  cleanup.push(async () => store.close());
  const scopes = Object.fromEntries(['alice', 'bob'].map(companionId => [companionId, { companionId, conversationId: store.openPrivate(companionId).id }]));
  for (const owner of ['alice', 'bob']) {
    const scope = scopes[owner]!, source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: owner + ' ONLY_SOURCE', replyDirective: 'none' });
    store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory' as const, content: source.content, tags: [], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
  }
  for (;;) { const row = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!row) break; store.request({ type: 'memory.outbox.complete', id: row.id, leaseToken: row.leaseToken, indexed: true }); }
  const core = new RoutedClient(), clients = { alice: new RoutedClient(), bob: new RoutedClient() };
  const configs: Record<string, CompanionModelConfig> = { alice: { apiFormat: 'anthropic', baseUrl: 'https://alice.invalid', model: 'alice-model', apiKey: 'alice-key' },
    bob: { apiFormat: 'gemini_native', baseUrl: 'https://bob.invalid', model: 'bob-model', apiKey: 'bob-key' } };
  const configFor = vi.fn(async (owner: { id: string }) => configs[owner.id]!);
  const get = vi.fn(async () => ({ client: core, profileKey: 'core' })), release = vi.fn(async () => undefined);
  const describeGeneration = vi.fn(async (input: CompanionGenerationSelection) => ({ ownerId: input.ownerId, profileKey: 'owner:' + input.ownerId + ':' + input.config.model }));
  const acquireGeneration = vi.fn(async (input: CompanionGenerationSelection & { signal?: AbortSignal }) => {
    input.signal?.throwIfAborted();
    return { ...await describeGeneration(input), client: clients[input.ownerId as keyof typeof clients], connectionEpoch: 1, release };
  });
  const purgeOwner = vi.fn<NonNullable<CompanionMemoryRuntime['purgeOwner']>>(async () => undefined), interruptOwner = vi.fn(async () => undefined);
  const runtime: CompanionMemoryRuntime = { get, describeEmbedding: vi.fn(async () => ({ profileKey: 'core' })), describeGeneration, acquireGeneration, purgeOwner, interruptOwner, close: async () => undefined };
  const service = new CompanionMemoryService({ runtime, configFor, cacheRoot: path.join(root, 'views'), request: async command => store.request(command),
    busy: () => true, changed: () => undefined, report: vi.fn(), fetchFn: async () => { throw Error('No network'); } });
  cleanup.push(() => service.close());
  return { root, store, scopes, core, clients, configs, configFor, get, runtime, describeGeneration, acquireGeneration, release, purgeOwner, interruptOwner, service };
}

it('uses each actual owner configuration as an immutable lease and releases both independent focus operations', async () => {
  const f = await fixture();
  const results = await Promise.all(['alice', 'bob'].map(owner => f.service.search({ ...f.scopes[owner]!, query: 'ONLY_SOURCE', retrievalOptions: { focus: true } }, 'passive')));
  expect(f.get).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(2);
  expect(f.acquireGeneration.mock.calls.map(([input]) => [input.ownerId, input.config.apiFormat, input.config.model])).toEqual([
    ['alice', 'anthropic', 'alice-model'], ['bob', 'gemini_native', 'bob-model']]);
  for (const [input] of f.acquireGeneration.mock.calls) expect(Object.isFrozen(input.config)).toBe(true);
  expect(results[0]!.memoryContext?.text).toBe('alice ONLY_SOURCE'); expect(results[1]!.memoryContext?.text).toBe('bob ONLY_SOURCE');
});

it('does not fall back to an old ownerless globally configured runtime for generation', async () => {
  const f = await fixture(); delete f.runtime.acquireGeneration;
  await expect(f.service.search({ ...f.scopes.alice!, query: 'ONLY_SOURCE', retrievalOptions: { focus: true } }, 'passive')).rejects.toThrow('未连接此伙伴');
  expect(f.get).not.toHaveBeenCalled(); expect(f.clients.alice.preprocess).not.toHaveBeenCalled();
});

it('keeps raw active search and metadata validation independent from chat credentials and generation acquisition', async () => {
  const f = await fixture(); f.configFor.mockRejectedValue(Error('No model credentials'));
  const result = await f.service.search({ ...f.scopes.alice!, query: 'ONLY_SOURCE' });
  expect(result.memoryContext?.text).toBe('alice ONLY_SOURCE'); expect(f.acquireGeneration).not.toHaveBeenCalled(); expect(f.configFor).not.toHaveBeenCalled();
  expect(f.core.pluginCall.mock.calls[0]![2]).toMatchObject({ aimemo: false });
  const gets = f.get.mock.calls.length;
  expect(await f.service.contextValid(f.scopes.alice!, result.memoryContext)).toBe(true);
  expect(f.get).toHaveBeenCalledTimes(gets);
  expect(await f.service.contextValid(f.scopes.alice!, { revision: result.memoryContext!.revision, profileKey: 'legacy-global:vcp-old' })).toBe(false);
});

it('uses native conversation-aware passive recall without an extra model or owner generation credentials', async () => {
  const f = await fixture(); delete f.runtime.acquireGeneration;
  f.configFor.mockRejectedValue(Error('No chat model credentials'));
  const result = await f.service.search({ ...f.scopes.alice!, query: 'ONLY_SOURCE' }, 'passive');
  expect(result.memoryContext?.text).toBe('alice ONLY_SOURCE');
  expect(f.configFor).not.toHaveBeenCalled(); expect(f.acquireGeneration).not.toHaveBeenCalled();
  expect(f.core.preprocess).toHaveBeenCalledOnce();
  const messages = f.core.preprocess.mock.calls[0]![1];
  expect(JSON.stringify(messages)).toContain('::RiverMemo::TimeDecay180/0');
  expect(JSON.stringify(messages)).not.toContain('AIMemo');
  expect(result.memoryContext?.evidence).toMatchObject({ snapshotPolicy: 'task_passive_v1', dependencyCoverage: 'complete' });
});

it('keeps native-only passive packets detached with actual returned references and a final publication fence', async () => {
  const f = await fixture(); delete f.runtime.acquireGeneration;
  Object.defineProperty(f.core, 'supportsDetachedRecall', { value: true });
  const note = f.store.request({ type: 'memory.snapshot', ...f.scopes.alice! }).memorySnapshot!.notes[0]!;
  const references = [{ id: note.id, role: 'returned' as const, textHash: 'a'.repeat(64) }];
  const prepare = vi.spyOn(f.core, 'prepareRecall').mockImplementation(async (scope, messages, clock, _policy, evidence) => {
    expect(JSON.stringify(messages)).not.toContain('AIMemo');
    return { schema: 'worldlinebox.prepared-recall-v2', id: 'native_packet', scopeId: scope.scopeId, contentHash: 'b'.repeat(64),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), corpusEpoch: 1,
      contextReferences: references, contextReferenceCoverage: 'observed', queryClock: clock, hostEvidence: evidence };
  });
  const validateReasons: string[] = [];
  vi.spyOn(f.core, 'focusRecall').mockImplementation(async (_handle, options) => {
    validateReasons.push('publication'); await options?.validate?.('publication');
    return { messages: [{ role: 'system', content: 'Actual native formatter text' }], events: [], contextReferences: references, contextReferenceCoverage: 'observed' };
  });
  const result = await f.service.search({ ...f.scopes.alice!, query: 'ONLY_SOURCE' }, 'passive');
  expect(prepare).toHaveBeenCalledOnce(); expect(result.memoryContext?.text).toBe('Actual native formatter text');
  expect(result.memoryContext?.evidence?.references).toEqual([expect.objectContaining({ id: note.id, role: 'returned' })]);
  expect(result.memoryPage?.items[0]?.reasons).toEqual(['VCP 原版正文实际来源']);
  expect(validateReasons).toEqual(['publication']); expect(f.acquireGeneration).not.toHaveBeenCalled();
  expect(f.core.preprocess).not.toHaveBeenCalled();
});

it('releases and refuses an in-flight focus after an owner configuration change', async () => {
  const f = await fixture(); f.clients.alice.preprocess.mockImplementationOnce(async () => {
    await f.service.generationConfigurationChanged('alice'); return { messages: [{ role: 'system', content: 'STALE_RESULT' }], events: [] };
  });
  await expect(f.service.search({ ...f.scopes.alice!, query: 'ONLY_SOURCE', retrievalOptions: { focus: true } }, 'passive')).rejects.toThrow();
  expect(f.interruptOwner).toHaveBeenCalledWith('alice'); expect(f.release).toHaveBeenCalledOnce(); expect(f.get).not.toHaveBeenCalled();
});

it('rejects a credential-only rotation before the asynchronous configuration-change hook runs', async () => {
  const f = await fixture(); f.clients.alice.preprocess.mockImplementationOnce(async () => {
    f.configs.alice = { ...f.configs.alice!, apiKey: 'rotated-private-key' };
    return { messages: [{ role: 'system', content: 'OLD_CREDENTIAL_RESULT' }], events: [] };
  });
  await expect(f.service.search({ ...f.scopes.alice!, query: 'ONLY_SOURCE', retrievalOptions: { focus: true } }, 'passive')).rejects.toThrow('凭证已经变化');
  expect(f.interruptOwner).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  expect(f.acquireGeneration).toHaveBeenCalledOnce();
});

it('passes unopened legacy projection pairs to historical cleanup without an encoder, model or active owner', async () => {
  const f = await fixture(), cache = new CompanionMemoryViewCache(path.join(f.root, 'views'));
  const legacy = await cache.prepare('alice:owner-v2', 'legacy-global:vcp-old', []); await legacy.commit();
  f.get.mockRejectedValue(Error('Encoder unavailable')); f.configFor.mockRejectedValue(Error('Owner inactive/deleted or key unavailable'));
  await f.service.invalidate('alice', ['canonical-source-scope']);
  expect(f.purgeOwner).toHaveBeenCalledWith('alice', { canonicalScopes: ['canonical-source-scope'], historicalViews: [{ scopeId: legacy.scopeId, profileKey: 'legacy-global:vcp-old' }] });
  expect(f.get).not.toHaveBeenCalled(); expect(f.configFor).not.toHaveBeenCalled();
});
