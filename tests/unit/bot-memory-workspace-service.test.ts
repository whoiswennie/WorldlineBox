import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BotService } from '../../src/main/companion-bot/service';
import { BotMemoryService, type BotMemoryUpdate, type BotMemoryScope, type BotMemoryOrganize } from '../../src/main/companion-bot/memory-service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { buildBotMemoryInspection } from '../../src/main/companion-bot/memory-inspection';
import type { BotToolCall as ManagedCall } from '../../src/main/companion-bot/tool-server';
import { BotMaintenanceStore } from '../../src/main/companion-bot/memory-maintenance-store';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-management-'));
  const update = vi.fn(async (_scope: BotMemoryScope, input: BotMemoryUpdate) => ({ state: 'indexed', id: input.id, checksum: 'b'.repeat(32) }));
  const recall = vi.fn(async (_scope: BotMemoryScope, input: { query: string; mode: 'passive' | 'semantic' | 'history' }) => buildBotMemoryInspection({ requestId: 'trial', query: input.query, mode: input.mode, totalMs: 10,
    result: { events: [{ type: 'RAG_RETRIEVAL_DETAILS', results: [{ text: '可撤回的旧事实', score: 0.4 }] }] } }));
  const memory = new class extends BotMemoryService {
    override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
    override async appendHistory() { return { appended: [] }; }
    override async update(scope: BotMemoryScope, input: BotMemoryUpdate) { return update(scope, input); }
    override async recall(scope: BotMemoryScope, input: Parameters<BotMemoryService['recall']>[1]) { return recall(scope, input); }
    override async catalog(_scope: BotMemoryScope, input: object) { return { items: [], tags: [], received: input }; }
    override async forget(_scope: BotMemoryScope, input: { id: string }) { return { forgotten: true as const, id: input.id, revision: '1', sourceEventIds: [], sourceMessageIds: [], relatedIds: [], physicalSourceErasure: false as const }; }
    override async close() {}
  }({ root, runtime: async () => { throw new Error('No fixture runtime'); }, embedding: async () => { throw new Error('No fixture model'); } });
  const host = vi.fn(async () => { throw new Error('DSH must not be used for memory management'); });
  const service = new BotService({ root, brain: new BotDshBrain({ getHost: host }), brainRuntime: 'worldlinebox', memory,
    model: () => ({ apiFormat: 'openai_chat', apiKey: 'no-paid-request', baseUrl: 'http://127.0.0.1:9', model: 'fixture' }), onEvent: () => undefined });
  const state = (await service.handle({ type: 'state' })).snapshot!, conversationId = state.conversations[0]!.id;
  cleanups.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { service, memory, host, update, recall, scope: { conversationId, companionId: DEFAULT_BOT_COMPANION_ID } };
}
it('binds manual memory operations to the actual conversation audience and never opens DSH', async () => {
  const f = await fixture();
  await expect(f.service.handle({ type: 'memory.catalog', ...f.scope, companionId: 'foreign', limit: 24 })).rejects.toThrow('没有这位伙伴');
  expect((await f.service.handle({ type: 'memory.catalog', ...f.scope, query: '知识', tag: '设计', cursor: 'stable-cursor', limit: 24 })).memory)
    .toMatchObject({ received: { query: '知识', tag: '设计', cursor: 'stable-cursor', limit: 24 } });
  expect(f.host).not.toHaveBeenCalled();
});
it('reuses the same operation ID for the same manual source versions and records immutable recovery input for pending effects', async () => {
  const f = await fixture(), input = { type: 'memory.update' as const, ...f.scope, id: 'a'.repeat(64), expectedChecksum: 'a'.repeat(32), content: '更新后的确定事实', tags: ['知识'] };
  f.update.mockResolvedValue({ state: 'pending', id: input.id, checksum: 'b'.repeat(32) });
  await f.service.handle(input); await f.service.handle(input);
  expect(f.update.mock.calls[0]![1].operationId).toBe(f.update.mock.calls[1]![1].operationId);
  const jobs = f.service.store.listPendingMemory().filter(job => job.kind === 'mutation');
  expect(jobs).toHaveLength(1); expect(jobs[0]?.payload).toMatchObject({ operation: 'update', input: { id: input.id, content: input.content } });
  expect(jobs[0]?.payload).not.toHaveProperty('apiKey');
});
it('stores bounded recall records in the current scope and clears them when memory is withdrawn', async () => {
  const f = await fixture(); await f.service.handle({ type: 'memory.recall', ...f.scope, query: '事实是什么', mode: 'passive' });
  expect((await f.service.handle({ type: 'memory.recall.records', ...f.scope })).memory).toMatchObject({ reports: [{ requestId: 'trial' }] });
  await f.service.handle({ type: 'memory.forget', ...f.scope, id: 'a'.repeat(64) });
  expect((await f.service.handle({ type: 'memory.recall.records', ...f.scope })).memory).toEqual({ reports: [] });
});
it('rejects a late inspection if a concurrent withdrawal invalidated its evidence', async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.recall.getMockImplementation()!;
  f.recall.mockImplementation(async (...args) => { await gate; return original(...args); });
  const pending = f.service.handle({ type: 'memory.recall', ...f.scope, query: '撤回中', mode: 'passive' });
  await vi.waitFor(() => expect(f.recall).toHaveBeenCalled());
  await f.service.handle({ type: 'memory.forget', ...f.scope, id: 'a'.repeat(64) }); release();
  await expect(pending).rejects.toThrow('更新或撤回');
  expect((await f.service.handle({ type: 'memory.recall.records', ...f.scope })).memory).toEqual({ reports: [] });
});

type ManagedInput = BotMemoryUpdate | BotMemoryOrganize;
type ManagedOperation = 'update' | 'organize';
afterEach(() => { vi.useRealTimers(); });

async function recoveryFixture(operation: ManagedOperation = 'update') {
  // Freeze only periodic polling. The HTTP listener and SQLite remain real;
  // the test itself durably claims the event before any scheduler can run it.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-receipt-recovery-'));
  const operationReceipt = vi.fn<BotMemoryService['operationReceipt']>(async () => ({ found: false }));
  const update = vi.fn<BotMemoryService['update']>(async () => ({ state: 'indexed' }));
  const organize = vi.fn<BotMemoryService['organize']>(async () => ({ state: 'indexed' }));
  const memory = new class extends BotMemoryService {
    override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
    override async appendHistory() { return { appended: [] }; }
    override async operationReceipt(scope: BotMemoryScope, kind: ManagedOperation, input: ManagedInput) { return operationReceipt(scope, kind, input); }
    override async update(scope: BotMemoryScope, input: BotMemoryUpdate) { return update(scope, input); }
    override async organize(scope: BotMemoryScope, input: BotMemoryOrganize) { return organize(scope, input); }
    override async close() {}
  }({ root, runtime: async () => { throw new Error('Recovery must not start VCP or DSH'); }, embedding: async () => { throw new Error('Recovery must not call a model'); } });
  const getHost = vi.fn(async () => { throw new Error('Recovery must not open a DSH Host'); });
  const service = new BotService({ root, brain: new BotDshBrain({ getHost }), brainRuntime: 'worldlinebox', memory,
    model: () => ({ apiFormat: 'openai_chat', apiKey: '', baseUrl: 'http://127.0.0.1:9', model: 'unused' }), onEvent: () => undefined });
  cleanups.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, conversation = snapshot.conversations[0]!;
  const admitted = service.store.enqueue({ conversationId: conversation.id, senderId: 'user', source: 'user', sourceMessageId: 'recovery-request', content: '更正已有事实，请保留真实来源。' });
  const claim = service.store.claim({ workerId: 'receipt-test-owner', leaseMs: 300000 });
  expect(claim?.event.id).toBe(admitted.events[0]?.id);
  const event = claim!.event, lane = service.store.getLane(event.laneId)!;
  service.store.bindEventNativeEpoch(event.id, lane.epoch);
  const call: ManagedCall = { laneId: lane.epoch === 1 ? lane.id : `${lane.id}-epoch-${lane.epoch}`, eventId: event.id,
    callId: `recover-${operation}-once`, name: `memory_${operation}`, args: { content: '单次上限更正为12分钟。', tags: ['更正', '偏好'],
      ...(operation === 'update' ? { id: 'a'.repeat(64), expectedChecksum: 'b'.repeat(32) }
        : { sources: [{ id: 'a'.repeat(64), expectedChecksum: 'b'.repeat(32) }, { id: 'c'.repeat(64), expectedChecksum: 'd'.repeat(32) }] }) } };
  const common = { operationId: `${event.id}:${call.callId}`, content: call.args.content as string, tags: '更正,偏好',
    sourceEventId: `${event.id}:${call.callId}`, sourceRootEventId: event.id, sourceMessageIds: [event.sourceMessageRecordId, event.replyMessageId] };
  const input: ManagedInput = operation === 'update' ? { ...common, id: 'a'.repeat(64), expectedChecksum: 'b'.repeat(32) }
    : { ...common, sources: [{ id: 'a'.repeat(64), expectedChecksum: 'b'.repeat(32) }, { id: 'c'.repeat(64), expectedChecksum: 'd'.repeat(32) }] };
  return { root, service, memory, getHost, operationReceipt, update, organize, event, lane, call, input,
    scope: { companionId: event.companionId, conversationId: event.conversationId, securityDomainId: event.securityDomainId } };
}

it.each([
  ['update', 'indexed'], ['update', 'pending'], ['organize', 'indexed'], ['organize', 'pending'], ['organize', 'partial'],
] as const)('reconciles the existing %s/%s VCP receipt without a new write and durably queues only unfinished work', async (operation, state) => {
  const f = await recoveryFixture(operation), receipt = { state, operationId: f.input.operationId, id: 'a'.repeat(64), checksum: 'e'.repeat(32),
    indexed: state === 'indexed', ...(operation === 'organize' ? { archived: state === 'indexed' ? ['a'.repeat(64), 'c'.repeat(64)] : [] } : {}) };
  expect(f.service.store.getMetadata(`effect:${f.event.id}:${f.call.callId}`)).toBeUndefined();
  f.operationReceipt.mockResolvedValue({ found: true, receipt });
  expect(await f.service.reconcileToolReceipt(f.call)).toEqual({ state: 'committed', result: receipt });
  expect(f.operationReceipt).toHaveBeenCalledExactlyOnceWith(f.scope, operation, f.input);
  expect(f.update).not.toHaveBeenCalled(); expect(f.organize).not.toHaveBeenCalled(); expect(f.getHost).not.toHaveBeenCalled();
  // A lost second acknowledgment uses the Main effect receipt, rather than
  // consulting or replaying a VCP write for a second time.
  expect(await f.service.reconcileToolReceipt(f.call)).toEqual({ state: 'committed', result: receipt });
  expect(f.operationReceipt).toHaveBeenCalledTimes(1);
  const { BotStore } = await import('../../src/main/companion-bot/store');
  const reopened = new BotStore(path.join(f.root, 'bot.sqlite'));
  try {
    const jobs = reopened.listPendingMemory().filter(job => job.kind === 'mutation');
    if (state === 'indexed') expect(jobs).toEqual([]);
    else {
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual({ scope: f.scope, operation, input: f.input });
      expect(jobs[0]?.status).toBe('queued');
    }
    const saved = JSON.parse(reopened.getMetadata(`effect:${f.event.id}:${f.call.callId}`)!);
    expect(saved.result).toEqual(receipt);
  } finally { reopened.close(); }
});

it('proves absence only from an explicit missing operation, while an unresolved admitted operation stays unknown', async () => {
  const f = await recoveryFixture();
  expect(await f.service.reconcileToolReceipt(f.call)).toEqual({ state: 'absent' });
  f.operationReceipt.mockResolvedValue({ found: true, receipt: { state: 'unknown', operationId: f.input.operationId } });
  expect(await f.service.reconcileToolReceipt(f.call)).toEqual({ state: 'unknown' });
  f.operationReceipt.mockResolvedValue({ found: true });
  expect(await f.service.reconcileToolReceipt(f.call)).toEqual({ state: 'unknown' });
  expect(f.operationReceipt).toHaveBeenCalledTimes(3);
  expect(f.service.store.getMetadata(`effect:${f.event.id}:${f.call.callId}`)).toBeUndefined();
  expect(f.service.store.listPendingMemory().filter(job => job.kind === 'mutation')).toEqual([]);
  expect(f.update).not.toHaveBeenCalled(); expect(f.organize).not.toHaveBeenCalled(); expect(f.getHost).not.toHaveBeenCalled();
});

it.each(['foreign-lane', 'foreign-event', 'stale-epoch', 'withdrawn-source', 'changed-acl', 'removed-member'] as const)(
  'rejects %s recovery before looking up an owner-bound VCP operation', async boundary => {
    const f = await recoveryFixture(); let call = f.call;
    f.operationReceipt.mockResolvedValue({ found: true, receipt: { state: 'indexed', operationId: f.input.operationId } });
    if (boundary === 'foreign-lane') call = { ...call, laneId: 'another-private-lane' };
    else if (boundary === 'foreign-event') call = { ...call, eventId: 'another-private-event' };
    else if (boundary === 'stale-epoch') f.service.store.rotateDomain(f.scope.companionId, f.scope.securityDomainId);
    else if (boundary === 'withdrawn-source') f.service.store.withdrawSources(f.scope.companionId, f.scope.securityDomainId, [f.event.sourceMessageRecordId]);
    else if (boundary === 'changed-acl') f.service.store.taskTransaction(sql => sql.prepare('UPDATE bot_conversations SET revision=revision+1 WHERE id=?').run(f.scope.conversationId));
    else f.service.store.taskTransaction(sql => sql.prepare('DELETE FROM bot_members WHERE conversation_id=? AND member_id=?').run(f.scope.conversationId, f.scope.companionId));
    expect(await f.service.reconcileToolReceipt(call)).toEqual({ state: 'unknown' });
    expect(f.operationReceipt).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.organize).not.toHaveBeenCalled(); expect(f.getHost).not.toHaveBeenCalled();
  });

it('rejects changed arguments against a persisted Main effect fingerprint without contacting VCP or writing again', async () => {
  const f = await recoveryFixture(), receipt = { state: 'indexed', id: 'a'.repeat(64), checksum: 'e'.repeat(32) };
  f.operationReceipt.mockResolvedValue({ found: true, receipt });
  expect(await f.service.reconcileToolReceipt(f.call)).toEqual({ state: 'committed', result: receipt });
  const changed = { ...f.call, args: { ...f.call.args, content: '不能用相同callId恢复不同事实。' } };
  await expect(f.service.reconcileToolReceipt(changed)).rejects.toThrow('回执参数不匹配');
  expect(f.operationReceipt).toHaveBeenCalledTimes(1);
  expect(f.update).not.toHaveBeenCalled(); expect(f.organize).not.toHaveBeenCalled(); expect(f.getHost).not.toHaveBeenCalled();
});
it('recovers a lost maintenance plan acknowledgement from durable admission without creating a second job or starting a model', async () => {
  const f = await recoveryFixture(), journal = new BotMaintenanceStore(f.service.store);
  const call = { ...f.call, name: 'memory_maintenance', args: { operation: 'plan', kind: 'organize' } };
  const result = journal.planTool(f.scope, 'organize', `${f.event.id}:${call.callId}`);
  expect(await f.service.reconcileToolReceipt(call)).toEqual({ state: 'committed', result });
  expect(journal.list(f.scope).items).toHaveLength(1); expect(f.getHost).not.toHaveBeenCalled(); expect(f.operationReceipt).not.toHaveBeenCalled();
  expect(await f.service.reconcileToolReceipt({ ...call, callId: 'not-admitted' })).toEqual({ state: 'absent' });
});
it('preserves a deduplicated maintenance admission after the referenced job finishes, so crash recovery cannot open a second plan', async () => {
  const f = await recoveryFixture(), journal = new BotMaintenanceStore(f.service.store), first = journal.planTool(f.scope, 'organize', 'first-request') as { job: { id: string } };
  const call = { ...f.call, name: 'memory_maintenance', args: { operation: 'plan', kind: 'dream' } };
  const result = journal.planTool(f.scope, 'dream', `${f.event.id}:${call.callId}`); expect(result).toMatchObject({ accepted: false, job: { id: first.job.id } });
  journal.progress(f.scope, first.job.id, 'completed', 'completed');
  expect(await f.service.reconcileToolReceipt(call)).toEqual({ state: 'committed', result });
  expect(journal.list(f.scope).items).toHaveLength(1); expect(f.getHost).not.toHaveBeenCalled();
  await expect(f.service.reconcileToolReceipt({ ...call, args: { operation: 'plan', kind: 'organize' } })).rejects.toThrow('参数不匹配');
});
it('executes the actual actor-bound maintenance tool as plan/status only and refuses automatic-source planning', async () => {
  const f = await recoveryFixture(), journal = new BotMaintenanceStore(f.service.store);
  const internal = f.service as unknown as { maintainSafely(): void; executeTool(event: typeof f.event, call: ManagedCall, signal: AbortSignal): Promise<unknown> };
  vi.spyOn(internal, 'maintainSafely').mockImplementation(() => undefined);
  const call = { ...f.call, name: 'memory_maintenance', args: { operation: 'plan', kind: 'dream' } };
  const result = await internal.executeTool(f.event, call, new AbortController().signal);
  expect(result).toMatchObject({ accepted: true, job: { kind: 'dream', status: 'queued' } });
  expect(journal.list(f.scope).items).toHaveLength(1); expect(journal.candidates(f.scope, journal.list(f.scope).items[0]!.id).items).toEqual([]);
  await expect(internal.executeTool({ ...f.event, source: 'world' }, { ...call, callId: 'world-plan' }, new AbortController().signal)).rejects.toThrow('用户本轮请求');
  expect(f.getHost).not.toHaveBeenCalled();
});
