import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { BotTaskReports, type BotWorkerReport } from '../../src/main/companion-bot/task-report';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { reportWorkerOutcome } from '../fixtures/bot-worker-report';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wlb-task-report-'));
  cleanup.push(async () => { if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('wlb-task-report-')) throw Error('Invalid report fixture cleanup'); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
function storeFixture(directory: string) {
  const store = new BotStore(path.join(directory, 'bot.sqlite')); cleanup.push(async () => store.close());
  store.createCompanion({ id: 'alice', name: 'Alice', persona: 'test' });
  const room = store.openDirect('alice'), source = store.enqueue({ conversationId: room.id, senderId: 'user', content: '只读解释结果' }).events[0]!;
  const task = store.createTask({ conversationId: room.id, companionId: 'alice', sourceEventId: source.id, goal: '只读解释结果' });
  store.updateTask(task.id, { status: 'running', extra: { ...task.extra, nativeAttempted: true } });
  const runtime = new BotTaskRuntime(store), reports = new BotTaskReports(store), nativeSessionId = BotDshBrain.sessionId(`worker-${task.id}`);
  const report = (callId: string, body: BotWorkerReport, native = nativeSessionId) => {
    runtime.startEffect(store.getTask(task.id)!, { callId, toolName: 'worker_report', argsHash: 'a'.repeat(64), argumentsPreview: body.summary });
    const result = reports.record(store.getTask(task.id)!, callId, { ...body, nativeSessionId: native, nativeCallId: callId });
    runtime.commitEffect(store.getTask(task.id)!, { callId, toolName: 'worker_report', argsHash: 'a'.repeat(64), isError: false });
    return result;
  };
  return { store, task, runtime, reports, report, nativeSessionId };
}

it('stores an immutable root report with real tool provenance and accepts text-only verification', async () => {
  const f = storeFixture(await root()), ready: BotWorkerReport = { state: 'ready', summary: '解释已完成', verification: ['逐项核对了用户给出的三项条件，正文已给出结论。'] };
  const saved = f.report('report-1', ready);
  expect(f.reports.current(f.store.getTask(f.task.id)!)).toEqual(saved);
  expect(f.reports.record(f.task, 'report-1', { ...ready, nativeSessionId: f.nativeSessionId, nativeCallId: 'report-1' })).toEqual(saved);
  expect(() => f.reports.record(f.task, 'report-1', { ...ready, summary: '改写结果', nativeSessionId: f.nativeSessionId, nativeCallId: 'report-1' })).toThrow('不能改写');
  expect(f.reports.readyIsCurrent(f.task, saved)).toBe(true);
  f.runtime.startEffect(f.task, { callId: 'later-write', toolName: 'write', argsHash: 'b'.repeat(64), argumentsPreview: 'new mutation' });
  expect(f.reports.readyIsCurrent(f.task, saved)).toBe(false);
});

it('refuses unproven completion, empty verification and descendant authority', async () => {
  const f = storeFixture(await root()), ready = { state: 'ready' as const, summary: '完成', verification: ['已核验结果'] };
  expect(() => f.reports.record(f.task, 'no-effect', { ...ready, nativeSessionId: f.nativeSessionId, nativeCallId: 'no-effect' })).toThrow('执行前回执');
  expect(() => f.reports.record(f.task, 'empty', { ...ready, verification: [], nativeSessionId: f.nativeSessionId, nativeCallId: 'empty' })).toThrow('核验');
  expect(() => f.reports.record(f.task, 'child', { ...ready, nativeSessionId: 'child-session', nativeCallId: 'child' })).toThrow('根执行器');
});

class Memory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> { return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'report', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { archived: true }; }
  override async finishTurn() { return { recorded: true }; }
  override async close() {}
}
class Brain extends BotDshBrain {
  workers: BotDshRun[] = [];
  worker: (input: BotDshRun) => Promise<string> = async () => '这一轮正常结束，但没有声明业务完成。';
  constructor() { super({ getHost: async () => { throw Error('No native Host in report fixture'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    if (input.role === 'worker') this.workers.push(input);
    return { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', text: input.role === 'worker' ? await this.worker(input) : input.laneId.startsWith('memory-encoder') ? '{"notes":[]}' : '已收到真实任务状态。' };
  }
  override async archive() {}
  override async upgradeWorkerAccess(input: Parameters<BotDshBrain['upgradeWorkerAccess']>[0]) { return { workerAccess: 'full' as const, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) }; }
  override async close() {}
}
async function until(check: () => boolean, timeout = 8000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw Error('Task report fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function serviceFixture() {
  const directory = await root(), brain = new Brain(), memory = new Memory({ root: path.join(directory, 'memory'), runtime: async () => { throw Error('No VCP'); }, embedding: async () => { throw Error('No embedding'); } });
  const service = new BotService({ root: directory, brain, memory, model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture' }), onEvent: () => undefined });
  cleanup.push(() => service.shutdown());
  await service.handle({ type: 'state' }); const room = service.store.openDirect(DEFAULT_BOT_COMPANION_ID);
  const source = service.store.enqueue({ conversationId: room.id, senderId: 'user', content: '请解释三个已知事实。' }).events[0]!;
  const task = service.store.createTask({ conversationId: room.id, companionId: DEFAULT_BOT_COMPANION_ID, sourceEventId: source.id, goal: '解释三个已知事实', extra: { workerAccess: 'full' } });
  await service.handle({ type: 'message.send', conversationId: room.id, requestId: 'wake', content: '你好' });
  return { service, brain, task, room };
}

it('keeps a successful native turn without a business report open and continues the same task on explicit guidance', async () => {
  const f = await serviceFixture();
  await until(() => f.service.store.getTask(f.task.id)?.extra.turnOutcome !== undefined);
  const waiting = f.service.store.getTask(f.task.id)!;
  expect(waiting.status).toBe('waiting'); expect(waiting.extra.progress).toMatchObject({ phase: 'awaiting-report' });
  expect(f.brain.workers).toHaveLength(1);
  f.brain.worker = async input => { await reportWorkerOutcome(input, { state: 'ready', summary: '已完成文字解释', verification: ['已逐项核对三项事实并给出解释'] }); return '完整文字解释'; };
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '请补充核验并提交结构化报告。', requestId: 'followup-report' });
  await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  expect(f.brain.workers).toHaveLength(2);
  expect(f.brain.workers[1]).toMatchObject({ laneId: f.brain.workers[0]!.laneId, eventId: f.brain.workers[0]!.eventId, taskContinuation: { id: 'followup-report', text: '请补充核验并提交结构化报告。' } });
  expect(f.service.store.getTask(f.task.id)?.summary).toBe('完整文字解释');
});

it('does not turn blocked or progress reports into completion and does not inherit an old ready report into new work', async () => {
  const f = await serviceFixture();
  await until(() => f.service.store.getTask(f.task.id)?.status === 'waiting');
  f.brain.worker = async input => { await reportWorkerOutcome(input, { state: 'blocked', summary: '缺少确认事实，保持任务开放', verification: [] }); return '尚未完成'; };
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '检查当前阻碍。', requestId: 'inspect-blocker' });
  await until(() => (f.service.store.getTask(f.task.id)?.extra.workerReport as { state?: string } | undefined)?.state === 'blocked' && f.service.store.getTask(f.task.id)?.status === 'waiting');
  expect(f.service.store.getTask(f.task.id)?.extra.progress).toMatchObject({ phase: 'blocked' });
});

it('invalidates a ready report when later running guidance is admitted even if the next reply uses no tool', async () => {
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'waiting');
  let release!: () => void, reportSent = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.brain.send = async () => undefined;
  f.brain.worker = async input => {
    await reportWorkerOutcome(input, { state: 'ready', summary: '旧指导已核验', verification: ['核对了原先条件'] });
    reportSent = true; await held; return '后续指导只得到一段文字，尚未重新报告。';
  };
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '先核验已有结果。', requestId: 'before-ready' });
  await until(() => reportSent);
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '还有这个新的核对条件。', requestId: 'after-ready' });
  release();
  await until(() => f.service.store.getTask(f.task.id)?.status === 'waiting');
  expect(f.service.store.getTask(f.task.id)?.extra.progress).toMatchObject({ phase: 'awaiting-report' });
  expect(f.brain.workers).toHaveLength(2);
});

it('keeps a detached guidance intent on the original task instead of completing from its earlier ready report', async () => {
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'waiting');
  let release!: () => void, reportSent = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.brain.worker = async input => {
    if (f.brain.workers.length === 2) {
      await reportWorkerOutcome(input, { state: 'ready', summary: '较早核验', verification: ['旧条件已满足'] });
      reportSent = true; await held;
    }
    return '执行段结束，等待新的报告。';
  };
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '检查旧条件。', requestId: 'initial-check' });
  await until(() => reportSent);
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '尚未确认送达的新条件。', requestId: 'detached-guidance' });
  release();
  await until(() => f.brain.workers.length === 3 && f.service.store.getTask(f.task.id)?.status === 'waiting');
  expect(f.brain.workers[2]).toMatchObject({ eventId: f.brain.workers[0]!.eventId, laneId: f.brain.workers[0]!.laneId,
    taskContinuation: { id: 'detached-guidance', text: '尚未确认送达的新条件。' } });
  expect(f.service.store.getTask(f.task.id)?.extra.progress).toMatchObject({ phase: 'awaiting-report' });
});

it('revalidates a guidance grant after an asynchronous Host access wait before publishing its instruction', async () => {
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'waiting');
  let release!: () => void, upgrading = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const current = f.service.store.getTask(f.task.id)!;
  f.service.store.updateTask(current.id, { extra: { ...current.extra, workerAccess: 'scoped' } });
  f.brain.upgradeWorkerAccess = async input => { upgrading = true; await held; return { workerAccess: 'full', eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) }; };
  const control = f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '不应在撤权后投递。', requestId: 'withdraw-during-host-wait' });
  const rejected = expect(control).rejects.toThrow(/授权|来源|受众/);
  await until(() => upgrading);
  f.service.store.withdrawSources(current.companionId, f.room.securityDomainId, [current.sourceEventId]);
  release(); await rejected;
  expect(f.service.store.getMetadata(`task-control:${current.id}:withdraw-during-host-wait`)).toBeUndefined();
  expect(f.brain.workers).toHaveLength(1);
});

it.each(['succeeded', 'failed'] as const)('resumes %s work only on explicit human guidance with the same mandate and separate terminal notices, and preserves a human stop', async ending => {
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'waiting');
  let reports = 0;
  f.brain.worker = async input => { reports++; await reportWorkerOutcome(input, { state: reports === 1 && ending === 'failed' ? 'failed' : 'ready', summary: '已核验第' + reports + '轮', verification: ['核对了本轮用户明确条件'] }); return '第' + reports + '轮结果'; };
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '完成第一段核验。', requestId: 'finish-first' });
  await until(() => f.service.store.getTask(f.task.id)?.status === ending);
  const before = f.service.store.getTask(f.task.id)!;
  const mandateBefore = f.service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_task_mandates WHERE task_id=?').get(before.id)) as { id: string };
  expect((await f.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: f.task.id })).task?.followupAvailable).toBe(true);
  const accepted = await f.service.handle({ type: 'message.send', conversationId: f.room.id, requestId: 'historical-reference', replyToTaskId: f.task.id, content: '请核对原任务的另一个已知条件。' });
  expect(accepted.ok).toBe(true);
  await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded' && reports === 2).catch(error => {
    const actual = f.service.store.getTask(f.task.id)!;
    throw new Error(String(error) + JSON.stringify({ status: actual.status, error: actual.error, progress: actual.extra.progress, reports, runs: f.brain.workers.length, report: actual.extra.workerReport, baseline: actual.extra.reportBaseline }));
  });
  expect(f.brain.workers[2]).toMatchObject({ laneId: f.brain.workers[0]!.laneId, eventId: f.brain.workers[0]!.eventId });
  expect(f.brain.workers[2]!.taskContinuation?.id).toMatch(/^followup:event-/);
  expect(f.service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_task_mandates WHERE task_id=?').get(before.id))).toEqual(mandateBefore);
  const notices = f.service.store.taskTransaction(sql => sql.prepare("SELECT source_message_id FROM bot_inbox WHERE source='task' AND kind='task_done' AND json_extract(payload_json,'$.taskId')=?").all(f.task.id)) as Array<{ source_message_id: string }>;
  expect(notices).toHaveLength(2); expect(new Set(notices.map(notice => notice.source_message_id)).size).toBe(2);
  const stopped = await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'cancel', requestId: 'human-stop-finished' });
  expect(stopped.memory).toMatchObject({ status: 'succeeded', humanStopped: true, confirmed: true });
  expect((await f.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: f.task.id })).task).toMatchObject({ status: 'succeeded', humanStopped: true, followupAvailable: false });
  await expect(f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', requestId: 'cannot-revive', text: '不能自动撤销我的停止。' })).rejects.toThrow(/授权|停止/);
  expect(f.brain.workers).toHaveLength(3);
});
