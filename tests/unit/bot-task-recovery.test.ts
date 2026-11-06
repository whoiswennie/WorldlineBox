import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BotService, type BotServiceOptions } from '../../src/main/companion-bot/service';
import { BotDshBrain, BotDshDeliveryUnknownError, BotDshEffectUnknownError, BotDshOutputLimitError, type BotDshCancelAck, type BotDshResult, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import type { BotTask } from '../../src/main/companion-bot/types';
import type { BotWorkerEffectInspection } from '../../src/shared/companion-bot-task';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { reportWorkerOutcome } from '../fixtures/bot-worker-report';
import { DshHostUnavailableError } from '../../src/main/dsh/host-errors';

class MemoryBoundary extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw new Error('VCP fixture boundary'); }, embedding: async () => { throw new Error('VCP fixture boundary'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, inputHash: 'fixture', messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async close() {}
}
type CancelInput = Omit<BotDshRun, 'prompt' | 'onEvent'>;
type Guidance = Parameters<BotDshBrain['send']>[1];
class BrainBoundary extends BotDshBrain {
  private readonly activeWorkers = new Set<string>();
  calls: BotDshRun[] = [];
  stops: CancelInput[] = [];
  guidance: Array<{ laneId: string; input: Guidance }> = [];
  upgrades: Array<Parameters<BotDshBrain['upgradeWorkerAccess']>[0]> = [];
  upgrading: BotDshBrain['upgradeWorkerAccess'] = async input => ({ workerAccess: 'full', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId });
  inspections: Array<Parameters<BotDshBrain['inspectEffects']>[0]> = [];
  inspecting: (input: Parameters<BotDshBrain['inspectEffects']>[0]) => Promise<BotWorkerEffectInspection[]> = async input => (input.callIds ?? input.effects?.map(effect => effect.callId) ?? []).map(callId => ({ callId, state: 'unknown' }));
  questionInspections: Array<Parameters<BotDshBrain['inspectQuestionAnswers']>[0]> = [];
  inspectingAnswers: BotDshBrain['inspectQuestionAnswers'] = async input => input.questions.map(question => ({ questionId: question.questionId, state: 'unknown', observedThrough: 0 }));
  worker: (input: BotDshRun) => Promise<string> = async () => '真实执行结果';
  router: (input: BotDshRun) => Promise<string> = async () => '已收到来源消息或任务回执';
  stopping: (input: CancelInput) => Promise<BotDshCancelAck> = async () => ({ accepted: true, absent: true });
  steering: (laneId: string, input: Guidance) => Promise<void> = async () => undefined;
  constructor() { super({ getHost: async () => { throw new Error('DSH fixture boundary'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    this.calls.push(input);
    if (input.role === 'worker') this.activeWorkers.add(input.laneId);
    try {
      input.onEvent?.({ type: 'text', text: '', sequence: 1, receivedAt: new Date().toISOString() });
      const text = input.role === 'worker' ? await this.worker(input) : input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : await this.router(input);
      if (input.role === 'worker') await reportWorkerOutcome(input, { state: 'ready', summary: text.slice(0, 16000) || '夹具业务交付已完成', verification: ['受控执行脚本已完成当前场景并提交明确完成报告。'] });
      return { text, status: 'succeeded', eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) };
    } finally { this.activeWorkers.delete(input.laneId); }
  }
  override async cancelDurable(input: CancelInput) { this.stops.push(input); return this.stopping(input); }
  override async inspectEffects(input: Parameters<BotDshBrain['inspectEffects']>[0]) { this.inspections.push(input); return this.inspecting(input); }
  override async inspectQuestionAnswers(input: Parameters<BotDshBrain['inspectQuestionAnswers']>[0]) { this.questionInspections.push(input); return this.inspectingAnswers(input); }
  override async send(laneId: string, input: Guidance) {
    if (!this.activeWorkers.has(laneId)) throw new Error('The native task is not attached or running.');
    this.guidance.push({ laneId, input }); await this.steering(laneId, input);
  }
  override async archive() {}
  override async upgradeWorkerAccess(input: Parameters<BotDshBrain['upgradeWorkerAccess']>[0]) { this.upgrades.push(input); return this.upgrading(input); }
  override async close() {}
}
const owned: Array<{ root: string; services: BotService[] }> = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    for (const service of item.services) await service.shutdown();
    if (path.dirname(path.resolve(item.root)) !== path.resolve(tmpdir()) || !path.basename(item.root).startsWith('wlb-task-recovery-')) throw new Error('Invalid fixture cleanup target');
    await rm(item.root, { recursive: true, force: true });
  }
});
async function fixture(brain = new BrainBoundary(), options: Partial<Pick<BotServiceOptions, 'activityBudget' | 'model' | 'resumeTaskRuntime'>> | undefined = undefined) {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-task-recovery-')), memory = new MemoryBoundary(root);
  const owner = { root, services: [] as BotService[] }; owned.push(owner);
  const open = (next: BrainBoundary) => {
    const service = new BotService({ root, memory, brain: next, model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }), ...options, onEvent: () => undefined });
    owner.services.push(service); return service;
  };
  const service = open(brain), initial = (await service.handle({ type: 'state' })).snapshot!;
  const conversationId = initial.conversations[0]!.id, companionId = DEFAULT_BOT_COMPANION_ID;
  const ingress = await service.handle({ type: 'message.send', conversationId, content: '你好', requestId: 'source-message' });
  const source = (await service.handle({ type: 'state', conversationId })).snapshot!.messages
    .map(message => service.store.eventForReply(message.id)).find(event => event?.sourceMessageRecordId === ingress.messageId)!;
  await waitFor(() => service.store.getEvent(source.id)?.status === 'done');
  const task = (extra: Record<string, unknown> = {}) => service.store.createTask({ conversationId, companionId, sourceEventId: source.id, goal: '处理一个可验证的任务',
    extra: { workerAccess: 'full', ...extra } });
  return { service, brain, conversationId, task, reopen: open };
}
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 4000) {
  const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function waitAbortably(input: BotDshRun, gate: Promise<string>): Promise<string> {
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => { abort = () => reject(input.signal!.reason); input.signal!.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([gate, interrupted]); } finally { input.signal!.removeEventListener('abort', abort); }
}
async function nudge(service: BotService, conversationId: string, id: string) {
  await service.handle({ type: 'message.send', conversationId, content: '你好', requestId: id });
}
async function taskMessages(service: BotService, conversationId: string) {
  return (await service.handle({ type: 'state', conversationId })).snapshot!.messages.filter(message => message.senderId === 'task-service');
}
function currentExtra(service: BotService, task: BotTask) { return service.store.getTask(task.id)!.extra; }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const questionId = (task: BotTask, callId: string) => 'question-' + hash(`work-${task.id}:${callId}`).slice(0, 48);
function attentionEvent(service: BotService, task: BotTask, id: string) {
  const entry = service.store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE source='task' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attention')=?").get(task.id, `question:${id}`)) as { id: string };
  return service.store.getEvent(entry.id)!;
}
async function callback(input: BotDshRun, name: string, callId: string, args: Record<string, unknown>, identity: Record<string, string> = {}) {
  const response = await fetch(input.callback!.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, name, callId, args, ...identity }) });
  const result = await response.json() as { ok: boolean; result?: Record<string, unknown>; error?: string };
  return { status: response.status, ...result };
}

it('retries an unknown worker outcome with the same work event, task and prompt instead of creating another task', async () => {
  const brain = new BrainBoundary(); let workerCalls = 0;
  brain.worker = async () => { if (++workerCalls === 1) throw new BotDshDeliveryUnknownError('stream lost after admission'); return '已经核验的产物'; };
  const f = await fixture(brain), task = f.task();
  await nudge(f.service, f.conversationId, 'launch');
  await waitFor(() => Number(currentExtra(f.service, task).retryAttempts) === 1);
  expect(f.service.store.getTask(task.id)?.status).toBe('queued');
  f.service.store.updateTask(task.id, { extra: { ...currentExtra(f.service, task), retryAt: 0 } });
  await nudge(f.service, f.conversationId, 'retry');
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  const calls = brain.calls.filter(input => input.role === 'worker');
  expect(calls).toHaveLength(2); expect(calls[1]!.eventId).toBe(`work-${task.id}`);
  expect(calls[1]!.laneId).toBe(calls[0]!.laneId); expect(calls[1]!.prompt).toBe(calls[0]!.prompt);
  expect(f.service.store.listTasks()).toHaveLength(1);
  const notices = await taskMessages(f.service, f.conversationId); expect(notices).toHaveLength(1);
  expect(notices[0]?.taskNotice).toMatchObject({ taskId: task.id, kind: 'task_done', replyMessageId: expect.any(String) });
  const naturalReply = f.service.store.getMessage(notices[0]!.taskNotice!.replyMessageId!);
  expect(naturalReply?.senderId).toBe(DEFAULT_BOT_COMPANION_ID); expect(naturalReply?.taskNotice).toBeUndefined();
});

it('retains unconfigured work as resumable without inventing a native admission or repeatedly calling the executor', async () => {
  const brain = new BrainBoundary(); brain.worker = async () => { throw new DshHostUnavailableError('configuration', '请先安装 DSH'); };
  let starts = 0;
  const f = await fixture(brain, { resumeTaskRuntime: async () => { starts++; } }), task = f.task();
  await nudge(f.service, f.conversationId, 'missing-runtime');
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'paused');
  expect(currentExtra(f.service, task)).toMatchObject({ nativeAttempted: false, userPaused: true, executorInterruption: { reason: 'configuration' } });
  expect(currentExtra(f.service, task).executorControl).toBeUndefined();
  await nudge(f.service, f.conversationId, 'still-chatting');
  expect(brain.calls.filter(call => call.role === 'worker')).toHaveLength(1); expect(brain.stops).toEqual([]);
  brain.worker = async () => '安装运行环境后沿原任务完成';
  await f.service.handle({ type: 'task.control', operation: 'resume_paused', conversationId: f.conversationId, taskId: task.id, requestId: 'resume-configured' });
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  const calls = brain.calls.filter(call => call.role === 'worker');
  expect(starts).toBe(1); expect(calls[1]?.resumeHost).toBe(true);
  expect(calls[1]).toMatchObject({ laneId: calls[0]!.laneId, eventId: calls[0]!.eventId, cwd: calls[0]!.cwd, prompt: calls[0]!.prompt });
  expect(f.service.store.listTasks()).toHaveLength(1);
});

it('bounds startup failures and releases execution slots while preserving work for explicit recovery', async () => {
  const brain = new BrainBoundary(); let brokenLane = '';
  brain.worker = async input => { if (input.laneId === brokenLane) throw new DshHostUnavailableError('startup', 'Host startup failed', 'original-host'); return '另一项任务已完成'; };
  const f = await fixture(brain), task = f.task(); brokenLane = `worker-${task.id}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.service.store.updateTask(task.id, { extra: { ...currentExtra(f.service, task), retryAt: 0 } });
    await nudge(f.service, f.conversationId, `startup-${attempt}`);
    await waitFor(() => Number(currentExtra(f.service, task).retryAttempts) === attempt);
  }
  expect(f.service.store.getTask(task.id)?.status).toBe('paused');
  expect(currentExtra(f.service, task).nativeAttempted).toBe(false);
  const other = f.task(); await nudge(f.service, f.conversationId, 'unblocked');
  await waitFor(() => f.service.store.getTask(other.id)?.status === 'succeeded');
  expect(brain.calls.filter(call => call.laneId === brokenLane)).toHaveLength(3);
});

it('immediately pauses only tasks bound to a manually closed instance and preserves that pause across restart', async () => {
  const brain = new BrainBoundary(), gate = deferred<string>();
  brain.worker = input => waitAbortably(input, gate.promise);
  const f = await fixture(brain), task = f.task();
  f.service.store.setMetadata(`native-host:worker-${task.id}`, 'closed-instance');
  const other = f.task({ retryAt: Date.now() + 60000 });
  f.service.store.setMetadata(`native-host:worker-${other.id}`, 'other-instance');
  await nudge(f.service, f.conversationId, 'run-before-close');
  await waitFor(() => brain.calls.some(call => call.laneId === `worker-${task.id}`));
  f.service.workerInstanceStopped('closed-instance');
  expect(f.service.store.getTask(task.id)?.status).toBe('paused');
  expect(f.service.store.getTask(other.id)?.status).toBe('queued');
  const paused = currentExtra(f.service, task);
  expect(paused.timerStartedAt).toBeUndefined(); expect(paused.executorInterruption).toMatchObject({ reason: 'stopped' });
  await nudge(f.service, f.conversationId, 'no-revival');
  expect(currentExtra(f.service, task).elapsedMs).toBe(paused.elapsedMs);
  expect(brain.calls.filter(call => call.laneId === `worker-${task.id}`)).toHaveLength(1);
  await f.service.shutdown(); const next = new BrainBoundary(), restarted = f.reopen(next);
  await restarted.handle({ type: 'state', conversationId: f.conversationId });
  expect(restarted.store.getTask(task.id)?.status).toBe('paused');
  expect(next.calls.filter(call => call.laneId === `worker-${task.id}`)).toEqual([]);
  await restarted.handle({ type: 'task.control', operation: 'resume_paused', conversationId: f.conversationId, taskId: task.id, requestId: 'resume-original-host' });
  await waitFor(() => restarted.store.getTask(task.id)?.status === 'succeeded');
  expect(next.calls.find(call => call.laneId === `worker-${task.id}`)).toMatchObject({ eventId: `work-${task.id}`, resumeHost: true });
  expect(restarted.store.getMetadata(`native-host:worker-${task.id}`)).toBe('closed-instance');
});

it('stops an unsuccessful reconnect loop after five attempts and resumes the same durable work only on request', async () => {
  const brain = new BrainBoundary(); brain.worker = async () => { throw new BotDshDeliveryUnknownError('connection lost', 'stream'); };
  const f = await fixture(brain), task = f.task();
  for (let attempt = 1; attempt <= 5; attempt++) {
    f.service.store.updateTask(task.id, { extra: { ...currentExtra(f.service, task), retryAt: 0 } });
    await nudge(f.service, f.conversationId, `interruption-${attempt}`);
    await waitFor(() => Number(currentExtra(f.service, task).retryAttempts) === attempt);
  }
  expect(f.service.store.getTask(task.id)?.status).toBe('paused');
  expect(currentExtra(f.service, task)).toMatchObject({ nativeAttempted: true, retryAttempts: 5, executorInterruption: { reason: 'interrupted' } });
  await nudge(f.service, f.conversationId, 'no-loop');
  expect(brain.calls.filter(call => call.role === 'worker')).toHaveLength(5);
  brain.worker = async () => '原任务已恢复完成';
  await f.service.handle({ type: 'task.control', operation: 'resume_paused', conversationId: f.conversationId, taskId: task.id, requestId: 'resume-interrupted' });
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  const calls = brain.calls.filter(call => call.role === 'worker');
  expect(new Set(calls.map(call => call.eventId))).toEqual(new Set([`work-${task.id}`]));
  expect(new Set(calls.map(call => call.cwd)).size).toBe(1); expect(new Set(calls.map(call => call.prompt)).size).toBe(1);
});

it('persists a worker failure and its single source-bound brain notification across a restart', async () => {
  const brain = new BrainBoundary(); brain.worker = async () => { throw new Error('fixture compiler failed'); };
  const f = await fixture(brain), task = f.task();
  await nudge(f.service, f.conversationId, 'launch');
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'failed');
  await waitFor(() => brain.calls.some(input => input.role !== 'worker' && input.prompt.includes('fixture compiler failed')));
  expect((await taskMessages(f.service, f.conversationId))[0]?.content).toContain('fixture compiler failed');
  await f.service.shutdown(); const next = new BrainBoundary(), restarted = f.reopen(next);
  await restarted.handle({ type: 'state', conversationId: f.conversationId });
  expect(restarted.store.getTask(task.id)).toMatchObject({ status: 'failed', error: 'fixture compiler failed' });
  expect(await taskMessages(restarted, f.conversationId)).toHaveLength(1);
  expect(next.calls.filter(input => input.role === 'worker')).toEqual([]);
});

it('cancels queued work without starting a worker or requiring native cancellation', async () => {
  const f = await fixture(), task = f.task();
  await f.service.handle({ type: 'task.control', taskId: task.id, conversationId: f.conversationId, requestId: 'stop-queued', operation: 'cancel' });
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'cancelled');
  expect(f.brain.calls.filter(input => input.role === 'worker')).toEqual([]); expect(f.brain.stops).toEqual([]);
  expect(await taskMessages(f.service, f.conversationId)).toHaveLength(1);
});

it('pages and searches 140 actual SQL tasks beyond the snapshot window and enforces conversation ownership', async () => {
  const f = await fixture(new BrainBoundary(), { activityBudget: { maxTasks: 200, maxPendingTasks: 200 } });
  const statuses = ['queued', 'running', 'waiting', 'unknown', 'succeeded', 'failed', 'cancelled'] as const;
  const ids = new Set<string>();
  for (let index = 0; index < 140; index++) {
    const task = f.task({ title: `archive-task-${index}`, retryAt: Date.now() + 60000 });
    f.service.store.updateTask(task.id, { status: statuses[index % statuses.length] }); ids.add(task.id);
  }
  const pages: string[] = [];
  for (let page = 0; page < 5; page++) {
    const result = (await f.service.handle({ type: 'task.list', conversationId: f.conversationId, filter: 'all', page, limit: 30 })).taskPage!;
    expect(result).toMatchObject({ total: 140, page, limit: 30, activeCount: 80, queuedCount: 20 });
    expect(result.items).toHaveLength(page === 4 ? 20 : 30);
    for (const item of result.items) { expect(item).not.toHaveProperty('extra'); expect(item.summary).toBeUndefined(); pages.push(item.id); }
  }
  expect(new Set(pages)).toEqual(ids); expect(pages).toHaveLength(140);
  const snapshot = (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!;
  expect(snapshot.tasks.length).toBeLessThanOrEqual(100);
  for (const item of snapshot.tasks) { expect(item.summary).toBeUndefined(); expect(item.pendingEffects).toBeUndefined(); }
  for (const [filter, total] of [['active', 80], ['done', 60], ['issues', 60]] as const) {
    expect((await f.service.handle({ type: 'task.list', conversationId: f.conversationId, filter, page: 0, limit: 30 })).taskPage?.total).toBe(total);
  }
  const searched = (await f.service.handle({ type: 'task.list', conversationId: f.conversationId, filter: 'all', query: 'archive-task-139', page: 0, limit: 6 })).taskPage!;
  expect(searched.total).toBe(1); expect(searched.items[0]?.title).toBe('archive-task-139');
  expect((await f.service.handle({ type: 'task.get', conversationId: f.conversationId, taskId: searched.items[0]!.id })).task?.goal).toBe('处理一个可验证的任务');
  const foreign = f.service.store.createGroup({ title: 'Separate chat', memberIds: [DEFAULT_BOT_COMPANION_ID] });
  expect((await f.service.handle({ type: 'task.list', conversationId: foreign.id, filter: 'all', page: 0, limit: 30 })).taskPage?.total).toBe(0);
  await expect(f.service.handle({ type: 'task.get', conversationId: foreign.id, taskId: searched.items[0]!.id })).rejects.toThrow('不属于');
  await expect(f.service.handle({ type: 'task.control', conversationId: foreign.id, taskId: searched.items[0]!.id, operation: 'cancel', requestId: 'foreign-cancel' })).rejects.toThrow('不属于');
  await expect(f.service.handle({ type: 'task.list', conversationId: 'missing-chat', filter: 'all', page: 0, limit: 30 })).rejects.toThrow('聊天不存在');
  expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(0);
});

it('binds a queue cancellation receipt to its original target set and leaves later tasks alone', async () => {
  const f = await fixture(), first = f.task({ retryAt: Date.now() + 60000 }), second = f.task({ retryAt: Date.now() + 60000 });
  const request = { type: 'task.queue.control' as const, conversationId: f.conversationId, operation: 'cancel_queued' as const, requestId: 'cancel-original-set' };
  expect((await f.service.handle(request)).memory).toMatchObject({ affected: 2 });
  expect(f.service.store.getTask(first.id)?.status).toBe('cancelled'); expect(f.service.store.getTask(second.id)?.status).toBe('cancelled');
  const later = f.task({ retryAt: Date.now() + 60000 });
  expect((await f.service.handle(request)).memory).toMatchObject({ affected: 2 });
  expect(f.service.store.getTask(later.id)).toMatchObject({ status: 'queued', extra: { retryAt: expect.any(Number) } });
  expect(f.service.store.getTask(later.id)?.extra.cancelRequested).not.toBe(true);
  await expect(f.service.handle({ ...request, operation: 'cancel_all' })).rejects.toThrow('不同请求');
  expect(f.brain.stops).toHaveLength(0); expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(0);
});

it('publishes one durable batch notice for eleven immediately stopped queued tasks without spawning eleven brain turns', async () => {
  const f = await fixture(new BrainBoundary(), { activityBudget: { maxTasks: 30, maxPendingTasks: 30 } });
  const original = Array.from({ length: 11 }, () => f.task({ nativeAttempted: false, retryAt: Date.now() + 60000 }));
  const request = { type: 'task.queue.control' as const, conversationId: f.conversationId, operation: 'cancel_queued' as const, requestId: 'stop-eleven-once' };
  expect((await f.service.handle(request)).memory).toMatchObject({ affected: 11 });
  expect(original.map(task => f.service.store.getTask(task.id)?.status)).toEqual(Array(11).fill('cancelled'));
  const notices = await taskMessages(f.service, f.conversationId);
  expect(notices).toHaveLength(1); expect(notices[0]!.content).toContain('已停止 11 项');
  const taskEvents = () => f.service.store.taskTransaction(sql => sql.prepare("SELECT id,status FROM bot_inbox WHERE source='task' AND conversation_id=?").all(f.conversationId)) as Array<{ id: string; status: string }>;
  await waitFor(() => taskEvents().length === 1 && ['done', 'cancelled'].includes(taskEvents()[0]!.status));
  const feedback = f.brain.calls.filter(input => input.role !== 'worker' && !input.laneId.startsWith('memory-encoder-') && JSON.parse(input.prompt).trigger.source === 'task');
  expect(feedback).toHaveLength(0); // Stop is acknowledged by the task UI; old task callbacks do not wake the Router.
  const later = f.task({ nativeAttempted: false, retryAt: Date.now() + 60000 });
  expect((await f.service.handle(request)).memory).toMatchObject({ affected: 11 });
  expect((await f.service.handle(request)).memory).toMatchObject({ affected: 11 });
  expect(f.service.store.getTask(later.id)).toMatchObject({ status: 'queued' });
  expect(f.service.store.getTask(later.id)?.extra.cancelRequested).not.toBe(true);
  expect(await taskMessages(f.service, f.conversationId)).toHaveLength(1); expect(taskEvents()).toHaveLength(1);
  expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(0); expect(f.brain.stops).toHaveLength(0);
});

it('persists the full Unicode worker report and reads every page without losing the tail or exposing it to another chat', async () => {
  const f = await fixture(), task = f.task();
  const report = '报告开始🧭\n' + '🐋'.repeat(40000) + '\n报告结尾：TAIL-VERIFIED✅';
  const pages: Array<{ text: string; totalChars: number; nextOffset?: number }> = [];
  const readComplete = deferred<void>(), crossChat = deferred<{ status: number; error?: string }>();
  f.brain.worker = async () => report;
  f.brain.router = async input => {
    const context = JSON.parse(input.prompt);
    if (context.trigger.source === 'task') {
      let offset = 0;
      for (;;) {
        const response = await callback(input, 'dsh_task_result_read', `read-report-${offset}`, { taskId: task.id, offset, limit: 7777 });
        expect(response).toMatchObject({ status: 200, ok: true });
        const page = response.result as unknown as { text: string; totalChars: number; nextOffset?: number };
        pages.push(page);
        if (page.nextOffset === undefined) break;
        expect(page.nextOffset).toBe(offset + 7777); offset = page.nextOffset;
      }
      readComplete.resolve();
    } else if (context.trigger.content === 'read-foreign-result') {
      const response = await callback(input, 'dsh_task_result_read', 'foreign-read-report', { taskId: task.id, offset: 0, limit: 12000 });
      crossChat.resolve(response);
    }
    return '已核验任务报告';
  };
  await nudge(f.service, f.conversationId, 'launch-long-report');
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  await readComplete.promise;
  expect(f.service.store.getTask(task.id)?.summary).toBe(report);
  expect((await f.service.handle({ type: 'task.get', conversationId: f.conversationId, taskId: task.id })).task?.summary).toBe(report);
  expect(pages.length).toBeGreaterThan(5); expect(pages.every(page => page.totalChars === Array.from(report).length)).toBe(true);
  expect(pages.map(page => page.text).join('')).toBe(report); expect(pages.at(-1)!.text.endsWith('TAIL-VERIFIED✅')).toBe(true);
  for (const page of pages) expect(page.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
  const notice = (await taskMessages(f.service, f.conversationId))[0]!;
  expect(notice.content).toContain('执行结果尚有后文'); expect(notice.content).not.toContain('TAIL-VERIFIED');
  const foreign = f.service.store.createGroup({ title: 'Separate report audience', memberIds: [DEFAULT_BOT_COMPANION_ID], participationMode: 'all' });
  await f.service.handle({ type: 'message.send', conversationId: foreign.id, content: 'read-foreign-result', requestId: 'foreign-report' });
  expect(await crossChat.promise).toMatchObject({ status: 400, error: expect.stringContaining('不属于当前伙伴和聊天') });
  expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(1);
});

it('immediately stops never-admitted queued tasks despite a future retry delay and unavailable model', async () => {
  let unavailable = false;
  const f = await fixture(new BrainBoundary(), { model: () => {
    if (unavailable) throw new Error('No model is available.');
    return { apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' };
  } });
  const task = f.task({ nativeAttempted: false, retryAt: Date.now() + 30000 }); unavailable = true;
  await f.service.handle({ type: 'task.control', conversationId: f.conversationId, taskId: task.id, operation: 'cancel', requestId: 'cancel-without-model' });
  expect(f.service.store.getTask(task.id)?.status).toBe('cancelled');
  expect(f.brain.stops).toHaveLength(0); expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(0);
});

it('reconciles an already-admitted worker cancellation without requiring the chat model configuration', async () => {
  let unavailable = false;
  const brain = new BrainBoundary();
  const f = await fixture(brain, { model: () => {
    if (unavailable) throw new Error('Model configuration is unavailable during cancellation.');
    return { apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' };
  } });
  const task = f.task({ nativeAttempted: true, retryAt: Date.now() + 30000 }); unavailable = true;
  await f.service.handle({ type: 'task.control', conversationId: f.conversationId, taskId: task.id, operation: 'cancel', requestId: 'cancel-native-without-model' });
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'cancelled');
  expect(brain.stops).toHaveLength(1);
  expect(brain.stops[0]).toMatchObject({ laneId: `worker-${task.id}`, eventId: `work-${task.id}`, model: { model: 'cancel-only' } });
  expect(brain.calls.filter(input => input.role === 'worker')).toHaveLength(0);
});

it('waits at a durable output checkpoint until an explicit deduplicated continue of the same task', async () => {
  const brain = new BrainBoundary(), gate = deferred<string>(); let calls = 0;
  brain.worker = async input => {
    if (++calls === 1) throw new BotDshOutputLimitError(input.eventId, BotDshBrain.sessionId(input.laneId), 77, '已完成并保存的阶段工作', true);
    return waitAbortably(input, gate.promise);
  };
  const f = await fixture(brain), task = f.task();
  try {
    await nudge(f.service, f.conversationId, 'launch-output-checkpoint');
    await waitFor(() => f.service.store.getTask(task.id)?.status === 'waiting');
    await nudge(f.service, f.conversationId, 'waiting-must-not-auto-retry');
    expect(calls).toBe(1);
    const catalog = (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!.tasks.find(item => item.id === task.id)!;
    expect(catalog.summary).toBeUndefined(); expect(catalog.pendingEffects).toBeUndefined();
    const paused = (await f.service.handle({ type: 'task.get', conversationId: f.conversationId, taskId: task.id })).task!;
    expect(paused).toMatchObject({ status: 'waiting', continuationAvailable: true, summary: '已完成并保存的阶段工作', error: '' });
    const request = { type: 'task.control' as const, conversationId: f.conversationId, taskId: task.id, operation: 'continue' as const, requestId: 'continue-same-checkpoint' };
    await f.service.handle(request); await f.service.handle(request);
    await waitFor(() => calls === 2);
    const nativeCalls = brain.calls.filter(input => input.role === 'worker');
    expect(nativeCalls[1]).toMatchObject({ laneId: nativeCalls[0]!.laneId, eventId: nativeCalls[0]!.eventId, cwd: nativeCalls[0]!.cwd, continueAfterSeq: 77, prompt: nativeCalls[0]!.prompt });
    expect(f.service.store.listTasks()).toHaveLength(1);
    gate.resolve('完成原任务的后续工作');
    await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
    await f.service.handle(request); expect(calls).toBe(2);
  } finally { gate.resolve('结束'); }
});

it('lets the Router read real running progress and page finished results without replaying the worker or exposing its tokens', async () => {
  const brain = new BrainBoundary(), gate = deferred<string>();
  brain.worker = async input => {
    for (let step = 0; step < 20; step++) {
      input.onEvent?.({ type: 'status', stage: 'step_start', sequence: step * 2, receivedAt: new Date().toISOString() });
      input.onEvent?.({ type: 'tool_call', stage: 'tool_start', toolName: 'web_search', text: 'PRIVATE_TOOL_ARGUMENTS', sequence: step * 2 + 1, receivedAt: new Date().toISOString() });
    }
    input.onEvent?.({ type: 'reasoning', text: 'PRIVATE_REASONING_MUST_NOT_BE_DISPLAYED', sequence: 100, receivedAt: new Date().toISOString() });
    return waitAbortably(input, gate.promise);
  };
  const f = await fixture(brain, { model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture', contextWindow: 1048576, maxTokens: 4096, maxOutputTokens: 393216 }) });
  const task = f.task({ title: '专业任务标题'.repeat(24) });
  const completeText = '已实际交付并核对完整结果。'.repeat(180);
  let progressReads = 0, resultReads = 0;
  brain.router = async input => {
    const context = JSON.parse(input.prompt);
    if (context.trigger.content === '核实当前进度') {
      const status = await callback(input, 'dsh_task_control', 'read-running-progress', { operation: 'status', taskId: task.id });
      expect(status).toMatchObject({ status: 200, result: { id: task.id, status: 'running', goal: task.goal,
        progress: { phase: 'using-tool', toolName: 'web_search' } } });
      expect(status.result?.activity).toHaveLength(6);
      expect(JSON.stringify(status)).not.toMatch(/PRIVATE_REASONING|PRIVATE_TOOL_ARGUMENTS/);
      progressReads++; return '执行器正在查询资料，原任务仍在运行。';
    }
    if (context.trigger.content === '读取已经交付的结果') {
      const status = await callback(input, 'dsh_task_control', 'read-finished-status', { operation: 'status', taskId: task.id });
      expect(status).toMatchObject({ status: 200, result: { status: 'succeeded', summaryIsPreview: true,
        result: { totalChars: completeText.length, complete: false, readTool: 'dsh_task_result_read', nextOffset: 1200 } } });
      expect(status.result?.summary).toBe(completeText.slice(0, 1200));
      const remainder = await callback(input, 'dsh_task_result_read', 'read-result-remainder', { taskId: task.id, offset: 1200, limit: 12000 });
      expect(remainder).toMatchObject({ status: 200, result: { text: completeText.slice(1200), totalChars: completeText.length } });
      expect(remainder.result).not.toHaveProperty('nextOffset'); resultReads++; return '完整交付已经读完。';
    }
    return '已收到';
  };
  try {
    await nudge(f.service, f.conversationId, 'launch-progress-budget');
    await waitFor(() => f.service.store.getTask(task.id)?.extra.progress !== undefined && brain.calls.some(input => input.role === 'worker'));
    const worker = brain.calls.find(input => input.role === 'worker')!;
    expect(worker.workspaceTitle?.length).toBeLessThanOrEqual(100); expect(worker.workspaceTitle).toMatch(/^大肥鱼/);
    expect(worker.workspaceParent).toEqual({ path: path.dirname(worker.cwd), title: '大肥鱼' });
    expect(worker.model).toMatchObject({ contextWindow: 1048576, maxTokens: 393216, maxOutputTokens: 393216 });
    const card = (await f.service.handle({ type: 'task.get', conversationId: f.conversationId, taskId: task.id })).task!;
    expect(card.progress).toMatchObject({ phase: 'using-tool', toolName: 'web_search' });
    expect(card.activity).toHaveLength(30); expect(JSON.stringify(card)).not.toMatch(/PRIVATE_REASONING|PRIVATE_TOOL_ARGUMENTS/);
    expect(brain.calls.filter(input => input.role !== 'worker' && !input.laneId.startsWith('memory-encoder-'))[0]?.model.maxTokens).toBe(4096);
    await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '核实当前进度', requestId: 'read-running-progress' });
    await waitFor(() => progressReads === 1);
    expect(brain.calls.filter(input => input.role === 'worker')).toHaveLength(1); expect(brain.guidance).toHaveLength(0);
    gate.resolve(completeText); await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
    await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '读取已经交付的结果', requestId: 'read-finished-result' });
    await waitFor(() => resultReads === 1);
    expect(brain.calls.filter(input => input.role === 'worker')).toHaveLength(1); expect(brain.guidance).toHaveLength(0);
  } finally { gate.resolve('结束'); }
});

it('keeps an attempted legacy stop terminal after restart while collecting native cleanup without re-executing its prompt', async () => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, cancelRequested: true });
  await f.service.shutdown();
  const next = new BrainBoundary(), proof = deferred<BotDshCancelAck>(); next.stopping = async () => proof.promise;
  const restarted = f.reopen(next);
  try {
    await restarted.handle({ type: 'state', conversationId: f.conversationId });
    await waitFor(() => next.stops.length === 1);
    expect(restarted.store.getTask(task.id)?.status).toBe('cancelled');
    expect(next.stops[0]).toMatchObject({ laneId: `worker-${task.id}`, eventId: `work-${task.id}`, workerAccess: 'full' });
    expect(next.stops[0]).not.toHaveProperty('prompt'); expect(next.calls.filter(input => input.role === 'worker')).toEqual([]);
    proof.resolve({ accepted: true, absent: true });
    await waitFor(() => (restarted.store.getTask(task.id)!.extra.executorControl as {state:string}).state === 'acknowledged');
    expect(await taskMessages(restarted, f.conversationId)).toHaveLength(0);
  } finally { proof.resolve({ accepted: true, absent: true }); }
});

it('deduplicates stable guidance IDs, rejects changed content and retains pending delivery through a restart', async () => {
  const brain = new BrainBoundary(), work = deferred<string>(); brain.worker = input => waitAbortably(input, work.promise);
  let nativeExecutions = 0; const receipts = new Set<string>();
  brain.steering = async (_laneId, input) => { if (!receipts.has(input.messageId)) { receipts.add(input.messageId); nativeExecutions++; } throw new BotDshDeliveryUnknownError('lost guidance acknowledgement'); };
  const f = await fixture(brain), task = f.task();
  await nudge(f.service, f.conversationId, 'launch');
  await waitFor(() => brain.calls.some(input => input.role === 'worker'));
  const request = { type: 'task.control' as const, taskId: task.id, conversationId: f.conversationId, operation: 'send' as const, requestId: 'guidance-once', text: '保留原约束并输出验证结果' };
  await f.service.handle(request); await waitFor(() => brain.guidance.length === 1);
  await f.service.handle(request);
  await expect(f.service.handle({ ...request, text: '不同指导' })).rejects.toThrow('指导标识已用于其他内容');
  expect(currentExtra(f.service, task).pendingControls).toEqual([{ id: request.requestId, text: request.text }]);
  await f.service.shutdown();
  const next = new BrainBoundary(), resumedWork = deferred<string>(); next.worker = input => waitAbortably(input, resumedWork.promise);
  next.steering = async (_laneId, input) => { if (!receipts.has(input.messageId)) { receipts.add(input.messageId); nativeExecutions++; } };
  const restarted = f.reopen(next);
  try {
    await restarted.handle({ type: 'state', conversationId: f.conversationId });
    await waitFor(() => next.guidance.length === 1 && (currentExtra(restarted, task).pendingControls as unknown[]).length === 0);
    expect(next.guidance[0]).toEqual(brain.guidance[0]); expect(nativeExecutions).toBe(1);
    await restarted.handle(request); expect(next.guidance).toHaveLength(1);
    expect(next.calls.find(input => input.role === 'worker')?.eventId).toBe(`work-${task.id}`);
  } finally { resumedWork.resolve('完成'); work.resolve('完成'); }
});

it('uses the real HTTP question channel, validates original choices and frees running slots while waiting', async () => {
  const f = await fixture(), questionTask = f.task(), work = deferred<string>();
  f.service.store.updateCompanion(DEFAULT_BOT_COMPANION_ID, { name: '大肥鱼', workerConcurrency: 2 });
  const callId = 'native-ask-1', id = questionId(questionTask, callId), questions = [{ id: 'format', question: '请选择输出格式', options: [{ label: 'JSON' }, { label: 'Markdown' }] }];
  let questionInput: BotDshRun | undefined, answered: unknown;
  f.brain.worker = async input => {
    if (input.laneId !== `worker-${questionTask.id}`) return waitAbortably(input, work.promise);
    questionInput = input;
    expect(await callback(input, 'worker_question', callId, { questionId: id, callId, questions })).toMatchObject({ status: 200, result: { state: 'queued' } });
    while (true) {
      await waitAbortably(input, new Promise(resolve => setTimeout(() => resolve('poll'), 20)));
      const result = await callback(input, 'worker_question_result', callId, { questionId: id });
      if (result.result?.state === 'answered') { answered = result.result.answers; return '根据真实用户答案输出 JSON'; }
      if (result.result?.state === 'closed') return '问题已停止';
    }
  };
  await nudge(f.service, f.conversationId, 'launch-question');
  await waitFor(() => f.service.store.getTask(questionTask.id)?.status === 'waiting');
  const runtime = new BotTaskRuntime(f.service.store);
  expect(() => runtime.answer(f.service.store.getTask(questionTask.id)!, { caller: 'brain', source: 'companion', requestId: 'fake-peer', questionId: id, answers: [{ id: 'format', selected: ['JSON'] }] }, true)).toThrow('只有用户来源');
  const other = f.task(), third = f.task();
  await nudge(f.service, f.conversationId, 'launch-other-workers');
  await waitFor(() => f.brain.calls.filter(input => input.role === 'worker').length === 3);
  expect(f.service.store.getTask(other.id)?.status).toBe('running'); expect(f.service.store.getTask(third.id)?.status).toBe('running');
  expect(await callback(questionInput!, 'worker_question_result', callId, { questionId: id }, { laneId: `worker-${other.id}`, eventId: `work-${other.id}` })).toMatchObject({ status: 403 });
  const request = { type: 'task.control' as const, taskId: questionTask.id, conversationId: f.conversationId, operation: 'answer' as const,
    requestId: 'user-answer-once', questionId: id, answers: [{ id: 'format', selected: ['JSON'] }] };
  await expect(f.service.handle({ ...request, answers: [{ id: 'format', selected: ['invented'] }] })).rejects.toThrow('无效');
  await f.service.handle(request); await f.service.handle(request);
  await expect(f.service.handle({ ...request, answers: [{ id: 'format', selected: ['Markdown'] }] })).rejects.toThrow('对应其他内容');
  await new Promise(resolve => setTimeout(resolve, 60)); expect(answered).toBeUndefined();
  const waiting = (await f.service.handle({ type: 'task.get', conversationId: f.conversationId, taskId: questionTask.id })).task!;
  expect(waiting.attention).toMatchObject({ id, state: 'answered' }); expect(waiting).not.toHaveProperty('extra');
  expect((await taskMessages(f.service, f.conversationId)).filter(message => message.content.includes('等待回答'))).toHaveLength(1);
  work.resolve('其他任务完成');
  await waitFor(() => f.service.store.getTask(questionTask.id)?.status === 'succeeded');
  expect(answered).toEqual(request.answers);
});

it('lets the owning router answer only its bound question attention, preserving exact choices and durable deduplication', async () => {
  const f = await fixture(), task = f.task({ retryAt: Date.now() + 60000 }), runtime = new BotTaskRuntime(f.service.store);
  const callId = 'authorized-detail', id = questionId(task, callId);
  runtime.question(task, { questionId: id, callId, questions: [{ id: 'format', question: '按原目标采用JSON吗？', options: [{ label: 'JSON' }, { label: 'Markdown' }] }] });
  runtime.question(task, { questionId: id, callId, questions: [{ id: 'format', question: '按原目标采用JSON吗？', options: [{ label: 'JSON' }, { label: 'Markdown' }] }] });
  const event = attentionEvent(f.service, task, id), current = f.service.store.getTask(task.id)!;
  const answer = { caller: 'brain' as const, source: 'task' as const, sourceEventId: event.id, requestId: 'bound-answer', questionId: id, answers: [{ id: 'format', selected: ['JSON'] }] };
  for (const invalid of [
    { ...answer, sourceEventId: undefined }, { ...answer, sourceEventId: task.sourceEventId },
    { ...answer, source: 'companion' as const }, { ...answer, questionId: 'other-question' },
  ]) expect(() => runtime.answer(current, invalid, true)).toThrow('已绑定问题回执');
  const other = f.task({ retryAt: Date.now() + 60000 });
  expect(() => runtime.answer(other, answer, true)).toThrow('已绑定问题回执');
  expect(() => runtime.answer(current, { ...answer, answers: [{ id: 'format', selected: ['invented'] }] }, true)).toThrow('无效');
  expect(runtime.answer(current, answer, true)).toMatchObject({ accepted: true, questionId: id });
  expect(runtime.answer(f.service.store.getTask(task.id)!, answer, true)).toMatchObject({ accepted: true });
  expect(() => runtime.answer(current, { ...answer, answers: [{ id: 'format', selected: ['Markdown'] }] }, true)).toThrow('对应其他内容');
  expect(runtime.questionResult(current, id, callId, true)).toMatchObject({ state: 'answered', answers: answer.answers });
  expect(() => runtime.answer(current, { ...answer, requestId: 'second-answer' }, true)).toThrow('已回答');
  expect(f.service.store.taskTransaction(sql => sql.prepare('SELECT COUNT(*) AS n FROM bot_task_controls WHERE task_id=?').get(task.id))).toMatchObject({ n: 1 });
  expect(f.service.store.taskTransaction(sql => sql.prepare("SELECT COUNT(*) AS n FROM bot_inbox WHERE json_extract(payload_json,'$.attention')=?").get(`question:${id}`))).toMatchObject({ n: 1 });
});

it('routes a native question HTTP callback through the router and returns one validated automatic answer to that same worker', async () => {
  const f = await fixture(), task = f.task(), other = f.task({ retryAt: Date.now() + 60000 });
  const callId = 'router-detail', id = questionId(task, callId), questions = [{ id: 'format', question: '原目标指定JSON；是否继续？', options: [{ label: 'JSON' }, { label: 'Markdown' }] }];
  let nativeAnswers: unknown, autoAnswers = 0;
  f.brain.router = async input => {
    const context = JSON.parse(input.prompt);
    if (context.trigger.task?.questionId !== id) return '已收到';
    expect(context.trigger.task).toEqual({ taskId: task.id, questionId: id });
    expect(context.capabilities).toMatchObject({ fileAccess: 'task-authorized-host', workerSessionAccess: 'full-access' });
    expect(await callback(input, 'dsh_task_control', 'no-steering-other-task', { operation: 'send', taskId: other.id, text: '不应投递到其他任务' })).toMatchObject({ status: 400 });
    const request = { operation: 'answer', taskId: task.id, questionId: id, answers: [{ id: 'format', selected: ['JSON'] }] };
    expect(await callback(input, 'dsh_task_control', 'automatic-answer', request)).toMatchObject({ status: 200, result: { accepted: true } });
    expect(await callback(input, 'dsh_task_control', 'automatic-answer', request)).toMatchObject({ status: 200, result: { accepted: true } });
    autoAnswers++; return '按原目标继续处理。';
  };
  f.brain.worker = async input => {
    expect(await callback(input, 'worker_question', callId, { questionId: id, callId, questions })).toMatchObject({ status: 200 });
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await callback(input, 'worker_question_result', callId, { questionId: id });
      if (result.result?.state === 'answered') { nativeAnswers = result.result.answers; return '执行器按JSON完成'; }
      await waitAbortably(input, new Promise(resolve => setTimeout(() => resolve('poll'), 20)));
    }
    throw new Error('Router did not return a validated question answer');
  };
  await nudge(f.service, f.conversationId, 'launch-automatic-answer');
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  expect(nativeAnswers).toEqual([{ id: 'format', selected: ['JSON'] }]); expect(autoAnswers).toBe(1);
  expect(f.brain.guidance).toHaveLength(0); expect(f.service.store.getTask(other.id)?.status).toBe('queued');
  expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(1);
});

it('wakes the Router for each simultaneous Worker question and reads the exact bound question after an earlier answer', async () => {
  const f = await fixture(), task = f.task();
  const entries = [
    { callId: 'first-known-detail', key: 'format', selected: 'JSON' },
    { callId: 'second-known-detail', key: 'layout', selected: '紧凑' },
  ].map(entry => ({ ...entry, id: questionId(task, entry.callId) }));
  const answers = new Set<string>(), delivered: unknown[] = [];
  f.brain.router = async input => {
    const context = JSON.parse(input.prompt), entry = entries.find(item => item.id === context.trigger.task?.questionId);
    if (!entry) return '已收到';
    const status = await callback(input, 'dsh_task_control', `status-${entry.callId}`, { operation: 'status', taskId: task.id });
    expect(status).toMatchObject({ status: 200, result: { status: 'waiting', attention: { id: entry.id, state: 'queued',
      questions: [{ id: entry.key, question: `按已知要求采用${entry.selected}吗？` }] } } });
    expect(await callback(input, 'dsh_task_control', `answer-${entry.callId}`, { operation: 'answer', taskId: task.id,
      questionId: entry.id, answers: [{ id: entry.key, selected: [entry.selected] }] })).toMatchObject({ status: 200, result: { accepted: true } });
    answers.add(entry.id); return '已按原目标补充已知细节。';
  };
  f.brain.worker = async input => {
    for (const entry of entries) expect(await callback(input, 'worker_question', entry.callId, { questionId: entry.id, callId: entry.callId,
      questions: [{ id: entry.key, question: `按已知要求采用${entry.selected}吗？`, options: [{ label: entry.selected }] }] })).toMatchObject({ status: 200 });
    // Both wake-up events must run before the Worker consumes either answer.
    // An answered first question must not hide the still-queued second one.
    for (let attempt = 0; answers.size < 2 && attempt < 150; attempt++) await waitAbortably(input, new Promise(resolve => setTimeout(() => resolve('poll'), 20)));
    expect(answers.size).toBe(2);
    for (const entry of entries) {
      const answer = await callback(input, 'worker_question_result', entry.callId, { questionId: entry.id });
      expect(answer).toMatchObject({ status: 200, result: { state: 'answered', answers: [{ id: entry.key, selected: [entry.selected] }] } });
      delivered.push(answer.result?.answers);
    }
    return '原任务已按两个已知要求完成。';
  };
  await nudge(f.service, f.conversationId, 'launch-two-known-questions');
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  expect(delivered).toHaveLength(2); expect(answers.size).toBe(2);
  expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(1); expect(f.brain.guidance).toHaveLength(0);
});

it('does not use automatic question authority after cancellation or withdrawal, and never authorizes task_done as a question', async () => {
  const f = await fixture(), task = f.task({ retryAt: Date.now() + 60000 }), runtime = new BotTaskRuntime(f.service.store);
  const callId = 'still-bound', id = questionId(task, callId);
  runtime.question(task, { questionId: id, callId, questions: [{ id: 'choice', question: '需要新的用户偏好' }] });
  const event = attentionEvent(f.service, task, id);
  const answer = { caller: 'brain' as const, source: 'task' as const, sourceEventId: event.id, requestId: 'withdrawn-answer', questionId: id, answers: [{ id: 'choice', selected: [], custom: '不能伪造的偏好' }] };
  const done = f.service.store.enqueue({ conversationId: task.conversationId, senderId: 'task-service', source: 'task', recipientIds: [task.companionId],
    kind: 'task_done', content: '不能伪装提问回执', payload: { taskId: task.id, attention: `question:${id}` }, sourceMessageId: 'wrong-kind-question' }).events[0]!;
  expect(() => runtime.answer(f.service.store.getTask(task.id)!, { ...answer, sourceEventId: done.id }, true)).toThrow('已绑定问题回执');
  f.service.store.updateTask(task.id, { extra: { ...f.service.store.getTask(task.id)!.extra, cancelRequested: true } });
  expect(() => runtime.answer(f.service.store.getTask(task.id)!, answer, true)).toThrow('已关闭');
  f.service.store.withdrawSources(task.companionId, event.securityDomainId, [task.sourceEventId]);
  expect(() => runtime.answer(f.service.store.getTask(task.id)!, answer, true)).toThrow('已绑定问题回执');
});

it('upgrades the same legacy scoped task before answering, retaining its original goal, lane, event and workspace', async () => {
  const f = await fixture(), task = f.task({ workerAccess: 'scoped', nativeAttempted: true, retryAt: Date.now() + 60000 });
  const runtime = new BotTaskRuntime(f.service.store), callId = 'legacy-question', id = questionId(task, callId);
  runtime.question(task, { questionId: id, callId, questions: [{ id: 'choice', question: '是否按原目标继续？', options: [{ label: '继续' }] }] });
  f.brain.upgrading = async input => {
    expect(f.service.store.getTask(task.id)?.extra).toMatchObject({ workerAccess: 'full', workerAccessUpgradePending: true });
    expect(runtime.attention(task.id)?.state).toBe('queued');
    return { absent: true, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId };
  };
  await f.service.handle({ type: 'task.control', operation: 'answer', taskId: task.id, conversationId: f.conversationId, requestId: 'answer-legacy-question', questionId: id, answers: [{ id: 'choice', selected: ['继续'] }] });
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  expect(f.brain.upgrades).toHaveLength(1); expect(f.brain.upgrades[0]).toMatchObject({ laneId: `worker-${task.id}`, eventId: `work-${task.id}` });
  expect(f.brain.calls.find(input => input.role === 'worker')).toMatchObject({ laneId: `worker-${task.id}`, eventId: `work-${task.id}`, cwd: f.brain.upgrades[0]!.cwd, workerAccess: 'full', prompt: task.goal });
  expect(f.service.store.getTask(task.id)).toMatchObject({ id: task.id, goal: task.goal, extra: { workerAccess: 'full', workerAccessUpgradePending: false } });
  expect(f.service.store.listTasks()).toHaveLength(1);
});

it('retains a monotonic full-access intent after a lost upgrade ACK and retries without answering or downgrading early', async () => {
  const f = await fixture(), task = f.task({ workerAccess: 'scoped', nativeAttempted: true, retryAt: Date.now() + 60000 });
  const runtime = new BotTaskRuntime(f.service.store), callId = 'lost-upgrade-ack', id = questionId(task, callId);
  runtime.question(task, { questionId: id, callId, questions: [{ id: 'choice', question: '继续已授权目标？' }] });
  const answer = { type: 'task.control' as const, operation: 'answer' as const, taskId: task.id, conversationId: f.conversationId, requestId: 'answer-after-upgrade', questionId: id, answers: [{ id: 'choice', selected: [], custom: '继续原任务' }] };
  f.brain.upgrading = async () => { throw new BotDshDeliveryUnknownError('Access ACK lost', 'attach'); };
  await expect(f.service.handle(answer)).rejects.toThrow('ACK lost');
  expect(f.service.store.getTask(task.id)).toMatchObject({ status: 'waiting', extra: { workerAccess: 'full', workerAccessUpgradePending: true } });
  expect(runtime.attention(task.id)?.answers).toBeUndefined(); expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(0);
  f.brain.upgrading = async input => ({ workerAccess: 'full', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId });
  await f.service.handle(answer); await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  expect(f.brain.upgrades).toHaveLength(2); expect(f.brain.upgrades[1]!.laneId).toBe(f.brain.upgrades[0]!.laneId);
  expect(f.brain.calls.filter(input => input.role === 'worker')).toHaveLength(1);
});

it('keeps a cold unanswered task idle and resumes its exact user answer after restart', async () => {
  const f = await fixture(), task = f.task(), callId = 'cold-ask', id = questionId(task, callId);
  f.brain.worker = async input => {
    await callback(input, 'worker_question', callId, { questionId: id, callId, questions: [{ id: 'path', question: '需要保留哪个文件？' }] });
    return waitAbortably(input, new Promise<string>(() => undefined));
  };
  await nudge(f.service, f.conversationId, 'launch-cold-question'); await waitFor(() => f.service.store.getTask(task.id)?.status === 'waiting');
  await f.service.shutdown(); const next = new BrainBoundary(), resumed = f.reopen(next);
  await resumed.handle({ type: 'state', conversationId: f.conversationId }); await nudge(resumed, f.conversationId, 'wake-unanswered');
  expect(resumed.store.getTask(task.id)?.status).toBe('waiting'); expect(next.calls.filter(input => input.role === 'worker')).toHaveLength(0);
  const answers = [{ id: 'path', selected: [], custom: '只保留 final.md' }];
  await resumed.handle({ type: 'task.control', operation: 'answer', taskId: task.id, conversationId: f.conversationId, requestId: 'cold-user-answer', questionId: id, answers });
  await waitFor(() => resumed.store.getTask(task.id)?.status === 'succeeded');
  expect(next.calls.find(input => input.role === 'worker')).toMatchObject({ laneId: `worker-${task.id}`, eventId: `work-${task.id}`, answeredQuestions: [{ questionId: id, callId, answers }] });
});

it('reconciles pending effects before cold recovery and requires individual user decisions without executing unknown work', async () => {
  const f = await fixture(), task = f.task();
  const effects = [{ callId: 'write-a', toolName: 'write', argsHash: hash('write a'), argumentsPreview: 'write a' }, { callId: 'run-b', toolName: 'bash', argsHash: hash('run b'), argumentsPreview: 'run b' }];
  f.brain.worker = async input => {
    for (const effect of effects) expect(await callback(input, 'worker_effect_start', effect.callId, effect)).toMatchObject({ status: 200, result: { state: 'admitted' } });
    throw new BotDshDeliveryUnknownError('hard loss after external mutation; native results absent');
  };
  await nudge(f.service, f.conversationId, 'launch-effects'); await waitFor(() => Number(currentExtra(f.service, task).retryAttempts) === 1);
  await f.service.shutdown();
  const next = new BrainBoundary(), resumed = f.reopen(next);
  resumed.store.updateTask(task.id, { extra: { ...currentExtra(resumed, task), retryAt: 0 } });
  await nudge(resumed, f.conversationId, 'recover-effects'); await waitFor(() => resumed.store.getTask(task.id)?.status === 'unknown');
  expect(next.inspections[0]).toMatchObject({ laneId: `worker-${task.id}`, eventId: `work-${task.id}`, callIds: effects.map(effect => effect.callId) });
  expect(next.calls.filter(input => input.role === 'worker')).toHaveLength(0);
  const card = (await resumed.handle({ type: 'task.get', conversationId: f.conversationId, taskId: task.id })).task!;
  expect(card.pendingEffects).toHaveLength(2); expect(card).not.toHaveProperty('extra');
  const request = { type: 'task.control' as const, operation: 'resume' as const, taskId: task.id, conversationId: f.conversationId, requestId: 'verify-effects',
    text: '已检查文件 a 存在且内容正确；命令 b 未执行，允许重试一次。', effectResolutions: [{ callId: effects[0]!.callId, decision: 'already_applied' as const }, { callId: effects[1]!.callId, decision: 'retry' as const }] };
  await expect(resumed.handle({ ...request, text: '' })).rejects.toThrow();
  await expect(resumed.handle({ ...request, effectResolutions: request.effectResolutions.slice(0, 1) })).rejects.toThrow('逐项核实');
  const replies: Array<Record<string, unknown> | undefined> = []; let actualExecutions = 0;
  next.worker = async input => {
    const applied = { ...effects[0]!, callId: 'changed-write-id' };
    replies.push((await callback(input, 'worker_effect_start', applied.callId, applied)).result);
    const retry = { ...effects[1]!, callId: 'authorized-b' };
    const admitted = await callback(input, 'worker_effect_start', retry.callId, retry); replies.push(admitted.result);
    if (admitted.result?.state === 'admitted') actualExecutions++;
    expect(await callback(input, 'worker_effect_commit', retry.callId, { callId: retry.callId, toolName: retry.toolName, argsHash: retry.argsHash, isError: true })).toMatchObject({ status: 200 });
    const repaired = { ...retry, callId: 'repair-after-known-failure' };
    replies.push((await callback(input, 'worker_effect_start', repaired.callId, repaired)).result);
    await callback(input, 'worker_effect_commit', repaired.callId, { callId: repaired.callId, toolName: repaired.toolName, argsHash: repaired.argsHash, isError: false });
    return '已依据用户核实和实际错误结果完成修复';
  };
  await resumed.handle(request); await resumed.handle(request);
  await expect(resumed.handle({ ...request, text: '另一份核实说明' })).rejects.toThrow('对应其他内容');
  await waitFor(() => resumed.store.getTask(task.id)?.status === 'succeeded');
  expect(replies).toEqual([expect.objectContaining({ state: 'already_committed', provenance: 'user_verified_applied' }),
    expect.objectContaining({ state: 'admitted', provenance: 'authorized_retry' }), expect.objectContaining({ state: 'admitted' })]);
  expect(replies[2]).not.toHaveProperty('provenance', 'authorized_retry'); expect(actualExecutions).toBe(1);
});

it('blocks a changed call ID while the same operation is unresolved, including a lost admission acknowledgement', async () => {
  const f = await fixture(), task = f.task();
  const effect = { callId: 'lost-start-ack', toolName: 'write', argsHash: hash('same write'), argumentsPreview: 'write final.md' };
  const runtime = new BotTaskRuntime(f.service.store);
  expect(runtime.startEffect(task, effect)).toMatchObject({ state: 'admitted' });
  expect(runtime.startEffect(task, { ...effect, callId: 'different-id-same-mutation' })).toMatchObject({ state: 'blocked' });
  expect(f.service.store.getTask(task.id)?.status).toBe('unknown'); expect(runtime.pendingEffects(task.id).map(item => item.callId)).toEqual([effect.callId]);
  expect(() => runtime.resume(f.service.store.getTask(task.id)!, { caller: 'brain', source: 'user', requestId: 'fake-tool-resume', text: '看起来没发生', effectResolutions: [{ callId: effect.callId, decision: 'retry' }] })).toThrow('只有用户界面');
});

it('never treats a mismatched native result as proof and rejects contradictory durable commits', async () => {
  const f = await fixture(), task = f.task(), runtime = new BotTaskRuntime(f.service.store);
  const effect = { callId: 'effect-proof', toolName: 'write', argsHash: hash('expected'), argumentsPreview: 'expected mutation' };
  runtime.startEffect(task, effect);
  expect(runtime.reconcileEffects(task, [{ callId: effect.callId, toolName: effect.toolName, argsHash: hash('other arguments'), state: 'committed' }])).toBe(false);
  expect(runtime.pendingEffects(task.id)).toHaveLength(1);
  expect(runtime.reconcileEffects(f.service.store.getTask(task.id)!, [{ ...effect, state: 'failed' }])).toBe(true);
  expect(() => runtime.commitEffect(task, { callId: effect.callId, toolName: effect.toolName, argsHash: effect.argsHash, isError: false })).toThrow('不能改写');
  expect(runtime.commitEffect(task, { callId: effect.callId, toolName: effect.toolName, argsHash: effect.argsHash, isError: true })).toMatchObject({ recorded: true });
});

it('uses raw committed failure proof after a lost result ACK and preserves the full coding repair loop', async () => {
  const f = await fixture(), task = f.task(), effect = { callId: 'compile', toolName: 'bash', argsHash: hash('compile'), argumentsPreview: 'compile project' };
  let calls = 0;
  f.brain.inspecting = async () => [{ ...effect, state: 'failed' }];
  f.brain.worker = async input => {
    if (++calls === 1) { await callback(input, 'worker_effect_start', effect.callId, effect); throw new BotDshDeliveryUnknownError('native error result durable, host commit lost'); }
    const same = await callback(input, 'worker_effect_start', effect.callId, effect); expect(same.result).toMatchObject({ state: 'already_committed', provenance: 'native_committed' });
    const repair = { ...effect, callId: 'repair-call' }; expect((await callback(input, 'worker_effect_start', repair.callId, repair)).result).toMatchObject({ state: 'admitted' });
    await callback(input, 'worker_effect_commit', repair.callId, { callId: repair.callId, toolName: repair.toolName, argsHash: repair.argsHash, isError: false }); return '编译错误已修复';
  };
  await nudge(f.service, f.conversationId, 'launch-compile'); await waitFor(() => Number(currentExtra(f.service, task).retryAttempts) === 1);
  f.service.store.updateTask(task.id, { extra: { ...currentExtra(f.service, task), retryAt: 0 } }); await nudge(f.service, f.conversationId, 'recover-compile');
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded'); expect(calls).toBe(2); expect(f.brain.inspections).toHaveLength(1);
});

it('keeps a user resume receipt authoritative when the older paused worker stream detaches late', async () => {
  const f = await fixture(), task = f.task(), effect = { callId: 'uncertain', toolName: 'write', argsHash: hash('uncertain write'), argumentsPreview: 'write result' };
  const detach = deferred<string>(); let runs = 0;
  f.brain.worker = async input => {
    if (++runs === 1) {
      await callback(input, 'worker_effect_start', effect.callId, effect);
      expect((await callback(input, 'worker_effect_start', 'changed-id', { ...effect, callId: 'changed-id' })).result).toMatchObject({ state: 'blocked' });
      await waitAbortably(input, detach.promise); throw new BotDshEffectUnknownError(effect.callId);
    }
    return '已按用户核实继续';
  };
  await nudge(f.service, f.conversationId, 'launch-late-detach'); await waitFor(() => f.service.store.getTask(task.id)?.status === 'unknown');
  await f.service.handle({ type: 'task.control', taskId: task.id, conversationId: f.conversationId, operation: 'resume', requestId: 'user-before-detach',
    text: '已核对结果文件，操作已经完成。', effectResolutions: [{ callId: effect.callId, decision: 'already_applied' }] });
  detach.resolve('detach');
  await waitFor(() => f.service.store.getTask(task.id)?.status === 'succeeded'); expect(runs).toBe(2);
});

it('cancels a cold unknown task through durable native proof without replaying or erasing its pending-effect gate', async () => {
  const f = await fixture(), task = f.task({ nativeAttempted: true }), runtime = new BotTaskRuntime(f.service.store);
  const effect = { callId: 'unknown-before-cancel', toolName: 'bash', argsHash: hash('unconfirmed command'), argumentsPreview: 'external command' };
  runtime.startEffect(task, effect); runtime.markUnknown(task);
  await f.service.shutdown(); const next = new BrainBoundary(), resumed = f.reopen(next);
  await resumed.handle({ type: 'task.control', taskId: task.id, conversationId: f.conversationId, operation: 'cancel', requestId: 'cancel-unknown' });
  await waitFor(() => resumed.store.getTask(task.id)?.status === 'cancelled');
  expect(next.stops).toHaveLength(1); expect(next.calls.filter(input => input.role === 'worker')).toHaveLength(0);
  expect(new BotTaskRuntime(resumed.store).pendingEffects(task.id)).toMatchObject([{ callId: effect.callId }]);
});

it('retires only natively consumed answer batches and atomically resumes the raw proof cursor after a cold retry', async () => {
  const f = await fixture(), task = f.task(), runtime = new BotTaskRuntime(f.service.store);
  for (const callId of ['old-answer', 'new-answer']) {
    const id = questionId(task, callId);
    runtime.question(task, { questionId: id, callId, questions: [{ id: 'item', question: `确认 ${callId}` }] });
    runtime.answer(f.service.store.getTask(task.id)!, { caller: 'user', requestId: `answer-${callId}`, questionId: id, answers: [{ id: 'item', selected: [], custom: `真实答案 ${callId}` }] }, false);
  }
  const saved = runtime.answeredQuestions(task.id);
  expect(() => runtime.recordAnswerProofs(task.id, [saved[0]!, { ...saved[1]!, answers: [{ id: 'item', selected: [], custom: 'corrupted' }] }],
    saved.map(answer => ({ questionId: answer.questionId, state: 'committed', observedThrough: 23 })))).toThrow('不属于已保存答案');
  expect(runtime.answeredQuestions(task.id)).toHaveLength(2); expect(runtime.answerCursor(task.id)).toBe(0);
  f.service.store.updateTask(task.id, { extra: { ...currentExtra(f.service, task), nativeAttempted: true } });
  await f.service.shutdown();
  const next = new BrainBoundary(); let runs = 0;
  next.inspectingAnswers = async input => input.questions.map(question => ({ questionId: question.questionId,
    state: question.callId === 'old-answer' || runs > 0 ? 'committed' : 'unknown', observedThrough: runs ? 31 : 23 }));
  next.worker = async () => { if (++runs === 1) throw new BotDshDeliveryUnknownError('cold injected answer persisted before stream loss'); return '继续完成'; };
  const resumed = f.reopen(next);
  await resumed.handle({ type: 'state', conversationId: f.conversationId });
  await waitFor(() => Number(currentExtra(resumed, task).retryAttempts) === 1);
  expect(next.calls.find(input => input.role === 'worker')?.answeredQuestions?.map(answer => answer.callId)).toEqual(['new-answer']);
  expect(next.questionInspections[0]).toMatchObject({ afterOffset: 0, questions: saved.map(answer => ({ questionId: answer.questionId, callId: answer.callId, answersHash: hash(JSON.stringify(answer.answers)) })) });
  resumed.store.updateTask(task.id, { extra: { ...currentExtra(resumed, task), retryAt: 0 } }); await nudge(resumed, f.conversationId, 'resume-consumed-answer');
  await waitFor(() => resumed.store.getTask(task.id)?.status === 'succeeded');
  expect(next.questionInspections[1]).toMatchObject({ afterOffset: 23, questions: [{ callId: 'new-answer' }] });
  expect(next.calls.filter(input => input.role === 'worker')[1]?.answeredQuestions).toEqual([]);
  const restored = new BotTaskRuntime(resumed.store); expect(restored.answerCursor(task.id)).toBe(31); expect(restored.answeredQuestions(task.id)).toEqual([]);
});

it('binds distinct child sessions with the same local tool ID to separate durable effects and inspects the actual child after restart', async () => {
  const f = await fixture(), task = f.task(), localCallId = 'native-child-call';
  const effects = ['child-session-a', 'child-session-b'].map((nativeSessionId, index) => ({
    callId: 'child-' + hash(`${nativeSessionId}:${localCallId}`).slice(0, 48), nativeSessionId, nativeCallId: localCallId,
    toolName: 'write', argsHash: hash(`child write ${index}`), argumentsPreview: `child write ${index}`,
  }));
  f.brain.worker = async input => {
    for (const effect of effects) expect((await callback(input, 'worker_effect_start', effect.callId, effect)).result).toMatchObject({ state: 'admitted' });
    throw new BotDshDeliveryUnknownError('children mutated; parent stream lost');
  };
  await nudge(f.service, f.conversationId, 'launch-children'); await waitFor(() => Number(currentExtra(f.service, task).retryAttempts) === 1);
  await f.service.shutdown();
  const next = new BrainBoundary(); next.inspecting = async () => [{ ...effects[0]!, state: 'committed' }, { ...effects[1]!, state: 'unknown' }];
  const resumed = f.reopen(next); resumed.store.updateTask(task.id, { extra: { ...currentExtra(resumed, task), retryAt: 0 } });
  await nudge(resumed, f.conversationId, 'recover-children'); await waitFor(() => resumed.store.getTask(task.id)?.status === 'unknown');
  expect(next.inspections[0]?.effects).toEqual(effects.map(effect => ({ callId: effect.callId, nativeSessionId: effect.nativeSessionId, nativeCallId: effect.nativeCallId })));
  expect(next.calls.filter(input => input.role === 'worker')).toHaveLength(0);
  const pending = new BotTaskRuntime(resumed.store).pendingEffects(task.id);
  expect(pending).toMatchObject([{ callId: effects[1]!.callId, nativeSessionId: effects[1]!.nativeSessionId, nativeCallId: localCallId }]);
  expect(() => new BotTaskRuntime(resumed.store).commitEffect(task, { callId: effects[1]!.callId, toolName: effects[1]!.toolName, argsHash: effects[1]!.argsHash,
    nativeCallId: localCallId, nativeSessionId: effects[0]!.nativeSessionId, isError: false })).toThrow('会话与调用标识不匹配');
});

it('keeps answer consumption cursors independent for child sessions and never retires an answer from a sibling proof', async () => {
  const f = await fixture(), task = f.task(), runtime = new BotTaskRuntime(f.service.store), local = 'same-ask-id';
  const children = ['question-child-one', 'question-child-two'];
  for (const nativeSessionId of children) {
    const callId = 'child-' + hash(`${nativeSessionId}:${local}`).slice(0, 48), id = questionId(task, callId);
    runtime.question(task, { questionId: id, callId, nativeSessionId, nativeCallId: local, questions: [{ id: 'choice', question: '本子任务应保留什么？' }] });
    runtime.answer(f.service.store.getTask(task.id)!, { caller: 'user', requestId: `answer-${nativeSessionId}`, questionId: id, answers: [{ id: 'choice', selected: [], custom: nativeSessionId }] }, false);
  }
  const answers = runtime.answeredQuestions(task.id), first = answers.find(answer => answer.nativeSessionId === children[0])!, second = answers.find(answer => answer.nativeSessionId === children[1])!;
  expect(() => runtime.recordAnswerProofs(task.id, [first], [{ questionId: first.questionId, nativeSessionId: children[1], state: 'committed', observedThrough: 400 }])).toThrow('其他会话');
  expect(runtime.answeredQuestions(task.id)).toHaveLength(2);
  runtime.recordAnswerProofs(task.id, answers, [{ questionId: first.questionId, nativeSessionId: children[0], state: 'committed', observedThrough: 400 },
    { questionId: second.questionId, nativeSessionId: children[1], state: 'unknown', observedThrough: 6 }]);
  expect(runtime.answerCursor(task.id, children[0])).toBe(400); expect(runtime.answerCursor(task.id, children[1])).toBe(6); expect(runtime.answerCursor(task.id)).toBe(0);
  expect(runtime.answeredQuestions(task.id)).toMatchObject([{ questionId: second.questionId, nativeCallId: local }]);
  runtime.recordAnswerProofs(task.id, [second], [{ questionId: second.questionId, nativeSessionId: children[1], state: 'committed', observedThrough: 9 }]);
  expect(runtime.answerCursor(task.id, children[0])).toBe(400); expect(runtime.answerCursor(task.id, children[1])).toBe(9); expect(runtime.answeredQuestions(task.id)).toEqual([]);
});
