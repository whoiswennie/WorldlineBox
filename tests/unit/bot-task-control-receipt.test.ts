import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BotService } from '../../src/main/companion-bot/service';
import { BotCompanionRuntime } from '../../src/main/companion-bot/companion-runtime';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTaskRuntime, type BotTaskControlInput } from '../../src/main/companion-bot/task-runtime';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';
import type { BotEvent, BotTask } from '../../src/main/companion-bot/types';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
type Controller = {
  executeTool(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<unknown>;
  controlTask(task: BotTask, operation: 'cancel' | 'pause' | 'resume_paused' | 'continue' | 'send' | 'answer' | 'remove', text: string | undefined, requestId: string, input: Omit<BotTaskControlInput, 'requestId' | 'text'>): Promise<unknown>;
  controlQueue(conversationId: string, operation: 'cancel_all' | 'cancel_queued' | 'clear_finished', requestId: string, companionId: string): Promise<unknown>;
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-task-control-receipt-')), store = new BotStore(path.join(root, 'bot.sqlite'));
  closes.push(async () => { store.close(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-task-control-receipt-')) throw Error('Invalid owned receipt fixture'); await rm(root, { recursive: true, force: true }); });
  store.createCompanion({ id: 'alice', name: 'Alice', persona: '当前伙伴' }); store.createCompanion({ id: 'bob', name: 'Bob', persona: '另一位伙伴' });
  const room = store.openDirect('alice'), admitted = store.enqueue({ conversationId: room.id, senderId: 'user', source: 'user', sourceMessageId: 'original-control', content: '管理当前任务。' });
  const claim = store.claim({ workerId: 'receipt-owner', leaseMs: 300000 }); expect(claim?.event.id).toBe(admitted.events[0]!.id);
  const event = claim!.event; store.bindEventNativeEpoch(event.id, 1);
  const runtime = new BotTaskRuntime(store), toolRuns = new Map<string, unknown>();
  // Exercise the real task controller and public receipt reader against a real
  // SQLite journal, with scheduling/delivery excluded from this recovery unit.
  // No constructor starts a background lane, Host, memory encoder or provider.
  const service = Object.create(BotService.prototype) as BotService;
  Object.assign(service, { store, taskRuntime: runtime, companionRuntime: new BotCompanionRuntime(store), toolRuns,
    taskRuns: new Map(), taskAccessUpgrades: new Map(), scheduler: { wake: vi.fn() },
    toolServer: { releaseWorker: vi.fn() },
    changed: vi.fn(), maintainSafely: vi.fn(), taskProgress: vi.fn(), flushTaskControls: vi.fn(async () => undefined),
    flushExecutorControl: vi.fn(async () => undefined) });
  const controller = service as unknown as Controller;
  const task = (id = 'task-1', status: BotTask['status'] = 'running', extra: Record<string, unknown> = {}) => {
    store.createTask({ id, conversationId: room.id, companionId: 'alice', sourceEventId: event.id, goal: '任务原目标', extra: { nativeAttempted: true, workerAccess: 'full', ...extra } });
    return store.updateTask(id, { status });
  };
  const call = (operation: string, args: Record<string, unknown> = {}, callId = operation): BotToolCall => ({ eventId: event.id, laneId: event.laneId, callId, name: 'dsh_task_control', args: { operation, taskId: 'task-1', ...args } });
  const requestId = (input: BotToolCall) => `${input.eventId}:${input.callId}`;
  const control = async (input: BotToolCall) => controller.controlTask(store.getTask(String(input.args.taskId))!, input.args.operation as Parameters<Controller['controlTask']>[1], typeof input.args.text === 'string' ? input.args.text : undefined,
    requestId(input), { caller: 'brain', source: 'user', sourceEventId: event.id, questionId: typeof input.args.questionId === 'string' ? input.args.questionId : undefined,
      answers: input.args.answers as BotTaskControlInput['answers'] });
  return { store, room, event, claim: claim!, runtime, service, controller, toolRuns, task, call, control, requestId };
}

async function routerTurn(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.settle({ eventId: f.event.id, leaseToken: f.claim.leaseToken, status: 'done', content: '原用户任务已经交给执行器。' });
  const event = f.store.enqueue({ conversationId: f.room.id, senderId: 'task-service', senderName: '任务回执', source: 'task',
    sourceMessageId: 'router-management-event', recipientIds: ['alice'], kind: 'task_progress', content: '执行器返回了阶段进展。',
    correlationId: f.event.correlationId, causationId: f.event.id, payload: { taskId: 'task-1', hop: 1 } }).events[0]!;
  const claim = f.store.claim({ workerId: 'router-management' })!; expect(claim.event.id).toBe(event.id);
  f.store.bindEventNativeEpoch(event.id, 1);
  let sequence = 0;
  return { event, execute: (operation: string, taskId = 'task-1', extra: Record<string, unknown> = {}) => f.controller.executeTool(claim.event,
    { laneId: event.laneId, eventId: event.id, callId: `router-${operation}-${++sequence}`, name: 'dsh_task_control', args: { operation, taskId, ...extra } }, new AbortController().signal) };
}

it('allows the live owning Router to stop and clear its task from a task event without requesting another user confirmation', async () => {
  const f = await fixture(); f.task(); const router = await routerTurn(f);
  expect(await router.execute('cancel')).toMatchObject({ taskId: 'task-1', status: 'cancelled', confirmed: true });
  expect(await router.execute('remove')).toMatchObject({ cleared: 1 });
  expect(f.store.getTask('task-1')!.extra.removedAt).toBeTruthy();
});

it('lets the owning Router pause/resume its own work but never override a user pause or stopped task', async () => {
  const f = await fixture(); f.task(); const router = await routerTurn(f);
  expect(await router.execute('pause')).toMatchObject({ status: 'paused' });
  expect(f.store.getTask('task-1')!.extra).toMatchObject({ pauseOrigin: 'router', userPaused: false });
  expect(f.runtime.card(f.store.getTask('task-1')!).pauseOrigin).toBe('router');
  expect(await router.execute('resume_paused')).toMatchObject({ status: 'queued' });
  await router.execute('pause');
  const paused = f.store.getTask('task-1')!;
  await f.controller.controlTask(f.store.getTask('task-1')!, 'pause', undefined, 'human-pause', { caller: 'user' });
  expect(f.store.getTask('task-1')!.extra.pausedAt).toBe(paused.extra.pausedAt);
  expect(f.store.getTask('task-1')!.extra.elapsedMs).toBe(paused.extra.elapsedMs);
  await expect(router.execute('resume_paused')).rejects.toThrow('用户暂停');
  expect(f.store.getTask('task-1')!.extra).toMatchObject({ pauseOrigin: 'user', userPaused: true });
  await f.controller.controlTask(f.store.getTask('task-1')!, 'cancel', undefined, 'human-stop', { caller: 'user' });
  expect(await router.execute('resume_paused')).toMatchObject({ status: 'cancelled', accepted: false });
  expect(f.store.getTask('task-1')!.status).toBe('cancelled');
});

it('lets the Router batch-stop and clear only its current conversation tasks and rejects worker access to Router tools', async () => {
  const f = await fixture(); f.task(); f.task('task-2'); const router = await routerTurn(f);
  const other = f.store.createGroup({ title: 'Another audience', memberIds: ['alice'] });
  const source = f.store.enqueue({ conversationId: other.id, senderId: 'user', recipientIds: ['alice'], sourceMessageId: 'other-scope-task', content: 'Foreign room task.' }).events[0]!;
  f.store.createTask({ id: 'other-task', conversationId: other.id, companionId: 'alice', sourceEventId: source.id, goal: 'Do not change the other room.' });
  expect(await router.execute('cancel_all', undefined, { conversationId: other.id, companionId: 'bob' })).toMatchObject({ affected: 2, cancelled: 2 });
  expect(f.store.getTask('other-task')!.status).toBe('queued');
  expect(await router.execute('clear_finished')).toMatchObject({ cleared: 2 });
  expect(f.store.getTask('other-task')!.extra.removedAt).toBeUndefined();
  const workerHost = f.service as unknown as { tool(call: BotToolCall, signal: AbortSignal): Promise<unknown> };
  await expect(workerHost.tool({ laneId: 'worker-other-task', eventId: 'work-other-task', callId: 'worker-forged-router-control', name: 'dsh_task_control', args: { operation: 'cancel_all' } }, new AbortController().signal)).rejects.toThrow('停止或尚未附着');
});

it('recovers an immediate local stop from its saved control receipt without requiring a native acknowledgement', async () => {
  const f = await fixture(); f.task(); const call = f.call('cancel'); await f.control(call);
  f.store.cancelEvent(f.event.id);
  const before = f.store.getTask('task-1');
  expect(f.store.getMetadata(`effect:${f.event.id}:${call.callId}`)).toBeUndefined();
  const proof = await f.service.reconcileToolReceipt(call);
  expect(proof).toMatchObject({ state: 'committed', result: { taskId: 'task-1', accepted: true, cancelRequested: true, confirmed: true, status: 'cancelled' } });
  expect(f.store.getTask('task-1')).toEqual(before);
  expect(await f.service.reconcileToolReceipt(call)).toEqual(proof);
});

it('exposes only minimal stop facts after withdrawal and lets a new user request recheck cancellation', async () => {
  const f = await fixture(); f.task(); await f.control(f.call('cancel'));
  f.store.updateTask('task-1', { summary: 'WITHDRAWN_PRIVATE_REPORT' });
  f.store.withdrawSources('alice', f.room.securityDomainId, [f.event.id]); f.store.cancelEvent(f.event.id);
  for (const value of f.store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE source='task' AND status='queued'").all()) as Array<{id:string}>) f.store.cancelEvent(value.id);
  const incoming = f.store.enqueue({ conversationId: f.room.id, senderId: 'user', content: '重新核实刚才的停止', sourceMessageId: 'recheck-stop' }).events[0]!;
  const claim = f.store.claim({ workerId: 'recheck' })!; expect(claim.event.id).toBe(incoming.id);
  const call = (operation: string): BotToolCall => ({ eventId: incoming.id, laneId: incoming.laneId, callId: 'new-' + operation, name: 'dsh_task_control', args: { operation, taskId: 'task-1', text: '不能继续原任务' } });
  const status = await f.controller.executeTool(claim.event, call('status'), new AbortController().signal);
  expect(status).toMatchObject({ taskId: 'task-1', status: 'cancelled', cancelRequested: true, confirmed: true });
  expect(JSON.stringify(status)).not.toMatch(/WITHDRAWN_PRIVATE_REPORT|任务原目标/);
  expect(status).not.toHaveProperty('summary'); expect(status).not.toHaveProperty('goal');
  await expect(f.controller.executeTool(claim.event, call('send'), new AbortController().signal)).rejects.toThrow('协调视图');
  expect(await f.controller.executeTool(claim.event, call('cancel'), new AbortController().signal)).toMatchObject({ taskId: 'task-1', cancelRequested: true, confirmed: true });
});

it.each(['pause', 'resume_paused', 'continue'] as const)('recovers a saved %s operation without issuing it again', async operation => {
  const f = await fixture(); f.task('task-1', operation === 'resume_paused' ? 'paused' : operation === 'continue' ? 'waiting' : 'running', operation === 'continue' ? { outputCheckpoint: 17 } : {});
  const call = f.call(operation); await f.control(call); const before = f.store.getTask('task-1');
  expect(await f.service.reconcileToolReceipt(call)).toMatchObject({ state: 'committed', result: { taskId: 'task-1', accepted: true, status: before!.status } });
  expect(f.store.getTask('task-1')).toEqual(before);
});

it('reads an original answer receipt, validates the exact answer, and never answers the question twice', async () => {
  const f = await fixture(), task = f.task();
  const callId = 'worker-question', questionId = 'question-' + digest(`work-${task.id}:${callId}`).slice(0, 48);
  f.runtime.question(task, { callId, questionId, questions: [{ id: 'next_step', question: '如何继续？', options: [{ label: '先不做这件事', description: '停止当前尝试' }] }] });
  const call = f.call('answer', { questionId, answers: [{ id: 'next_step', selected: ['先不做这件事'] }] });
  const result = await f.control(call); f.store.cancelEvent(f.event.id);
  expect(await f.service.reconcileToolReceipt(call)).toEqual({ state: 'committed', result });
  const changed = { ...call, args: { ...call.args, answers: [{ id: 'next_step', selected: [], custom: '换一种方式' }] } };
  await expect(f.service.reconcileToolReceipt(changed)).rejects.toThrow('回执参数不匹配');
  const questions = f.store.taskTransaction(sql => sql.prepare('SELECT state,answers_json FROM bot_task_questions WHERE task_id=? AND question_id=?').get(task.id, questionId));
  expect(questions).toMatchObject({ state: 'answered', answers_json: JSON.stringify(call.args.answers) });
});

it('proves a rejected answer on an already cancelled task absent after its callback has ended', async () => {
  const f = await fixture(); f.task('task-1', 'cancelled');
  const call = f.call('answer', { questionId: 'question-not-answered', answers: [{ id: 'next_step', selected: ['先不做这件事'] }] });
  await expect(f.control(call)).rejects.toThrow('用户已停止');
  f.store.cancelEvent(f.event.id);
  expect(await f.service.reconcileToolReceipt(call)).toEqual({ state: 'absent' });
  expect(f.store.getTask('task-1')!.status).toBe('cancelled');
  expect(f.store.taskTransaction(sql => sql.prepare('SELECT 1 FROM bot_task_controls WHERE task_id=?').get('task-1'))).toBeUndefined();
});

it('does not treat a missing receipt as absence while the original callback may still commit it', async () => {
  const f = await fixture(); f.task(); const call = f.call('answer', { questionId: 'question-pending', answers: [{ id: 'next_step', selected: ['先不做这件事'] }] });
  const key = `effect:${f.event.id}:${call.callId}`; f.toolRuns.set(key, { promise: Promise.resolve() });
  expect(await f.service.reconcileToolReceipt(call)).toEqual({ state: 'unknown' });
  expect(f.store.getMetadata(key)).toBeUndefined();
  f.toolRuns.delete(key);
  expect(await f.service.reconcileToolReceipt(call)).toEqual({ state: 'absent' });
});

it('recovers persisted steering from both the task row and delivery journal and rejects changed content', async () => {
  const f = await fixture(); f.task(); const call = f.call('send', { text: '  保留原始范围。  ' }); await f.control(call);
  const key = `task-control:task-1:${f.requestId(call)}`;
  f.store.setMetadata(key, ''); // Crash between the task-row commit and receipt commit.
  expect(await f.service.reconcileToolReceipt(call)).toMatchObject({ state: 'committed', result: { accepted: true, delivery: 'pending' } });
  const changed = { ...call, args: { ...call.args, text: '扩大范围。' } };
  await expect(f.service.reconcileToolReceipt(changed)).rejects.toThrow('回执参数不匹配');
  expect(f.store.getTask('task-1')!.extra.pendingControls).toEqual([{ id: f.requestId(call), text: '保留原始范围。' }]);
});

it('recovers terminal-record removal and whole-scope cleanup from their original journal', async () => {
  const f = await fixture(); f.task('task-1', 'cancelled'); f.task('task-2', 'succeeded');
  const remove = f.call('remove'); const result = await f.control(remove);
  expect(await f.service.reconcileToolReceipt(remove)).toEqual({ state: 'committed', result });
  expect(f.store.getTask('task-1')!.extra.removedAt).toBeTruthy();
  const clear = f.call('clear_finished'); const cleared = await f.controller.controlQueue(f.room.id, 'clear_finished', f.requestId(clear), f.event.companionId);
  expect(await f.service.reconcileToolReceipt(clear)).toEqual({ state: 'committed', result: cleared });
});

it('reports exactly which frozen queue cancellation requests landed and never silently completes an interrupted batch', async () => {
  const f = await fixture(); f.task(); f.task('task-2'); const call = f.call('cancel_all');
  const requestId = f.requestId(call), key = `task-queue-control:${f.room.id}:${requestId}`;
  f.store.setMetadata(key, JSON.stringify({ fingerprint: digest(JSON.stringify({ operation: 'cancel_all', companionId: f.event.companionId })), ids: ['task-1', 'task-2'], conversationId: f.room.id, published: false }));
  await f.controller.controlTask(f.store.getTask('task-1')!, 'cancel', undefined, `${requestId}:task-1`, { caller: 'user' });
  const before = f.store.getTask('task-2');
  expect(await f.service.reconcileToolReceipt(call)).toMatchObject({ state: 'committed', result: { accepted: false, partial: true, affected: 2, cancelled: 1, notRequested: 1 } });
  expect(f.store.getTask('task-2')).toEqual(before);
});

it('proves foreign task requests rejected while keeping another epoch and erased answer evidence unresolved', async () => {
  const f = await fixture(); f.task(); const other = f.store.openDirect('bob');
  const sent = f.store.enqueue({ conversationId: other.id, senderId: 'user', source: 'user', content: '另一个伙伴的任务', sourceMessageId: 'foreign-source' });
  const claimed = f.store.claim({ workerId: 'foreign-owner' }); expect(claimed?.event.id).toBe(sent.events[0]!.id);
  f.store.createTask({ id: 'foreign', companionId: 'bob', conversationId: other.id, sourceEventId: claimed!.event.id, goal: '另一个伙伴的任务' });
  expect(await f.service.reconcileToolReceipt(f.call('cancel', { taskId: 'foreign' }))).toEqual({ state: 'absent' });
  expect(f.store.getTask('foreign')!.extra.cancelRequested).toBeUndefined();
  expect(await f.service.reconcileToolReceipt({ ...f.call('cancel'), laneId: `${f.event.laneId}-epoch-99` })).toEqual({ state: 'unknown' });
  f.store.updateTask('task-1', { status: 'cancelled', extra: { removedAt: new Date().toISOString() } });
  expect(await f.service.reconcileToolReceipt(f.call('answer', { questionId: 'erased' }))).toEqual({ state: 'unknown' });
});

it('proves invalid preflight controls absent without turning malformed parameters into an endless recovery', async () => {
  const f = await fixture(); f.task();
  for (const call of [f.call('cancel', { taskId: 'missing' }), f.call('invalid-operation'), f.call('send', { text: '' }), f.call('send', { text: 1 })]) {
    expect(await f.service.reconcileToolReceipt(call)).toEqual({ state: 'absent' });
  }
  expect(f.store.getTask('task-1')!.extra.cancelRequested).toBeUndefined();
});
