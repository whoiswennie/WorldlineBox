import { afterEach, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BotService } from '../../src/main/companion-bot/service';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain, BotDshDeliveryUnknownError, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { NativeHostClient } from '../../src/main/dsh/native-host-client';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

// These tests use the actual durable store, Service, worker adapter and
// authenticated HTTP transport. Only the remote Host/provided chat responses
// are boundaries; no native process, production state or paid provider is used.
type Row = Record<string, unknown>;
type Wire = { path: string; body: Row };
type Reply = { status?: number; body: Row };
const owned: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of owned.splice(0).reverse()) await close(); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw Error('Cancellation regression condition timed out.'); await delay(20); }
}
async function hostBoundary() {
  const calls: Wire[] = [], token = 'c'.repeat(64);
  let handler = async (call: Wire): Promise<Reply> => ({ body: { accepted: false, absent: true, sessionId: call.body.sessionId, eventId: call.body.eventId } });
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const call = { path: request.url!, body: JSON.parse(text || '{}') as Row }; calls.push(call);
    const reply = call.path === '/bot/cancel' ? await handler(call)
      : { status: 503, body: { error: 'Legacy fixture: worker_chat_send_file is agent-local and cannot be restored as a global tool.' } };
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No cancellation fixture port.');
  const client = new NativeHostClient(address.port, token, process.pid);
  owned.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { client, calls, handle: (next: typeof handler) => { handler = next; } };
}
class MemoryBoundary extends BotMemoryService {
  private readonly prepared = new Map<string, BotMemoryPrepared>();
  constructor(root: string) { super({ root, runtime: async () => { throw Error('Unexpected VCP startup in cancellation regression.'); }, embedding: async () => { throw Error('Unexpected embedding inference.'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    const value: BotMemoryPrepared = { requestId: input.requestId, scope: input.scope, inputHash: 'cancellation-boundary', messages: input.messages,
      metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
    this.prepared.set(input.requestId, value); return value;
  }
  override async resumePrepared(input: Parameters<BotMemoryService['resumePrepared']>[0]) { return this.prepared.get(input.requestId)!; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { appended: [] }; }
}
class AppBoundary extends BotDshBrain {
  calls: BotDshRun[] = [];
  constructor() { super({ getHost: async () => { throw Error('App reply must not open a native Host.'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    this.calls.push(input);
    return { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', text: input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : '已收到真实任务状态。' };
  }
  override async archive() {}
  override async close() {}
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-task-cancel-regression-'));
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-task-cancel-regression-')) throw Error('Unexpected cancellation regression profile.');
  const host = await hostBoundary(), app = new AppBoundary(), worker = new BotDshBrain({ getHost: async () => ({ client: host.client }) });
  const service = new BotService({ root, brainRuntime: 'worldlinebox', memory: new MemoryBoundary(path.join(root, 'memory')), brain: new BotBrainRouter({ app, worker }),
    model: () => ({ apiFormat: 'openai_chat', model: 'unused-boundary', apiKey: 'not-a-real-provider-key', baseUrl: 'http://127.0.0.1:9' }), onEvent: () => undefined });
  owned.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  const initial = (await service.handle({ type: 'state' })).snapshot!, room = initial.conversations.find(value => value.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
  let sequence = 0;
  const task = (extra: Row = {}, conversationId = room.id) => {
    const source = service.store.enqueue({ conversationId, source: 'user', senderId: 'user', recipientIds: [DEFAULT_BOT_COMPANION_ID], sourceMessageId: `cancellation-source-${++sequence}`, content: '只处理这个隔离测试任务。' }).events[0]!;
    const claim = service.store.claim({ workerId: 'human-authored-cancellation-source' });
    if (!claim || claim.event.id !== source.id || !service.store.settle({ eventId: source.id, leaseToken: claim.leaseToken, status: 'done', content: '已保留测试来源。' })) throw Error('Could not settle the isolated source before scheduling.');
    return service.store.createTask({ conversationId, companionId: DEFAULT_BOT_COMPANION_ID, sourceEventId: source.id, goal: 'Never replay this legacy user task prompt.',
      extra: { workerAccess: 'full', nativeAttempted: true, retryAt: Date.now() + 60000, ...extra } });
  };
  const stop = (id: string, requestId = 'stop-once') => service.handle({ type: 'task.control', conversationId: room.id, taskId: id, operation: 'cancel', requestId });
  return { root, service, host, worker, app, room, task, stop };
}

it('reconciles a 512-minute attempted task through the lightweight Host proof without reattaching legacy tools or disturbing another shared lane', async () => {
  const f = await fixture(), old = f.task({ retryAttempts: 1024 });
  const oldStamp = new Date(Date.now() - 512 * 60000).toISOString();
  f.service.store.taskTransaction(sql => sql.prepare('UPDATE bot_tasks SET created_at=?,updated_at=? WHERE id=?').run(oldStamp, oldStamp, old.id));
  const foreign = f.service.store.createGroup({ title: 'Other shared Host lane', memberIds: [DEFAULT_BOT_COMPANION_ID] }), unrelated = f.task({}, foreign.id);
  f.service.store.updateTask(unrelated.id, { status: 'running' });
  await f.stop(old.id); await until(() => f.service.store.getTask(old.id)?.status === 'cancelled');
  await f.stop(old.id, 'stop-again'); await until(() => f.host.calls.length === 1);
  expect(f.host.calls).toHaveLength(1); expect(f.host.calls[0]!.path).toBe('/bot/cancel');
  const body = f.host.calls[0]!.body;
  expect(Object.keys(body).sort()).toEqual(['cwd', 'eventId', 'laneId', 'role', 'sessionId']);
  expect(body).toMatchObject({ laneId: `worker-${old.id}`, eventId: `work-${old.id}`, sessionId: BotDshBrain.sessionId(`worker-${old.id}`), role: 'worker' });
  expect(JSON.stringify(f.host.calls)).not.toContain('Never replay');
  expect(f.service.store.getTask(unrelated.id)).toMatchObject({ status: 'running' });
  expect(f.service.store.getTask(unrelated.id)!.extra.cancelRequested).not.toBe(true);
  expect(f.service.store.listTasks()).toHaveLength(2); expect(f.app.calls.some(call => call.role === 'worker')).toBe(false);
});

it('does not turn unresolved admission or a mismatched absence identity into a successful cancellation', async () => {
  const host = await hostBoundary(), brain = new BotDshBrain({ getHost: async () => ({ client: host.client }) }); owned.push(() => brain.close());
  const input = { laneId: 'worker-pending-receipt', eventId: 'work-pending-receipt', cwd: path.join(os.tmpdir(), 'cancellation-no-write'), role: 'worker' as const,
    system: 'Legacy cancellation only.', model: { apiFormat: 'openai_chat' as const, model: 'cancel-only', apiKey: 'cancel-only', baseUrl: 'http://127.0.0.1:1' }, tools: [], callback: { url: 'http://127.0.0.1:1/bot/tool', token: 'd'.repeat(64) } };
  host.handle(async () => ({ body: { requiresAttachment: true } }));
  await expect(brain.cancelDurable(input)).rejects.toBeInstanceOf(BotDshDeliveryUnknownError);
  expect(host.calls.map(call => call.path)).toEqual(['/bot/cancel', '/bot/lanes']);
  expect(host.calls.some(call => call.path.endsWith('/turn'))).toBe(false);
  host.calls.length = 0;
  host.handle(async call => ({ body: { accepted: false, absent: true, sessionId: 'another-session', eventId: call.body.eventId } }));
  await expect(brain.cancelDurable(input)).rejects.toBeInstanceOf(BotDshDeliveryUnknownError);
  expect(host.calls.map(call => call.path)).toEqual(['/bot/cancel']);
});

it('stops immediately with no model replay, freezes the first stop time, and bounds background native cleanup', async () => {
  const f = await fixture(), old = f.task(), neverAdmitted = f.task({ nativeAttempted: false });
  const effects = new BotTaskRuntime(f.service.store);
  effects.startEffect(old, { callId: 'legacy-pending-effect', toolName: 'bash', argsHash: createHash('sha256').update('unconfirmed operation').digest('hex'), argumentsPreview: 'Unconfirmed effect must remain visible.' });
  f.host.handle(async () => ({ status: 503, body: { error: 'The shared Host is unavailable.' } }));
  const batch = { type: 'task.queue.control' as const, conversationId: f.room.id, operation: 'cancel_queued' as const, requestId: 'original-batch' };
  expect((await f.service.handle(batch)).memory).toMatchObject({ affected: 2, cancelled:2, pending:0,blocked:0 });
  expect(f.service.store.getTask(old.id)?.status).toBe('cancelled');
  expect(f.service.store.getTask(neverAdmitted.id)?.status).toBe('cancelled');
  const state = () => f.service.store.getTask(old.id)!.extra.executorControl as {state:string;attempts:number;retryAt:number};
  await until(() => state().attempts >= 1);
  const firstStop = f.service.store.getTask(old.id)!.extra.cancelRequestedAt;
  for (const count of [2, 3]) {
    const current = f.service.store.getTask(old.id)!;
    f.service.store.updateTask(old.id, { extra: {...current.extra,executorControl:{...state(),retryAt:0}} });
    await until(() => state().attempts >= count);
  }
  expect(state().state).toBe('unavailable');
  expect(f.service.store.getTask(old.id)).toMatchObject({status:'cancelled',extra:{cancelRequested:true,cancelRequestedAt:firstStop,progress:{phase:'cancelled'}}});
  expect(effects.pendingEffects(old.id)).toMatchObject([{callId:'legacy-pending-effect'}]);
  const count=f.host.calls.length; await delay(1200); expect(f.host.calls).toHaveLength(count);
  const later=f.task({nativeAttempted:false});
  expect((await f.service.handle(batch)).memory).toMatchObject({affected:2,cancelled:2});
  expect(f.service.store.getTask(later.id)!.extra.cancelRequested).not.toBe(true);
  expect(f.service.store.pendingTasks().map(task=>task.id)).not.toContain(old.id);
  expect(f.host.calls.every(call=>call.path==='/bot/cancel')).toBe(true);
});

it('clears a stopped task immediately while its background native cancellation retains the original workspace and cannot restore the record', async () => {
  const f = await fixture(), task = f.task({ workspaceLayout: 'companion-v1' });
  let release!: (value: Reply) => void;
  f.host.handle(() => new Promise<Reply>(resolve => { release = resolve; }));
  await f.stop(task.id); expect(f.service.store.getTask(task.id)?.status).toBe('cancelled');
  await until(() => f.host.calls.length === 1);
  const removed = await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: task.id, operation: 'remove', requestId: 'remove-before-native-ack' });
  expect(removed.memory).toMatchObject({ cleared: 1 });
  expect(f.service.store.getTask(task.id)!.extra.removedAt).toBeTruthy();
  release({ status: 503, body: { error: 'Dropped first native shutdown receipt.' } });
  const control = () => f.service.store.getTask(task.id)!.extra.executorControl as { state: string; attempts: number; retryAt: number };
  await until(() => control().attempts === 1);
  f.host.handle(async call => ({ body: { accepted: false, absent: true, sessionId: call.body.sessionId, eventId: call.body.eventId } }));
  const current = f.service.store.getTask(task.id)!;
  f.service.store.updateTask(task.id, { extra: { ...current.extra, executorControl: { ...control(), retryAt: 0 } } });
  await until(() => control().state === 'acknowledged');
  expect(f.host.calls).toHaveLength(2);
  expect(f.host.calls[0]!.body.cwd).toBe(f.host.calls[1]!.body.cwd);
  expect(String(f.host.calls[1]!.body.cwd)).toContain(path.join('workspaces', createHash('sha256').update(task.companionId).digest('hex')));
  expect(f.service.store.getTask(task.id)).toMatchObject({ status: 'cancelled', goal: '', extra: { removedAt: expect.any(String) } });
  expect(f.service.store.listTaskCatalog({ conversationId: f.room.id, view: 'directory' })).toEqual([]);
  expect(f.app.calls.some(call => call.role === 'worker')).toBe(false);
});
