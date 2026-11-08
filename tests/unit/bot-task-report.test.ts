import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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

it('retains a current ready report alongside a generic native ending, without duplicating it on repeated reads', async () => {
  const f = storeFixture(await root()), ending = '任务已完成，可直接转述的天气答复已在上面给出。';
  const report = { state: 'ready' as const, summary: '上海：18.6°C，体感19.2°C，湿度80%。查询时间14:44，来源：天气数据服务。', verification: ['已核对时间、地点及单位。'] };
  f.report('weather-delivery', report);
  expect(f.runtime.verificationText(f.store.getTask(f.task.id)!)).toEqual({ text: '1. 已核对时间、地点及单位。', reportCallId: 'weather-delivery' });
  const text = f.reports.deliveryText(f.store.getTask(f.task.id)!, ending);
  expect(text).toBe(report.summary + '\n\n【执行器补充正文】\n' + ending);
  expect(f.reports.deliveryText(f.store.getTask(f.task.id)!, text)).toBe(text);
  expect(f.reports.deliveryText(f.store.getTask(f.task.id)!, report.summary)).toBe(report.summary);
  f.runtime.startEffect(f.store.getTask(f.task.id)!, { callId: 'later-query', toolName: 'web_fetch', argsHash: 'c'.repeat(64), argumentsPreview: 'new fact' });
  expect(f.reports.deliveryText(f.store.getTask(f.task.id)!, ending)).toBe(ending);
  expect(f.runtime.verificationText(f.store.getTask(f.task.id)!)).toBeUndefined();
});

it('does not merge an earlier execution segment report or invent a missing result', async () => {
  const f = storeFixture(await root());
  expect(f.reports.deliveryText(f.store.getTask(f.task.id)!, '')).toBe('');
  f.report('prior-ready', { state: 'ready', summary: '上一执行段的结论', verification: ['核对了旧条件'] });
  const task = f.store.getTask(f.task.id)!;
  f.store.updateTask(task.id, { extra: { ...task.extra, reportBaseline: 'prior-ready' } });
  expect(f.reports.deliveryText(f.store.getTask(task.id)!, '新执行段尚无结论')).toBe('新执行段尚无结论');
  expect(f.runtime.verificationText(f.store.getTask(task.id)!)).toBeUndefined();
  f.report('progress-report', { state: 'progress', summary: '本轮尚未完成', verification: ['只有部分旧口径已检查'] });
  expect(f.runtime.verificationText(f.store.getTask(task.id)!)).toBeUndefined();
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
  worker: (input: BotDshRun) => Promise<string> = async () => '原生执行器已完成三项事实的文字解释。';
  router?: (input: BotDshRun) => Promise<string>;
  constructor() { super({ getHost: async () => { throw Error('No native Host in report fixture'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    if (input.role === 'worker') this.workers.push(input);
    return { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', text: input.role === 'worker' ? await this.worker(input) : input.laneId.startsWith('memory-encoder') ? '{"notes":[]}' : this.router ? await this.router(input) : '已收到真实任务状态。' };
  }
  override async archive() {}
  override async upgradeWorkerAccess(input: Parameters<BotDshBrain['upgradeWorkerAccess']>[0]) { return { workerAccess: 'full' as const, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) }; }
  override async close() {}
}
async function until(check: () => boolean, timeout = 8000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw Error('Task report fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function serviceFixture(initialReport?: BotWorkerReport, ending?: string) {
  const directory = await root(), brain = new Brain(), memory = new Memory({ root: path.join(directory, 'memory'), runtime: async () => { throw Error('No VCP'); }, embedding: async () => { throw Error('No embedding'); } });
  if (initialReport) brain.worker = async input => { await reportWorkerOutcome(input, initialReport); return ending ?? initialReport.summary; };
  const service = new BotService({ root: directory, brain, memory, model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture' }), onEvent: () => undefined });
  cleanup.push(() => service.shutdown());
  await service.handle({ type: 'state' }); const room = service.store.openDirect(DEFAULT_BOT_COMPANION_ID);
  const source = service.store.enqueue({ conversationId: room.id, senderId: 'user', content: '请解释三个已知事实。' }).events[0]!;
  const task = service.store.createTask({ conversationId: room.id, companionId: DEFAULT_BOT_COMPANION_ID, sourceEventId: source.id, goal: '解释三个已知事实', extra: { workerAccess: 'full' } });
  await service.handle({ type: 'message.send', conversationId: room.id, requestId: 'wake', content: '你好' });
  const restart = async () => {
    await service.shutdown(); const restartedBrain = new Brain();
    const reopened = new BotService({ root: directory, brain: restartedBrain, memory: new Memory({ root: path.join(directory, 'memory'), runtime: async () => { throw Error('No VCP'); }, embedding: async () => { throw Error('No embedding'); } }),
      model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture' }), onEvent: () => undefined });
    cleanup.push(() => reopened.shutdown()); await reopened.handle({ type: 'state' }); return { service: reopened, brain: restartedBrain };
  };
  return { service, brain, task, room, restart };
}

it('delivers the actual ready report to the router and task card even when the final native sentence only says completed', async () => {
  const report = { state: 'ready' as const, summary: '上海目前18.6°C，体感19.2°C，湿度80%；14:44查询，来源为天气服务。', verification: ['三处返回已核对，未编造数值。'] };
  const ending = '任务已完成，可直接转述的天气答复已在上面给出；三处联网请求均返回真实数据。';
  const f = await serviceFixture(report, ending);
  await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  const task = f.service.store.getTask(f.task.id)!;
  expect(task.summary).toContain(report.summary); expect(task.summary).toContain(ending);
  const notice = f.service.store.taskTransaction(sql => sql.prepare("SELECT content FROM bot_inbox WHERE source='task' AND kind='task_done' AND json_extract(payload_json,'$.taskId')=?").get(task.id)) as { content: string };
  expect(notice.content).toContain(report.summary);
  expect((await f.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: task.id })).task?.summary).toBe(task.summary);
  expect(f.brain.workers).toHaveLength(1);
  expect(f.brain.workers[0]!.system).toContain('最终正文及worker_report.summary必须自包含');
});

it('reads full Unicode delivery and omitted verification from a legacy terminal task after restart without resuming its worker', async () => {
  const report: BotWorkerReport = { state: 'ready', summary: '报告正文：上海18.6°C。' + '🐋'.repeat(7000) + '\n报告末尾：来源与适用时间完整保留✅',
    verification: ['核验首项：' + '🐋'.repeat(350) + '\n预览之后的实际来源：https://weather.example/first', '第二项：核对单位', '第三项：核对适用时间', '第四项来源：https://weather.example/fourth，体感19.2°C，湿度80%。'] };
  const ending = '原生正文：' + '🧭'.repeat(9000) + '\n原生末尾：NATIVE-END✅';
  const f = await serviceFixture(report, ending); await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  // Reproduce the previous application projection: the report receipt exists,
  // but only the native final text was persisted as the task summary.
  f.service.store.updateTask(f.task.id, { summary: ending });
  const next = await f.restart(), raw = next.service.store.getTask(f.task.id)!;
  expect(raw.summary).toBe(ending); expect(raw.status).toBe('succeeded');
  const combined = report.summary + '\n\n【执行器补充正文】\n' + ending;
  expect((await next.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: raw.id })).task?.summary).toBe(combined);
  let retrieved: string | undefined, retrievedVerification: string | undefined;
  next.brain.router = async input => {
    if (JSON.parse(input.prompt).trigger?.content !== '读取旧任务完整交付') return '收到';
    const invoke = async (name: string, args: object, callId: string) => {
      const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + input.callback.token, 'content-type': 'application/json' },
        body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
      expect(response.ok).toBe(true);
      const wire = await response.json() as { ok: boolean; result: { text: string; totalChars: number; nextOffset?: number; summary?: string; available?: boolean; reportCallId?: string;
        report?: { verification: string[]; verificationView: { reportCallId: string } }; result?: { nextOffset: number } } };
      expect(wire.ok).toBe(true); return wire.result;
    };
    const status = await invoke('dsh_task_control', { operation: 'status', taskId: raw.id }, 'read-existing-status');
    expect(status.summary).toContain('上海18.6°C'); expect(status.result?.nextOffset).toBe(1200);
    expect(status.report?.verification).toHaveLength(3);
    expect(status.report?.verification[0]).not.toContain('weather.example/first');
    expect(Array.from(status.report?.verification[0] ?? '')).toHaveLength(300);
    expect(status.report?.verificationView).toMatchObject({ available: true, totalItems: 4, shownItems: 3, omittedItems: 1, truncatedItems: 1,
      truncated: true, complete: false, readTool: 'dsh_task_result_read', readArgs: { taskId: raw.id, section: 'verification', offset: 0 } });
    let offset = 0, text = '';
    do {
      const page = await invoke('dsh_task_result_read', { taskId: raw.id, offset, limit: 777 }, 'read-existing-result-' + offset);
      expect(page.totalChars).toBe(Array.from(combined).length);
      expect(page.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
      text += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    } while (offset < 100000);
    let verificationOffset = 0, verificationText = '';
    const fullVerification = report.verification.map((value, index) => `${index + 1}. ${value}`).join('\n\n');
    for (;;) {
      const page = await invoke('dsh_task_result_read', { taskId: raw.id, section: 'verification', offset: verificationOffset, limit: 177 }, 'read-verification-' + verificationOffset);
      expect(page.available).toBe(true); expect(page.totalChars).toBe(Array.from(fullVerification).length);
      expect(page.reportCallId).toBe(status.report?.verificationView.reportCallId);
      expect(page.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
      verificationText += page.text;
      if (page.nextOffset === undefined) break;
      verificationOffset = page.nextOffset;
    }
    retrievedVerification = verificationText; retrieved = text; return '已读取已有完整交付及全部核验来源。';
  };
  await next.service.handle({ type: 'message.send', conversationId: f.room.id, requestId: 'read-old-delivery', content: '读取旧任务完整交付' });
  await until(() => retrieved !== undefined);
  expect(retrieved).toBe(combined); expect(next.brain.workers).toHaveLength(0);
  expect(retrievedVerification).toBe(report.verification.map((value, index) => `${index + 1}. ${value}`).join('\n\n'));
  expect(next.service.store.getTask(raw.id)?.summary).toBe(ending);
});

it('does not expose stale or foreign verification through the read-only result section', async () => {
  const f = await serviceFixture({ state: 'ready', summary: '真实交付', verification: ['来源原件：SOURCE-ISOLATED'] });
  await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  const task = f.service.store.getTask(f.task.id)!;
  const otherRoom = f.service.store.createGroup({ title: '其他受众', memberIds: [DEFAULT_BOT_COMPANION_ID], participationMode: 'all' });
  const receipts: Array<{ content: string; status: number; body: { result?: { text: string; available: boolean; reason: string } } }> = [];
  f.brain.router = async input => {
    const content = JSON.parse(input.prompt).trigger?.content;
    if (!['foreign-verification', 'stale-verification'].includes(content)) return '收到';
    const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + input.callback.token, 'content-type': 'application/json' },
      body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId: 'read-' + content, name: 'dsh_task_result_read', args: { taskId: task.id, section: 'verification' } }) });
    receipts.push({ content, status: response.status, body: await response.json() as { result?: { text: string; available: boolean; reason: string } } });
    return '未重新执行任务。';
  };
  await f.service.handle({ type: 'message.send', conversationId: otherRoom.id, requestId: 'foreign-verification', content: 'foreign-verification' });
  await until(() => receipts.length === 1);
  expect(receipts[0]!.status).not.toBe(200); expect(JSON.stringify(receipts[0])).not.toContain('SOURCE-ISOLATED');
  const updated = f.service.store.getTask(task.id)!;
  f.service.store.updateTask(task.id, { extra: { ...updated.extra, reportBaseline: (updated.extra.workerReport as { callId: string }).callId } });
  await f.service.handle({ type: 'message.send', conversationId: f.room.id, requestId: 'stale-verification', content: 'stale-verification' });
  await until(() => receipts.length === 2);
  expect(receipts[1]).toMatchObject({ status: 200, body: { result: { text: '', available: false, reason: expect.any(String) } } });
  expect(JSON.stringify(receipts[1])).not.toContain('SOURCE-ISOLATED'); expect(f.brain.workers).toHaveLength(1);
});

it('repairs a legacy completed waiting projection on startup without repeating its worker or inventing verification', async () => {
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  const current = f.service.store.getTask(f.task.id)!;
  f.service.store.taskTransaction(sql => sql.prepare("UPDATE bot_tasks SET status='waiting',extra_json=? WHERE id=?").run(JSON.stringify({ ...current.extra,
    progress: { phase: 'awaiting-report', detail: '旧版仍等待结构化报告' } }), current.id));
  const next = await f.restart(), task = next.service.store.getTask(current.id)!;
  expect(task.status).toBe('succeeded'); expect(task.summary).toBe(current.summary);
  expect(task.extra.completionBasis).toBe('native-terminal'); expect(task.extra.workerReport).toBeUndefined();
  expect(next.brain.workers).toHaveLength(0);
  const response = await next.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: task.id });
  expect(response.task).toMatchObject({ status: 'succeeded', waitingForAnswer: false });
  expect((await next.service.handle({ type: 'task.list', conversationId: f.room.id, filter: 'active', page: 0, limit: 6 })).taskPage?.items).toEqual([]);
});

it('keeps real queued questions waiting and uncertain native effects fenced during legacy completion repair', async () => {
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  const prior = f.service.store.getTask(f.task.id)!;
  const seed = (id: string) => {
    const task = f.service.store.createTask({ id, conversationId: prior.conversationId, companionId: prior.companionId, sourceEventId: prior.sourceEventId,
      goal: '原范围内的旧任务', extra: { nativeAttempted: true, retryAt: Date.now() + 60000, turnOutcome: { status: 'succeeded', eventId: `work-${id}` } } });
    return f.service.store.updateTask(id, { status: 'waiting', extra: { ...task.extra, progress: { phase: 'awaiting-report' } } });
  };
  const question = seed('legacy-real-question'), effect = seed('legacy-unknown-write'), runtime = new BotTaskRuntime(f.service.store);
  const callId = 'real-question-call', questionId = 'question-' + createHash('sha256').update(`work-${question.id}:${callId}`).digest('hex').slice(0, 48);
  runtime.question(question, { callId, questionId, questions: [{ id: 'choice', question: '需要哪个文件？' }] });
  runtime.startEffect(effect, { callId: 'unknown-write', toolName: 'write', argsHash: 'b'.repeat(64), argumentsPreview: 'Outcome unconfirmed.' });
  const next = await f.restart();
  expect(next.service.store.getTask(question.id)?.status).toBe('waiting');
  expect((await next.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: question.id })).task?.waitingForAnswer).toBe(true);
  expect((await next.service.handle({ type: 'task.list', conversationId: f.room.id, filter: 'all', page: 0, limit: 6 })).taskPage?.items.find(task => task.id === question.id)?.waitingForAnswer).toBe(true);
  expect(next.service.store.getTask(effect.id)?.status).toBe('waiting');
  expect(new BotTaskRuntime(next.service.store).pendingEffects(effect.id)).toMatchObject([{ callId: 'unknown-write', state: 'pending' }]);
  expect(next.brain.workers).toHaveLength(0);
});

it('finishes a successful native text result without requiring an optional report and accepts explicit same-task guidance', async () => {
  const f = await serviceFixture();
  await until(() => f.service.store.getTask(f.task.id)?.extra.turnOutcome !== undefined);
  const waiting = f.service.store.getTask(f.task.id)!;
  expect(waiting.status).toBe('succeeded'); expect(waiting.extra.completionBasis).toBe('native-terminal');
  expect(f.brain.workers).toHaveLength(1);
  f.brain.worker = async input => { await reportWorkerOutcome(input, { state: 'ready', summary: '已完成文字解释', verification: ['已逐项核对三项事实并给出解释'] }); return '完整文字解释'; };
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '请补充核验并提交结构化报告。', requestId: 'followup-report' });
  await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  expect(f.brain.workers).toHaveLength(2);
  expect(f.brain.workers[1]).toMatchObject({ laneId: f.brain.workers[0]!.laneId, eventId: f.brain.workers[0]!.eventId, taskContinuation: { id: 'followup-report', text: '请补充核验并提交结构化报告。' } });
  expect(f.service.store.getTask(f.task.id)?.summary).toContain('完整文字解释');
  expect(f.service.store.getTask(f.task.id)?.summary).toContain('已完成文字解释');
});

it('does not turn blocked or progress reports into completion and does not inherit an old ready report into new work', async () => {
  const f = await serviceFixture();
  await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  f.brain.worker = async input => { await reportWorkerOutcome(input, { state: 'blocked', summary: '缺少确认事实，保持任务开放', verification: [] }); return '尚未完成'; };
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '检查当前阻碍。', requestId: 'inspect-blocker' });
  await until(() => (f.service.store.getTask(f.task.id)?.extra.workerReport as { state?: string } | undefined)?.state === 'blocked' && f.service.store.getTask(f.task.id)?.status === 'paused');
  expect(f.service.store.getTask(f.task.id)?.extra.progress).toMatchObject({ phase: 'blocked' });
});

it('invalidates a ready report when later running guidance is admitted even if the next reply uses no tool', async () => {
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
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
  await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  expect(f.service.store.getTask(f.task.id)?.status).toBe('succeeded');
  expect(f.brain.workers).toHaveLength(2);
});

it('keeps a detached guidance intent on the original task instead of completing from its earlier ready report', async () => {
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
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
  await until(() => f.brain.workers.length === 3 && f.service.store.getTask(f.task.id)?.status === 'succeeded');
  expect(f.brain.workers[2]).toMatchObject({ eventId: f.brain.workers[0]!.eventId, laneId: f.brain.workers[0]!.laneId,
    taskContinuation: { id: 'detached-guidance', text: '尚未确认送达的新条件。' } });
  expect(f.service.store.getTask(f.task.id)?.status).toBe('succeeded');
});

it('revalidates a guidance grant after an asynchronous Host access wait before publishing its instruction', async () => {
  const f = await serviceFixture({ state: 'blocked', summary: '等待原目标内的已知事实', verification: [] });
  await until(() => f.service.store.getTask(f.task.id)?.status === 'paused');
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
  const f = await serviceFixture(); await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded');
  let reports = 0;
  f.brain.worker = async input => { reports++; await reportWorkerOutcome(input, { state: reports === 1 && ending === 'failed' ? 'failed' : 'ready', summary: '已核验第' + reports + '轮', verification: ['核对了本轮用户明确条件'] }); return '第' + reports + '轮结果'; };
  await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', text: '完成第一段核验。', requestId: 'finish-first' });
  await until(() => f.service.store.getTask(f.task.id)?.status === ending);
  const before = f.service.store.getTask(f.task.id)!;
  const mandateBefore = f.service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_task_mandates WHERE task_id=?').get(before.id)) as { id: string };
  expect((await f.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: f.task.id })).task?.followupAvailable).toBe(true);
  let routedGuidance = 0;
  f.brain.router = async input => {
    const body = JSON.parse(input.prompt) as { trigger?: { content?: string; taskFollowup?: { taskId: string } } };
    if (body.trigger?.taskFollowup?.taskId === f.task.id) {
      const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + input.callback.token, 'content-type': 'application/json' },
        body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId: 'selected-human-guidance', name: 'dsh_task_control', args: { operation: 'send', taskId: f.task.id, text: body.trigger.content } }) });
      expect(response.ok).toBe(true); expect(await response.json()).toMatchObject({ ok: true }); routedGuidance++;
    }
    return '已将用户的新条件交给原任务。';
  };
  const accepted = await f.service.handle({ type: 'message.send', conversationId: f.room.id, requestId: 'historical-reference', replyToTaskId: f.task.id, content: '请核对原任务的另一个已知条件。' });
  expect(accepted.ok).toBe(true);
  await until(() => f.service.store.getTask(f.task.id)?.status === 'succeeded' && reports === 2).catch(error => {
    const actual = f.service.store.getTask(f.task.id)!;
    throw new Error(String(error) + JSON.stringify({ status: actual.status, error: actual.error, progress: actual.extra.progress, reports, runs: f.brain.workers.length, report: actual.extra.workerReport, baseline: actual.extra.reportBaseline }));
  });
  expect(f.brain.workers[2]).toMatchObject({ laneId: f.brain.workers[0]!.laneId, eventId: f.brain.workers[0]!.eventId });
  expect(routedGuidance).toBe(1); expect(f.brain.workers[2]!.taskContinuation).toMatchObject({ id: expect.stringMatching(/:selected-human-guidance$/u), text: '请核对原任务的另一个已知条件。' });
  expect(f.service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_task_mandates WHERE task_id=?').get(before.id))).toEqual(mandateBefore);
  const notices = f.service.store.taskTransaction(sql => sql.prepare("SELECT source_message_id FROM bot_inbox WHERE source='task' AND kind='task_done' AND json_extract(payload_json,'$.taskId')=?").all(f.task.id)) as Array<{ source_message_id: string }>;
  expect(notices).toHaveLength(3); expect(new Set(notices.map(notice => notice.source_message_id)).size).toBe(3);
  const stopped = await f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'cancel', requestId: 'human-stop-finished' });
  expect(stopped.memory).toMatchObject({ status: 'succeeded', humanStopped: true, confirmed: true });
  expect((await f.service.handle({ type: 'task.get', conversationId: f.room.id, taskId: f.task.id })).task).toMatchObject({ status: 'succeeded', humanStopped: true, followupAvailable: false });
  await expect(f.service.handle({ type: 'task.control', conversationId: f.room.id, taskId: f.task.id, operation: 'send', requestId: 'cannot-revive', text: '不能自动撤销我的停止。' })).rejects.toThrow(/授权|停止/);
  expect(f.brain.workers).toHaveLength(3);
});
