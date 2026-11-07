import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshCancelAck, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import type { BotTask } from '../../src/main/companion-bot/types';
import { reportWorkerOutcome } from '../fixtures/bot-worker-report';

type ControlInput = Omit<BotDshRun, 'prompt' | 'onEvent'>;
const owners: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of owners.splice(0).reverse()) await close(); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw Error('Pause lifecycle condition timed out.'); await delay(15); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class MemoryBoundary extends BotMemoryService {
  private prepared = new Map<string, BotMemoryPrepared>();
  constructor(root: string) { super({ root, runtime: async () => { throw Error('Unexpected native memory startup.'); }, embedding: async () => { throw Error('Unexpected embedding call.'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    const prepared = { requestId: input.requestId, scope: input.scope, inputHash: 'pause-boundary', messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 } as BotMemoryPrepared;
    this.prepared.set(input.requestId, prepared); return prepared;
  }
  override async resumePrepared(input: Parameters<BotMemoryService['resumePrepared']>[0]) { return this.prepared.get(input.requestId)!; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { appended: [] }; }
  override async finishTurn() { return { recorded: true }; }
}
class BrainBoundary extends BotDshBrain {
  calls: BotDshRun[] = [];
  controls: Array<{ input: ControlInput; suspend: boolean }> = [];
  effectInspections = 0;
  stopping: (input: ControlInput, suspend: boolean) => Promise<BotDshCancelAck> = async (input, suspend) => ({ accepted: true,
    ...(suspend ? { paused: true } : { absent: true }), eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) });
  constructor() { super({ getHost: async () => { throw Error('Pause regression never launches DSH.'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    this.calls.push(input);
    if (input.role === 'worker') await reportWorkerOutcome(input, { state: 'ready', summary: '原任务已经继续并完成。', verification: ['受控执行脚本已沿原任务完成。'] });
    return { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded',
      text: input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : input.role === 'worker' ? '原任务已经继续并完成。' : '已收到任务状态。' };
  }
  override async cancelDurable(input: ControlInput, suspend = false) { this.controls.push({ input, suspend }); return this.stopping(input, suspend); }
  override async inspectEffects(input: Parameters<BotDshBrain['inspectEffects']>[0]) { this.effectInspections++; return (input.callIds ?? input.effects?.map(effect => effect.callId) ?? []).map(callId => ({ callId, state: 'unknown' as const })); }
  override async archive() {}
  override async close() {}
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-task-pause-')), services: BotService[] = [];
  let configured = false;
  const open = (brain: BrainBoundary) => {
    const service = new BotService({ root, brainRuntime: 'worldlinebox', brain, memory: new MemoryBoundary(path.join(root, 'memory')),
      model: () => {
        if (!configured) throw Error('The fixture has no configured chat model.');
        return { apiFormat: 'openai_chat', model: 'local-boundary', baseUrl: 'http://127.0.0.1:9', apiKey: 'not-a-provider-key' };
      }, onEvent: () => undefined });
    services.push(service); return service;
  };
  const brain = new BrainBoundary(), service = open(brain), room = (await service.handle({ type: 'state' })).snapshot!.conversations[0]!;
  owners.push(async () => { for (const current of services) await current.shutdown(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-task-pause-')) throw Error('Unexpected pause fixture root.'); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  let sequence = 0;
  const task = (extra: Record<string, unknown> = {}) => {
    const source = service.store.enqueue({ conversationId: room.id, senderId: 'user', source: 'user', recipientIds: [DEFAULT_BOT_COMPANION_ID], sourceMessageId: `pause-source-${++sequence}`, content: '继续时必须保留这个原始用户目标。' }).events[0]!;
    const claim = service.store.claim({ workerId: 'pause-source' });
    if (!claim || claim.event.id !== source.id || !service.store.settle({ eventId: source.id, leaseToken: claim.leaseToken, status: 'done', content: '保留来源。' })) throw Error('Source was not settled before scheduling.');
    return service.store.createTask({ conversationId: room.id, companionId: DEFAULT_BOT_COMPANION_ID, sourceEventId: source.id, goal: '原来的委派任务目标。', extra: { workerAccess: 'full', retryAt: Date.now() + 60000, ...extra } });
  };
  const control = (id: string, operation: 'pause' | 'resume_paused' | 'cancel', requestId: string, current = service) => current.handle({ type: 'task.control', conversationId: room.id, taskId: id, operation, requestId });
  return { root, brain, service, room, task, control, open, configure: () => { configured = true; } };
}

it('pauses a never-dispatched queued task locally, survives restart, and resumes the same task/event only after the user requests it', async () => {
  const f = await fixture(), task = f.task();
  await f.control(task.id, 'pause', 'pause-before-admission');
  expect(f.service.store.getTask(task.id)).toMatchObject({ status: 'paused' });
  expect(f.brain.calls).toHaveLength(0); expect(f.brain.controls).toHaveLength(0);
  expect(f.service.store.pendingTasks().map(value => value.id)).not.toContain(task.id);
  await f.service.shutdown(); const next = new BrainBoundary(), reopened = f.open(next);
  await reopened.handle({ type: 'state', conversationId: f.room.id }); await delay(650);
  expect(reopened.store.getTask(task.id)).toMatchObject({ status: 'paused', sourceEventId: task.sourceEventId }); expect(next.calls).toHaveLength(0);
  f.configure(); await f.control(task.id, 'resume_paused', 'explicit-resume', reopened);
  await until(() => reopened.store.getTask(task.id)?.status === 'succeeded');
  const calls = next.calls.filter(value => value.role === 'worker'); expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ laneId: `worker-${task.id}`, eventId: `work-${task.id}` });
  expect(reopened.store.getTask(task.id)).toMatchObject({ id: task.id, sourceEventId: task.sourceEventId, attemptId: task.attemptId });
  expect(reopened.store.listTasks()).toHaveLength(1);
  await f.control(task.id, 'resume_paused', 'explicit-resume', reopened); expect(next.calls.filter(value => value.role === 'worker')).toHaveLength(1);
});

it('pauses immediately while native suspension is collected separately, then stops without executing it', async () => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, workerPrompt: 'FROZEN_ORIGINAL_WORKER_REQUEST' }), gate = deferred<BotDshCancelAck>();
  f.brain.stopping = async (_input, suspend) => suspend ? gate.promise : { accepted: false, absent: true };
  await f.control(task.id, 'pause', 'pause-attempted'); await until(() => f.brain.controls.length === 1);
  expect(f.brain.controls[0]!.suspend).toBe(true); expect(f.brain.calls.filter(value => value.role === 'worker')).toHaveLength(0);
  expect(f.service.store.getTask(task.id)?.status).toBe('paused');
  const input = f.brain.controls[0]!.input;
  gate.resolve({ accepted: true, paused: true, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) });
  await until(() => (f.service.store.getTask(task.id)!.extra.executorControl as {state:string}).state === 'acknowledged');
  const card = (await f.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: task.id })).task!;
  expect(card).toMatchObject({ status: 'paused', pausedAt: expect.any(String) });
  await f.control(task.id, 'cancel', 'cancel-paused'); await until(() => f.service.store.getTask(task.id)?.status === 'cancelled');
  await until(() => f.brain.controls.at(-1)!.suspend === false); expect(f.brain.controls.at(-1)!.suspend).toBe(false); expect(f.brain.calls.filter(value => value.role === 'worker')).toHaveLength(0);
});

it('reattaches pause cleanup and the resumed worker with exactly the original companion tool catalog', async () => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, workerPrompt: 'ORIGINAL_NATIVE_REQUEST' }); f.configure();
  await f.control(task.id, 'pause', 'catalog-preserving-pause');
  await until(() => f.brain.controls.length === 1 && (f.service.store.getTask(task.id)!.extra.executorControl as { state: string }).state === 'acknowledged');
  const suspended = f.brain.controls[0]!.input;
  await f.control(task.id, 'resume_paused', 'catalog-preserving-resume');
  await until(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  const execution = f.brain.calls.find(input => input.role === 'worker')!;
  expect(execution).toBeDefined(); expect(suspended.workerTools?.map(tool => tool.name)).toContain('worker_chat_send_file');
  expect(suspended.workerTools).toEqual(execution.workerTools); expect(suspended.tools).toEqual(execution.tools);
  expect(suspended).toMatchObject({ laneId: execution.laneId, eventId: execution.eventId });
  expect(f.service.store.listTasks()).toHaveLength(1);
});

it('keeps the local pause stable while bounded native cleanup fails and retries only cleanup on explicit resume', async () => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, workerPrompt: 'FROZEN_REQUEST' });
  f.brain.stopping = async () => ({ accepted: true });
  await f.control(task.id, 'pause', 'pause-without-proof');
  expect(f.service.store.getTask(task.id)?.status).toBe('paused');
  const state = () => f.service.store.getTask(task.id)!.extra.executorControl as {state:string; attempts:number;retryAt:number};
  await until(() => state().attempts === 1);
  const first = f.service.store.getTask(task.id)!.extra.pauseRequestedAt;
  for (const attempts of [2, 3]) {
    const current = f.service.store.getTask(task.id)!;
    f.service.store.updateTask(task.id, { extra: { ...current.extra, executorControl: {...state(),retryAt:0} } });
    await until(() => state().attempts >= attempts);
  }
  expect(state().state).toBe('unavailable');
  const count = f.brain.controls.length; await delay(1100); expect(f.brain.controls).toHaveLength(count);
  expect(f.service.store.getTask(task.id)).toMatchObject({status:'paused',extra:{pauseRequestedAt:first}});
  expect(f.service.store.pendingTasks()).toHaveLength(0);
});

it.each(['succeeded', 'failed', 'cancelled'] as const)('preserves native %s separately from business completion when pause races a terminal receipt', async status => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, workerPrompt: 'ORIGINAL_REQUEST' });
  f.brain.stopping = async input => ({ accepted: true, result: { eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), status, text: '原生持久终态。' } });
  const business = 'paused';
  await f.control(task.id, 'pause', 'terminal-race'); await until(() => !!f.service.store.getTask(task.id)!.extra.turnOutcome);
  expect(f.service.store.getTask(task.id)?.status).toBe(business);
  expect(f.service.store.getTask(task.id)!.extra.turnOutcome).toMatchObject({ status });
  expect(f.service.store.getTask(task.id)!.extra.pausedAt).toBeDefined();
  expect((f.service.store.getTask(task.id)!.extra.executorControl as {state:string}).state).toBe('acknowledged');
});

it('requires explicit user permission to resume and preserves unresolved effects as a gate rather than replaying the task', async () => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, workerPrompt: 'ORIGINAL_REQUEST' }), runtime = new BotTaskRuntime(f.service.store);
  runtime.startEffect(task, { callId: 'uncertain-before-pause', toolName: 'write', argsHash: createHash('sha256').update('uncertain write').digest('hex'), argumentsPreview: 'The write outcome is still unconfirmed.' });
  await f.control(task.id, 'pause', 'pause-effect'); await until(() => f.service.store.getTask(task.id)?.status === 'paused');
  const host = f.service as unknown as { controlTask(task: BotTask, operation: 'resume_paused', text: undefined, requestId: string, input: { caller: 'brain'; source: 'task' }): Promise<unknown> };
  await expect(host.controlTask(f.service.store.getTask(task.id)!, 'resume_paused', undefined, 'automatic-resume-denied', { caller: 'brain', source: 'task' })).rejects.toThrow();
  expect(f.service.store.getTask(task.id)?.status).toBe('paused');
  f.configure(); await f.control(task.id, 'resume_paused', 'user-resumes-effect-gated');
  await until(() => f.service.store.getTask(task.id)?.status === 'unknown' || f.brain.effectInspections > 0);
  expect(runtime.pendingEffects(task.id)).toMatchObject([{ callId: 'uncertain-before-pause' }]);
  expect(f.brain.calls.filter(value => value.role === 'worker')).toHaveLength(0);
  expect(f.service.store.getTask(task.id)?.status).not.toBe('succeeded');
});

it('keeps an answered question queued while paused even if an earlier native poll has a running slot', async () => {
  const f = await fixture(), task = f.task(), runtime = new BotTaskRuntime(f.service.store), callId = 'question-at-pause';
  const questionId = 'question-' + createHash('sha256').update(`work-${task.id}:${callId}`).digest('hex').slice(0, 48);
  runtime.question(task, { callId, questionId, questions: [{ id: 'decision', question: 'Continue with the original task?' }] });
  runtime.answer(f.service.store.getTask(task.id)!, { requestId: 'saved-answer', caller: 'user', questionId, answers: [{ id: 'decision', selected: [], custom: 'Keep the original scope.' }] }, false);
  await f.control(task.id, 'pause', 'pause-before-answer-poll');
  expect(runtime.questionResult(f.service.store.getTask(task.id)!, questionId, callId, true)).toMatchObject({ state: 'queued' });
  expect(f.service.store.getTask(task.id)?.status).toBe('paused');
  expect(runtime.hasReadyAnswer(task.id)).toBe(true);
});

it('ignores an old transport emitter and result after pause and resume of the same task', async () => {
  const f = await fixture(), task = f.task(), first = deferred<BotDshResult>();
  const originalRun = f.brain.run.bind(f.brain); let oldInput: BotDshRun | undefined;
  f.brain.run = async input => {
    if (input.role === 'worker' && !oldInput) { oldInput = input; f.brain.calls.push(input); return first.promise; }
    return originalRun(input);
  };
  f.configure(); f.service.store.updateTask(task.id, { extra: { ...task.extra, retryAt: 0 } });
  await until(() => !!oldInput);
  await f.control(task.id, 'pause', 'pause-ignored-abort-worker');
  await until(() => (f.service.store.getTask(task.id)!.extra.executorControl as {state:string}).state === 'acknowledged');
  expect(f.service.store.getTask(task.id)?.status).toBe('paused');
  await f.control(task.id, 'resume_paused', 'resume-same-task');
  await until(() => f.service.store.getTask(task.id)?.status === 'succeeded');
  const before = f.service.store.getTask(task.id)!;
  oldInput!.onEvent?.({ type: 'session', stage: 'tool_start', sessionId: 'old-wrong-session', toolName: 'old-tool', sequence: 999, receivedAt: new Date().toISOString() });
  first.resolve({ eventId: oldInput!.eventId, sessionId: 'old-wrong-session', status: 'succeeded', text: 'Old uncooperative result.' });
  await delay(50);
  expect(f.service.store.getTask(task.id)).toEqual(before);
});
