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
  owners.push(async () => { for (const current of services) await current.shutdown(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-task-pause-')) throw Error('Unexpected pause fixture root.'); await rm(root, { recursive: true, force: true }); });
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

it('does not claim an attempted task paused until an identity-bound durable suspend acknowledgement arrives, then can cancel it without executing it', async () => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, workerPrompt: 'FROZEN_ORIGINAL_WORKER_REQUEST' }), gate = deferred<BotDshCancelAck>();
  f.brain.stopping = async (_input, suspend) => suspend ? gate.promise : { accepted: false, absent: true };
  await f.control(task.id, 'pause', 'pause-attempted'); await until(() => f.brain.controls.length === 1);
  expect(f.brain.controls[0]!.suspend).toBe(true); expect(f.brain.calls.filter(value => value.role === 'worker')).toHaveLength(0);
  expect(f.service.store.getTask(task.id)?.status).not.toBe('paused');
  const input = f.brain.controls[0]!.input;
  gate.resolve({ accepted: true, paused: true, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) });
  await until(() => f.service.store.getTask(task.id)?.status === 'paused');
  const card = (await f.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: task.id })).task!;
  expect(card).toMatchObject({ status: 'paused', pausedAt: expect.any(String) });
  await f.control(task.id, 'cancel', 'cancel-paused'); await until(() => f.service.store.getTask(task.id)?.status === 'cancelled');
  expect(f.brain.controls.at(-1)!.suspend).toBe(false); expect(f.brain.calls.filter(value => value.role === 'worker')).toHaveLength(0);
});

it('bounds missing pause proof instead of treating plain accepted as paused and permits a new explicit reconciliation request', async () => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, workerPrompt: 'FROZEN_REQUEST' });
  f.brain.stopping = async () => ({ accepted: true });
  await f.control(task.id, 'pause', 'pause-without-proof');
  await until(() => f.brain.controls.length >= 1 && Number(f.service.store.getTask(task.id)!.extra.pauseRecoveryAttempts) >= 1);
  const first = f.service.store.getTask(task.id)!.extra.pauseRequestedAt;
  for (const attempts of [2, 3]) {
    const current = f.service.store.getTask(task.id)!; f.service.store.updateTask(task.id, { extra: { ...current.extra, retryAt: 0 } });
    await until(() => f.brain.controls.length >= attempts && Number(f.service.store.getTask(task.id)!.extra.pauseRecoveryAttempts) >= attempts);
  }
  expect(f.service.store.getTask(task.id)).toMatchObject({ status: 'waiting', extra: { pauseRecoveryPaused: true, progress: { phase: 'pause-unconfirmed' } } });
  const count = f.brain.controls.length; await delay(1100); expect(f.brain.controls).toHaveLength(count);
  f.brain.stopping = async input => ({ accepted: true, paused: true, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId });
  await f.control(task.id, 'pause', 'pause-new-user-request'); await until(() => f.service.store.getTask(task.id)?.status === 'paused');
  expect(f.service.store.getTask(task.id)!.extra.pauseRequestedAt).toBe(first);
});

it.each(['succeeded', 'failed', 'cancelled'] as const)('preserves native %s separately from business completion when pause races a terminal receipt', async status => {
  const f = await fixture(), task = f.task({ nativeAttempted: true, workerPrompt: 'ORIGINAL_REQUEST' });
  f.brain.stopping = async input => ({ accepted: true, result: { eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), status, text: '原生持久终态。' } });
  const business = status === 'succeeded' ? 'paused' : status;
  await f.control(task.id, 'pause', 'terminal-race'); await until(() => f.service.store.getTask(task.id)?.status === business);
  expect(f.service.store.getTask(task.id)?.status).toBe(business);
  expect(f.service.store.getTask(task.id)!.extra.turnOutcome).toMatchObject({ status });
  if (status === 'succeeded') expect(f.service.store.getTask(task.id)!.extra.pausedAt).toBeDefined();
  else expect(f.service.store.getTask(task.id)?.summary).toBe('原生持久终态。');
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
