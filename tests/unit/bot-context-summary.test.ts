import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import type { BotBrainRequestMetrics } from '../../src/shared/companion-bot-context';
import type { BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotService } from '../../src/main/companion-bot/service';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const store = new BotStore(':memory:', { activityBudget: { maxTasks: 1000, maxPendingTasks: 1000 } });
  cleanup.push(async () => store.close());
  store.createCompanion({ id: 'alice', name: 'Alice', persona: '公开设定' }); store.createCompanion({ id: 'bob', name: 'Bob', persona: '公开设定' });
  return { store, room: store.openDirect('alice'), tasks: new BotTaskRuntime(store) };
}
function metric(input: Partial<BotBrainRequestMetrics> = {}): BotBrainRequestMetrics {
  return { requestId: 'request-1', purpose: 'reply', measuredAt: '2026-11-04T04:00:00.000Z', phase: 'prepared', model: 'local-model',
    window: 65536, windowSource: 'explicit', inputTokensUpperBound: 1200, estimateMethod: 'utf8-byte-upper-bound', reservedOutputTokens: 4096,
    framingReserveTokens: 256, remainingTokensLowerBound: 59984, messageCount: 3, toolDefinitionCount: 8, ...input };
}

it('projects only numeric latest-request evidence for the visible current room and rejects stale epochs or cancelled/ACL-revoked admissions', () => {
  const { store, room } = fixture(), peer = store.openDirect('bob');
  const current = store.enqueue({ conversationId: room.id, senderId: 'user', content: 'CURRENT_SOURCE_NOT_IN_DTO', sourceMessageId: 'current' }).events[0]!;
  const other = store.enqueue({ conversationId: peer.id, senderId: 'user', content: 'PRIVATE_ROOM_NOT_IN_DTO', sourceMessageId: 'other' }).events[0]!;
  const claim = store.claim({ workerId: 'summary' })!; expect(claim.event.id).toBe(current.id);
  expect(store.brainContextSummaries(room.id).alice!.lastRequest).toBeUndefined();
  expect(store.recordBrainContext(current.id, 1, metric())).toBe(true);
  expect(store.recordBrainContext(current.id, 2, metric())).toBe(false);
  expect(store.recordBrainContext(other.id, 1, metric())).toBe(false);
  const first = store.brainContextSummaries(room.id, () => 'waiting-model');
  expect(first.alice).toMatchObject({ conversationId: room.id, epoch: 1, runningMessages: 1, queuedMessages: 0, phase: 'waiting-model', lastRequest: metric() });
  expect(first.bob).toBeUndefined(); expect(JSON.stringify(first)).not.toMatch(/CURRENT_SOURCE|PRIVATE_ROOM/);
  expect(store.recordBrainContext(current.id, 1, metric({ requestId: 'compact-1', purpose: 'compaction' }))).toBe(true);
  expect(store.recordBrainContext(current.id, 1, metric({ requestId: 'compact-1', purpose: 'compaction', phase: 'finished', reportedUsage: { inputTokens: 19, outputTokens: 4 } }))).toBe(true);
  expect(store.brainContextSummaries(room.id).alice!.compactionRequests).toBe(1);
  expect(store.recordBrainContext(current.id, 1, metric({ requestId: 'reply-2', inputTokensUpperBound: 50, reportedUsage: { inputTokens: 7 } }))).toBe(true);
  expect(store.brainContextSummaries(room.id).alice!.lastRequest!.reportedUsage!.inputTokens).toBe(7);
  expect(store.brainContextSummaries(room.id).alice!.compactionRequests).toBe(1);
  store.cancelEvent(current.id); expect(store.recordBrainContext(current.id, 1, metric())).toBe(false);
  store.taskTransaction(sql => { sql.prepare('UPDATE bot_lanes SET epoch=2 WHERE id=?').run(current.laneId); });
  expect(store.brainContextSummaries(room.id).alice!.lastRequest).toBeUndefined();
  expect(store.brainContextSummaries(room.id).alice!.compactionRequests).toBe(0);
  store.cancelEvent(other.id);
  const group = store.createGroup({ title: '可撤权群', memberIds: ['alice', 'bob'] });
  const revoked = store.enqueue({ conversationId: group.id, senderId: 'user', recipientIds: ['alice'], content: 'revoke', sourceMessageId: 'revoked' }).events[0]!;
  expect(store.claim({ workerId: 'revoked' })!.event.id).toBe(revoked.id);
  store.updateMembers(group.id, ['bob']);
  expect(store.recordBrainContext(revoked.id, 1, metric())).toBe(false);
  store.taskTransaction(sql => { sql.prepare("DELETE FROM bot_members WHERE conversation_id=? AND member_id='user'").run(room.id); });
  expect(store.brainContextSummaries(room.id)).toEqual({});
});

class LocalMemory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, inputHash: 'test', scope: input.scope, messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async close() {}
}

it('publishes live App request metadata through actual Service snapshots without starting DSH/memory inference or showing another room', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-context-metrics-')), host = vi.fn(async () => { throw Error('No DSH'); });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const app = new BotAppBrain({ root: path.join(root, 'router'), fetchFn: async () => {
    requests++; await held; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '你好呀。' } }], usage: { prompt_tokens: 123, completion_tokens: 4, total_tokens: 127 } });
  } });
  const worker = new BotDshBrain({ getHost: host }), memory = new LocalMemory({ root: path.join(root, 'memory'), runtime: async () => { throw Error('No VCP'); }, embedding: async () => { throw Error('No embedding'); } });
  const service = new BotService({ root, brainRuntime: 'worldlinebox', brain: new BotBrainRouter({ app, worker }), memory,
    model: () => ({ apiFormat: 'openai_chat', model: 'local-snapshot-model', baseUrl: 'http://127.0.0.1:1', apiKey: 'LOCAL_ONLY', maxTokens: 300, contextWindow: 65536 }), onEvent: () => undefined });
  cleanup.push(async () => { release(); await service.shutdown(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-context-metrics-')) throw Error('Invalid service metrics cleanup.'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' });
  service.store.createCompanion({ id: 'alice', name: 'Alice', persona: '当前伙伴' }); service.store.createCompanion({ id: 'bob', name: 'Bob', persona: '另一伙伴' });
  const room = service.store.openDirect('alice'), other = service.store.openDirect('bob');
  await service.handle({ type: 'message.send', conversationId: room.id, requestId: 'real-context', content: '你好' });
  const until = async (check: () => boolean) => { const deadline = Date.now() + 10000; while (!check()) { if (Date.now() > deadline) throw Error('Live summary did not settle.'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  await until(() => requests === 1);
  const live = (await service.handle({ type: 'state', conversationId: room.id })).snapshot!;
  expect(live.brainContexts!.alice!.lastRequest).toMatchObject({ purpose: 'reply', phase: 'prepared', window: 65536 });
  expect(live.brainContexts!.alice!.runningMessages).toBe(1); expect(live.brainContexts!.alice!.lastRequest!.reportedUsage).toBeUndefined();
  expect(live.taskSummary).toEqual({ items: [], activeCount: 0, queuedCount: 0 });
  expect((await service.handle({ type: 'state', conversationId: other.id })).snapshot!.brainContexts).toEqual({});
  expect(requests).toBe(1); release();
  await until(() => service.store.brainContextSummaries(room.id).alice?.lastRequest?.phase === 'finished');
  const finished = (await service.handle({ type: 'state', conversationId: room.id })).snapshot!.brainContexts!.alice!.lastRequest!;
  expect(finished.reportedUsage).toEqual({ inputTokens: 123, outputTokens: 4, totalTokens: 127 }); expect(requests).toBe(1); expect(host).not.toHaveBeenCalled();
});

it('keeps task summary bounded, active-first and queued FIFO beyond 100 newer terminal records, with truthful first-running timestamps', () => {
  const { store, room, tasks } = fixture();
  const source = store.enqueue({ conversationId: room.id, senderId: 'user', content: 'test source', sourceMessageId: 'task-summary' }).events[0]!;
  const make = (id: string) => store.createTask({ id, conversationId: room.id, companionId: 'alice', sourceEventId: source.id, goal: `工作 ${id}`, extra: { workerPrompt: 'FROZEN_FULL_BODY'.repeat(5000) } });
  const queued = [make('queued-a'), make('queued-b'), make('queued-c'), make('queued-d'), make('queued-e')];
  for (const [index, task] of queued.entries()) store.taskTransaction(sql => { sql.prepare('UPDATE bot_tasks SET created_at=? WHERE id=?').run(`2026-11-01T01:00:0${index}.000Z`, task.id); });
  const running = make('running'); store.updateTask(running.id, { status: 'running' });
  const started = store.getTask(running.id)!.extra.presenceStartedAt;
  store.updateTask(running.id, { extra: { ...store.getTask(running.id)!.extra, progress: { phase: 'using-tool', updatedAt: '2026-11-04T04:00:00.000Z' } } });
  store.taskTransaction(sql => { sql.prepare('UPDATE bot_tasks SET updated_at=? WHERE id=?').run('2026-11-04T04:10:00.000Z', running.id); });
  for (let index = 0; index < 105; index++) { const task = make(`finished-${index}`); store.updateTask(task.id, { status: 'succeeded', summary: 'LARGE_FULL_REPORT'.repeat(5000) }); }
  const fullRead = vi.spyOn(store, 'getTask').mockImplementation(() => { throw Error('Summary must never read full tasks.'); });
  const legacyRead = vi.spyOn(store, 'listTasks').mockImplementation(() => { throw Error('Summary must not use the recent-100 catalogue.'); });
  const summary = tasks.summary(room.id)!;
  expect(summary.activeCount).toBe(6); expect(summary.queuedCount).toBe(5);
  expect(summary.items.map(task => task.id)).toEqual(['running', 'queued-a', 'queued-b', 'queued-c', 'queued-d']);
  expect(summary.items[0]!.startedAt).toBe(started); expect(summary.items[0]!.startedAt).not.toBe(summary.items[0]!.updatedAt);
  expect(summary.items[1]!.startedAt).toBeUndefined(); expect(summary.items.every(task => task.summary === undefined)).toBe(true);
  expect(JSON.stringify(summary)).not.toMatch(/FROZEN_FULL_BODY|LARGE_FULL_REPORT/); expect(JSON.stringify(summary).length).toBeLessThan(6000);
  expect(fullRead).not.toHaveBeenCalled(); expect(legacyRead).not.toHaveBeenCalled(); fullRead.mockRestore(); legacyRead.mockRestore();
});

it('measures each real App request after context preparation and keeps provider usage per request instead of adding turn totals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-context-metrics-')), requests: string[] = [], metrics: BotBrainRequestMetrics[] = [];
  let calls = 0;
  const brain = new BotAppBrain({ root, fetchFn: async (_url, init) => {
    requests.push(String(init!.body)); calls++;
    return Response.json({ choices: [{ finish_reason: calls === 1 ? 'tool_calls' : 'stop', message: calls === 1
      ? { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'memory_search', arguments: '{}' } }] } : { content: '完成。' } }],
    usage: { prompt_tokens: calls === 1 ? 20 : 7, completion_tokens: 3, total_tokens: calls === 1 ? 23 : 10 } });
  }, callTool: async () => ({ result: 'CONFIRMED_RECEIPT' }) });
  cleanup.push(async () => { await brain.close(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-context-metrics-')) throw Error('Invalid metrics cleanup.'); await rm(root, { recursive: true, force: true }); });
  const input: BotDshRun = { laneId: 'scope-lane', eventId: 'turn-1', role: 'brain', cwd: root, system: 'PRIVATE_SYSTEM_NOT_IN_METRICS', prompt: 'CURRENT_TRIGGER_NOT_IN_METRICS',
    model: { apiFormat: 'openai_chat', model: 'local-protocol-fixture', baseUrl: 'http://127.0.0.1:1', apiKey: 'NO_PROVIDER_KEY_IN_METRICS', contextWindow: 32768, contextWindowSource: 'metadata', maxTokens: 300 },
    tools: [{ name: 'memory_search', description: 'query', parameters: { type: 'object', properties: {} } }], callback: { url: 'http://127.0.0.1:1/bot/tool', token: 'NO_CALLBACK_KEY_IN_METRICS' },
    onEvent: event => { if (event.contextMetrics) metrics.push(event.contextMetrics); } };
  await brain.run(input);
  expect(requests).toHaveLength(2); expect(metrics).toHaveLength(4);
  for (const [index, request] of requests.entries()) {
    const prepared = metrics[index * 2]!, finished = metrics[index * 2 + 1]!, body = JSON.parse(request) as { messages: unknown[]; tools: unknown[]; max_tokens: number };
    expect(prepared.inputTokensUpperBound).toBe(Buffer.byteLength(request, 'utf8'));
    expect(prepared.windowSource).toBe('metadata');
    expect(prepared.messageCount).toBe(body.messages.length); expect(prepared.toolDefinitionCount).toBe(body.tools.length);
    expect(prepared.remainingTokensLowerBound).toBe(32768 - Buffer.byteLength(request, 'utf8') - body.max_tokens - 256);
    expect(prepared.reportedUsage).toBeUndefined(); expect(finished.requestId).toBe(prepared.requestId); expect(finished.phase).toBe('finished');
  }
  expect(metrics[3]!.reportedUsage).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  expect(metrics[3]!.requestId).not.toBe(metrics[1]!.requestId);
  expect(JSON.stringify(metrics)).not.toMatch(/PRIVATE_SYSTEM|CURRENT_TRIGGER|NO_PROVIDER_KEY|NO_CALLBACK_KEY|CONFIRMED_RECEIPT/);
});

it('counts only untouched queued tasks as pending work and keeps stop/pause verification ahead of a larger ordinary FIFO queue', () => {
  const { store, room, tasks } = fixture();
  const source = store.enqueue({ conversationId: room.id, senderId: 'user', content: 'source', sourceMessageId: 'controlled-queue' }).events[0]!;
  for (let index = 0; index < 10; index++) {
    const task = store.createTask({ id: `ordinary-${index}`, conversationId: room.id, companionId: 'alice', sourceEventId: source.id, goal: '普通待办' });
    store.taskTransaction(sql => { sql.prepare('UPDATE bot_tasks SET created_at=? WHERE id=?').run(`2026-11-01T01:00:${String(index).padStart(2, '0')}.000Z`, task.id); });
  }
  const stop = store.createTask({ id: 'stop-verification', conversationId: room.id, companionId: 'alice', sourceEventId: source.id, goal: '旧任务停止待核实',
    extra: { nativeAttempted: true, cancelRequested: true, cancelRecoveryPaused: true, progress: { phase: 'stop-unconfirmed' } } });
  const pause = store.createTask({ id: 'pause-verification', conversationId: room.id, companionId: 'alice', sourceEventId: source.id, goal: '旧任务暂停待核实',
    extra: { nativeAttempted: true, pauseRequested: true, pauseRecoveryPaused: true, progress: { phase: 'pause-unconfirmed' } } });
  store.taskTransaction(sql => { sql.prepare('UPDATE bot_tasks SET updated_at=? WHERE id=?').run('2026-11-04T05:00:01.000Z', stop.id);
    sql.prepare('UPDATE bot_tasks SET updated_at=? WHERE id=?').run('2026-11-04T05:00:00.000Z', pause.id); });
  const summary = tasks.summary(room.id)!;
  expect(summary.activeCount).toBe(12); expect(summary.queuedCount).toBe(10);
  expect(summary.items.map(task => task.id)).toEqual([stop.id, pause.id, 'ordinary-0', 'ordinary-1', 'ordinary-2']);
  expect(summary.items[0]).toMatchObject({ status: 'queued', cancelRequested: true, progress: { phase: 'stop-unconfirmed' } });
  expect(summary.items[1]).toMatchObject({ status: 'queued', pauseRequested: true, progress: { phase: 'pause-unconfirmed' } });
  // The established history-page count is deliberately a different contract.
  expect(tasks.page({ conversationId: room.id, filter: 'all', page: 0, limit: 6 }).queuedCount).toBe(12);
});
