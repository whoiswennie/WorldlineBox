import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
it('discovers actual original modes, rejects missing dependencies, and executes explicitly selected stages through the authorized host page', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vcp-host-retrieval-modes-'));
  const store = new CompanionsStore(path.join(root, 'ledger.sqlite'), [{ id: 'alice', name: '小肥鱼', persona: '合成验收', description: '', model: '', avatar: 'sister', proactive: false, active: true }]);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'group0 昨天约好带蓝色雨伞。完整尾段 HOST_MODE_TAIL。', replyDirective: 'none' });
  const note = store.request({ type: 'memory.record', ...scope, candidate: { content: source.content, occurredAt: new Date(Date.now() - 86400000).toISOString(), tags: ['group0', '雨伞'],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const delivery = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  store.request({ type: 'memory.outbox.complete', id: delivery.id, leaseToken: delivery.leaseToken, indexed: true });
  const native = await nativeManagementHarness(root, async command => store.request(command));
  const service = new CompanionMemoryService({ request: async command => store.request(command), cacheRoot: path.join(root, 'views'), runtime: {
    get: async () => ({ client: native.client, profileKey: 'synthetic-mode-host' }), close: () => native.client.close() }, configFor: async () => ({ apiFormat: 'openai_chat', baseUrl: '', model: '', apiKey: '' }),
    fetchFn: fetch, busy: () => true, changed: () => undefined, report: () => undefined });
  try {
    const catalog = (await service.retrievalModes(scope)).memoryRetrievalModes!;
    expect(catalog.queryScope).toBe('current_authorized_candidate_page');
    expect(catalog.modes.find(mode => mode.id === 'time')).toMatchObject({ available: true, enabledByDefault: false });
    for (const mode of ['external_rerank', 'jev_rerank', 'meta_thinking', 'semantic_group']) expect(catalog.modes.find(item => item.id === mode)).toMatchObject({ available: false, reason: expect.any(String) });
    const before = native.embeddingRequests.filter(request => request.path.startsWith('/query/')).length;
    await expect(service.search({ ...scope, query: 'group0 昨天的雨伞', retrievalOptions: { rerank: { provider: 'jev' } } })).rejects.toThrow(/jev_rerank.*不可用/u);
    expect(native.embeddingRequests.filter(request => request.path.startsWith('/query/'))).toHaveLength(before);
    const preprocess = vi.spyOn(native.client, 'preprocess'), light = vi.spyOn(native.client, 'pluginCall');
    const result = await service.search({ ...scope, query: 'group0 昨天的雨伞', limit: 100,
      retrievalOptions: { time: { ratio: .3 }, timeDecay: { halfLifeDays: 30, minScore: .01 }, expand: true, associate: true } });
    expect(result.memoryPage?.items.map(hit => hit.memory.id)).toContain(note.id);
    expect(result.memoryContext?.text, JSON.stringify(await preprocess.mock.results[0]?.value)).toContain('HOST_MODE_TAIL');
    expect(result.memoryContext?.evidence?.references).toContainEqual(expect.objectContaining({ id: note.id, version: note.version, role: 'returned' }));
    expect(preprocess).toHaveBeenCalledTimes(1); expect(light).not.toHaveBeenCalled();
    expect(JSON.stringify(preprocess.mock.calls[0]![1])).toContain('::RiverMemo::Time0.3::TimeDecay30/0.01::Expand::Associate');
    expect(JSON.stringify(preprocess.mock.calls[0]![1])).not.toContain('::AIMemo+');
    for (const mode of ['time', 'time_decay', 'expand', 'associate']) expect(result.memoryRetrievalModes?.modes.find(item => item.id === mode)?.observedCalls).toBeGreaterThan(0);
    expect(result.memoryRetrievalModes?.modes.find(item => item.id === 'external_rerank')?.observedCalls).toBe(0);
    await service.search({ ...scope, query: 'group0 昨天的雨伞', limit: 100, retrievalOptions: { timeDecay: { halfLifeDays: 30, minScore: .01 } } });
    const upstreamDecay = await preprocess.mock.results.at(-1)!.value;
    // Upstream's own ::Time prefix parser also recognizes ::TimeDecay. Keep
    // this observable behavior explicit instead of changing the original stage.
    expect(upstreamDecay.events).toContainEqual(expect.objectContaining({ type: 'RAG_RETRIEVAL_DETAILS', useTime: true }));
    await service.search({ ...scope, query: 'group0 雨伞', limit: 100 });
    expect(light).toHaveBeenCalledTimes(1); expect(preprocess).toHaveBeenCalledTimes(2);
    await expect(service.search({ ...scope, query: '', retrievalOptions: { expand: true } })).rejects.toThrow('非空查询');
  } finally { await service.close(); await native.close(); store.close(); await removeOwnedDirectory(root); }
}, 120000);
