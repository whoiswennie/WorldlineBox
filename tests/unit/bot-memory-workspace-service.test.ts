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
    override async operationReceipt() { return { found: false }; }
    override async update(scope: BotMemoryScope, input: BotMemoryUpdate) { return update(scope, input); }
    override async recall(scope: BotMemoryScope, input: Parameters<BotMemoryService['recall']>[1]) { return recall(scope, input); }
    override async catalog(_scope: BotMemoryScope, input: object) { return { items: [], tags: [], received: input }; }
    override async forget(_scope: BotMemoryScope, input: { id: string }) { return { forgotten: true as const, id: input.id, revision: '1', sourceEventIds: [], sourceMessageIds: [], relatedIds: [], physicalSourceErasure: false as const }; }
    override async close() {}
  }({ root, runtime: async () => { throw new Error('No fixture runtime'); }, embedding: async () => { throw new Error('No fixture model'); } });
  const host = vi.fn(async () => { throw new Error('DSH must not be used for memory management'); });
  const service = new BotService({ root, brain: new BotDshBrain({ getHost: host }), memory,
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
    override async operationReceipt(scope: BotMemoryScope, kind: ManagedOperation, input: ManagedInput, signal?: AbortSignal) { return operationReceipt(scope, kind, input, signal); }
    override async update(scope: BotMemoryScope, input: BotMemoryUpdate) { return update(scope, input); }
    override async organize(scope: BotMemoryScope, input: BotMemoryOrganize) { return organize(scope, input); }
    override async close() {}
  }({ root, runtime: async () => { throw new Error('Recovery must not start VCP or DSH'); }, embedding: async () => { throw new Error('Recovery must not call a model'); } });
  const getHost = vi.fn(async () => { throw new Error('Recovery must not open a DSH Host'); });
  const service = new BotService({ root, brain: new BotDshBrain({ getHost }), memory,
    model: () => ({ apiFormat: 'openai_chat', apiKey: '', baseUrl: 'http://127.0.0.1:9', model: 'unused' }), onEvent: () => undefined });
  cleanups.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  vi.spyOn(service as unknown as { maintainSafely(): void }, 'maintainSafely').mockImplementation(() => undefined);
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, conversation = snapshot.conversations[0]!;
  const admitted = service.store.enqueue({ conversationId: conversation.id, senderId: 'user', source: 'user', sourceMessageId: 'recovery-request', content: '更正已有事实，请保留真实来源。' });
  const claim = service.store.claim({ workerId: 'receipt-test-owner', leaseMs: 300000 });
  expect(claim?.event.id).toBe(admitted.events[0]?.id);
  const event = claim!.event, lane = service.store.getLane(event.laneId)!;
  service.store.bindEventNativeEpoch(event.id, lane.epoch);
  const call: ManagedCall = { laneId: `turn-${event.id}`, eventId: event.id,
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

const nativeTool = (service: BotService, call: ManagedCall) => (service as unknown as { tool(call: ManagedCall, signal: AbortSignal): Promise<unknown> }).tool(call, new AbortController().signal);
it.each([
  ['update', 'indexed'], ['update', 'pending'], ['organize', 'indexed'], ['organize', 'pending'], ['organize', 'partial'],
] as const)('recovers %s/%s VCP receipts through the native callback without a duplicate write', async (operation, state) => {
  const f = await recoveryFixture(operation), receipt = { state, operationId: f.input.operationId, id: 'a'.repeat(64), checksum: 'e'.repeat(32) };
  f.operationReceipt.mockResolvedValue({ found: true, receipt });
  expect(await nativeTool(f.service, f.call)).toEqual(receipt);
  expect(f.operationReceipt).toHaveBeenCalledExactlyOnceWith(f.scope, operation, f.input, expect.any(AbortSignal));
  expect(f.update).not.toHaveBeenCalled(); expect(f.organize).not.toHaveBeenCalled(); expect(f.getHost).not.toHaveBeenCalled();
  expect(await nativeTool(f.service, f.call)).toEqual(receipt); expect(f.operationReceipt).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(f.service.store.getMetadata(`effect:${f.event.id}:${f.call.callId}`)!); expect(saved.result).toEqual(receipt);
  const jobs = f.service.store.listPendingMemory().filter(job => job.kind === 'mutation');
  expect(jobs).toHaveLength(state === 'indexed' ? 0 : 1);
  if (state !== 'indexed') expect(jobs[0]!.payload).toEqual({ scope: f.scope, operation, input: f.input });
});

it('writes only after explicit receipt absence and recovers a durable mutation whose response was lost', async () => {
  const f = await recoveryFixture(), receipt = { state: 'indexed', operationId: f.input.operationId };
  f.operationReceipt.mockResolvedValueOnce({ found: false }).mockResolvedValue({ found: true, receipt });
  f.update.mockRejectedValue(new Error('callback response lost'));
  expect(await nativeTool(f.service, f.call)).toEqual(receipt); expect(f.update).toHaveBeenCalledOnce();
  expect(await nativeTool(f.service, f.call)).toEqual(receipt); expect(f.update).toHaveBeenCalledOnce();
});

it.each([{ found: true, receipt: { state: 'unknown' } }, { found: true }, {}])('fences unresolved VCP mutation results before any replacement write: %j', async proof => {
  const f = await recoveryFixture(); f.operationReceipt.mockResolvedValue(proof);
  await expect(nativeTool(f.service, f.call)).rejects.toThrow('尚未确认');
  expect(f.update).not.toHaveBeenCalled(); expect(f.organize).not.toHaveBeenCalled();
  expect(f.service.store.getMetadata(`effect:${f.event.id}:${f.call.callId}`)).toBeUndefined();
});

it.each(['foreign-lane', 'foreign-event', 'stale-epoch', 'withdrawn-source', 'changed-acl', 'removed-member'] as const)(
  'rejects %s native callbacks before reading a VCP operation', async boundary => {
    const f = await recoveryFixture(); let call = f.call;
    if (boundary === 'foreign-lane') call = { ...call, laneId: 'another-private-lane' };
    else if (boundary === 'foreign-event') call = { ...call, eventId: 'another-private-event' };
    else if (boundary === 'stale-epoch') f.service.store.rotateDomain(f.scope.companionId, f.scope.securityDomainId);
    else if (boundary === 'withdrawn-source') f.service.store.withdrawSources(f.scope.companionId, f.scope.securityDomainId, [f.event.sourceMessageRecordId]);
    else if (boundary === 'changed-acl') f.service.store.taskTransaction(sql => sql.prepare('UPDATE bot_conversations SET revision=revision+1 WHERE id=?').run(f.scope.conversationId));
    else f.service.store.taskTransaction(sql => sql.prepare('DELETE FROM bot_members WHERE conversation_id=? AND member_id=?').run(f.scope.conversationId, f.scope.companionId));
    await expect(nativeTool(f.service, call)).rejects.toThrow();
    expect(f.operationReceipt).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.organize).not.toHaveBeenCalled();
  });

it('rejects changed arguments against the native callback effect receipt without a second VCP write', async () => {
  const f = await recoveryFixture(), receipt = { state: 'indexed', operationId: f.input.operationId };
  f.operationReceipt.mockResolvedValue({ found: true, receipt }); expect(await nativeTool(f.service, f.call)).toEqual(receipt);
  await expect(nativeTool(f.service, { ...f.call, args: { ...f.call.args, content: '换成另一个事实' } })).rejects.toThrow('其他参数');
  expect(f.operationReceipt).toHaveBeenCalledTimes(1); expect(f.update).not.toHaveBeenCalled();
});

it('keeps native maintenance plan admission idempotent after an accepted callback', async () => {
  const f = await recoveryFixture(), journal = new BotMaintenanceStore(f.service.store);
  const call = { ...f.call, name: 'memory_maintenance', args: { operation: 'plan', kind: 'dream' } };
  const result = await nativeTool(f.service, call); expect(await nativeTool(f.service, call)).toEqual(result);
  expect(journal.list(f.scope).items).toHaveLength(1); expect(f.getHost).not.toHaveBeenCalled();
});

it('executes the actual actor-bound maintenance tool as plan/status only and refuses automatic-source planning', async () => {
  const f = await recoveryFixture(), journal = new BotMaintenanceStore(f.service.store);
  const internal = f.service as unknown as { maintainSafely(): void; executeTool(event: typeof f.event, call: ManagedCall, signal: AbortSignal): Promise<unknown> };
  vi.spyOn(internal, 'maintainSafely').mockImplementation(() => undefined);
  const call = { ...f.call, name: 'memory_maintenance', args: { operation: 'plan', kind: 'dream' } };
  const result = await internal.executeTool(f.event, call, new AbortController().signal);
  expect(result).toMatchObject({ accepted: true, job: { kind: 'dream', status: 'queued' } });
  expect(journal.list(f.scope).items).toHaveLength(1); expect(journal.candidates(f.scope, journal.list(f.scope).items[0]!.id).items).toEqual([]);
  await expect(internal.executeTool({ ...f.event, source: 'world' }, { ...call, callId: 'world-plan' }, new AbortController().signal)).rejects.toThrow(/请求|失效/u);
  expect(f.getHost).not.toHaveBeenCalled();
});
