/** Opt-in actual Router + official native DSH + configured provider acceptance.
 * Only the memory boundary is disabled; no scripted model or tool answers. */
import { app, safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BotTaskSql } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { createBotNativeHost } from './bot-native-host';

const root = process.env.WORLDLINEBOX_MULTIFILE_ROOT!, output = process.env.WORLDLINEBOX_MULTIFILE_OUTPUT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
const collaborative = process.env.WORLDLINEBOX_MULTIFILE_COLLABORATIVE === '1';
if (process.env.WORLDLINEBOX_MULTIFILE_REAL !== '1' || !root || !output || !source) throw Error('Explicit isolated real acceptance inputs are required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
const progress = (stage: string, details: object = {}) => process.send?.({ kind: 'multifile-progress', stage, ...details });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class NoMemory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'memory-disabled-for-handoff-test', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  override async close() {}
}
void app.whenReady().then(async () => {
  let service: BotService | undefined, native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined, secret = '', stage = 'configuration';
  const report: Record<string, unknown> = { kind: 'multifile-result', mode: collaborative ? 'collaborative' : 'single', passed: false, actualModel: false, actualNativeWorker: false, memoryDisabled: true };
  const safe = (error: unknown) => (error instanceof Error ? error.message : String(error)).replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/giu, 'Bearer <redacted>').slice(0, 1500);
  const errors: string[] = [], dispatches: BotDshRun[] = [];
  const timeline: Array<{ taskId: string; stage?: string; start: number; end?: number; sessionId?: string; states: Array<{ id: string; status: string }> }> = [];
  try {
    const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/u.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('No decryptable configured model.');
    const model = { ...resolveStoredLlmConfig(profile), apiKey: safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin'))) };
    secret = model.apiKey; if (model.apiFormat !== 'openai_chat' || !model.baseUrl || !secret) throw Error('Configured OpenAI Chat model is required.');
    report.model = { model: model.model, apiFormat: model.apiFormat, endpointHost: new URL(model.baseUrl).host }; progress(stage, report.model as object);
    stage = 'native-host'; progress(stage);
    native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!); process.send?.({ kind: 'multifile-owned-root', root: native.root });
    const client = await native.instances.ensureHost(native.instance.id); report.dshVersion = native.runtimeVersion;
    const botRoot = path.join(root, 'bot'), inputs = path.join(root, 'inputs'); await mkdir(inputs);
    const media = new BotMediaService({ root: path.join(botRoot, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
    const worker = new BotDshBrain({ getHost: async () => ({ client }) });
    const brain = new BotBrainRouter({ worker, app: new BotAppBrain({ root: path.join(botRoot, 'router'),
      fetchFn: async (...args) => { report.actualModel = true; return fetch(...args); },
      reconcileTool: (call, signal) => service!.reconcileToolReceipt(call, signal) }) });
    const run = brain.run.bind(brain);
    brain.run = async input => {
      let row: typeof timeline[number] | undefined;
      if (input.role === 'worker') {
        dispatches.push(input); const taskId = input.laneId.slice('worker-'.length), task = service!.store.getTask(taskId)!;
        row = { taskId, stage: typeof task.extra.workflowStage === 'string' ? task.extra.workflowStage : undefined, start: Date.now(), states: service!.store.listTasks().map(task => ({ id: task.id, status: task.status })) }; timeline.push(row);
        await writeFile(path.join(output, `worker-prompt-${dispatches.length}.txt`), input.prompt); progress('worker-dispatch', { promptChars: input.prompt.length, stageKey: row.stage });
      }
      try { const result = await run(input); if (row) { report.actualNativeWorker = true; row.sessionId = result.sessionId; } return result; }
      finally { if (row) row.end = Date.now(); }
    };
    service = new BotService({ root: botRoot, brainRuntime: 'worldlinebox', brain, media, prewarmMemory: false,
      memory: new NoMemory({ root: path.join(botRoot, 'memory'), runtime: async () => { throw Error('Memory disabled in this handoff-only acceptance.'); }, embedding: async () => { throw Error('No memory embedding in this test.'); } }),
      model: () => ({ ...model, baseUrl: model.baseUrl! }), onEvent: () => undefined, report: error => errors.push(safe(error)) });
    await service.handle({ type: 'state' }); const conversationId = service.store.openDirect(DEFAULT_BOT_COMPANION_ID).id;
    const data: Record<string, string> = {
      'orders.csv': 'order_id,region,status,date,gross_cents,shipping_cents,refund_cents,customer_phone\nA01,E,paid,2026-11-02,12000,800,1000,13800000001\nA02,E,paid,2026-11-03,8000,0,0,13800000002\nA03,W,paid,2026-11-03,15000,1000,2000,13800000003\nA04,E,cancelled,2026-11-04,9000,0,0,13800000004\nA05,E,paid,2026-11-05,5000,500,500,13800000005\nA06,E,paid,2026-10-31,6000,0,1000,13800000006\nA07,W,paid,2026-11-06,7000,500,0,13800000007\nA08,E,pending,2026-11-07,6000,400,1000,13800000008\n',
      'regions.md': '# 区域码\nE = 华东；W = 华西。金额字段均为人民币分，不是元。\n',
      'refunds.json': JSON.stringify({ effective: '2026-11-07', replacements: { A01: 2000, A05: 1000 }, unit: 'CNY_cent', rule: '更正值替换原退款，不是相加' }),
      'policy.md': '# 核对口径\n只统计日期范围内 status=paid 的记录。净收入=毛收入-运费-退款。refunds.json中有更正的订单替换CSV退款；没有更正的沿用CSV。取消、待支付和日期外订单均排除。\n',
      'unrelated-sound-list.txt': 'UNRELATED_ATTACHMENT_7F2：上周的音效文件清单，与订单核对无关，不纳入本任务。\n',
    };
    for (const [name, content] of Object.entries(data)) await writeFile(path.join(inputs, name), content);
    const refs = await media.importFiles({ conversationId, paths: Object.keys(data).map(name => path.join(inputs, name)) });
    const fileIds = (names: string[]) => names.map(name => refs.find(ref => ref.name === name)!.id);
    // Genuine stored user publications, no invented assistant responses. The
    // final message below goes through the actual Router/provider/tool server.
    service.store.enqueue({ conversationId, senderId: 'user', recipientIds: [], sourceMessageId: randomUUID(),
      content: '先收资料，暂时不要执行。这是订单和区域码，金额是人民币分。', attachments: refs.filter(ref => ['orders.csv', 'regions.md'].includes(ref.name)) });
    service.store.enqueue({ conversationId, senderId: 'user', recipientIds: [], sourceMessageId: randomUUID(),
      content: 'UNRELATED_CHAT_9C1：午饭我吃了咖喱，还在研究口型动画。这个音效列表与核对无关。', attachments: refs.filter(ref => ref.name === 'unrelated-sound-list.txt') });
    service.store.enqueue({ conversationId, senderId: 'user', recipientIds: [], sourceMessageId: randomUUID(),
      content: '这是统计口径与退款更正，稍后才开始。补充要求：更正替换旧退款，目标只看华东E，日期为2026-11-01到2026-11-07（含首尾）；保留三项排除原因。', attachments: refs.filter(ref => ['policy.md', 'refunds.json'].includes(ref.name)) });
    const request = '现在开始：请通过DSH分析前面四份订单、区域、政策和退款资料，按照前面补充的区域、日期和更正口径核对净收入。全程只读原件，不输出客户手机号，不访问外部网络。请生成 analysis.json，字段为 region、period、includedOrderIds、excluded（orderId及reason）、grossYuan、shippingYuan、refundYuan、netYuan；金额统一为元并保留两位小数。排除列表只记录华东范围的排除订单，华西不列入。请给我文件并简要解释计算。音效清单和闲聊都不相关，不要交给执行器。'
      + (collaborative ? '\n这次请你统筹三个阶段：先让两个独立Worker并行。第一位只核算金额，交付 financial.json（含各项金额与订单逐项依据）；第二位独立审计筛选和退款覆盖规则，交付 audit.json（含纳入/排除订单及原因、独立复核金额、发现的差异）。两位各自读取上述四份原件，不互相等待。等两位真实完成、你读过两边报告并确认是否一致，再让第三个Worker拿到两份中间报告进行汇总复核，交付最终 analysis.json，增加 sourceReports 字段注明两份报告。每位都通过原聊天交付自己的真实文件。按这三个阶段执行，不再额外派第四份重复工作；有差异应先要求原Worker澄清。你是统筹者，不代替Worker做文件分析。' : '')
      + '\n这是隔离的样例验收，不要保存长期记忆，只完成本次文件分析和交付。';
    stage = 'actual-router'; progress(stage, { relevantFiles: 4, unrelatedFiles: 1 });
    const sent = await service.handle({ type: 'message.send', conversationId, content: request, requestId: randomUUID() });
    if (!sent.ok) throw Error('Final request was not accepted.');
    const sourceEventId = service.store.getMessage(sent.replyMessageIds![0]!)!.eventId;
    service.store.setMetadata(`skipCapture:${sourceEventId}`, 'true');
    const deadline = Date.now() + 420000;
    let task;
    while (Date.now() < deadline) {
      await service.handle({ type: 'state', conversationId });
      if (collaborative) {
        const tasks = service.store.listTasks();
        const plans = service.store.taskTransaction(sql => sql.prepare('SELECT record_json FROM bot_workflows').all()) as Array<{ record_json: string }>;
        const finalId = plans.flatMap(row => (JSON.parse(row.record_json) as { stages: Array<{ taskId?: string; dependsOn: string[] }> }).stages).find(stage => stage.dependsOn.length === 2)?.taskId;
        task = tasks.find(task => task.id === finalId);
        if (tasks.some(task => ['failed', 'cancelled', 'paused', 'unknown'].includes(task.status))) throw Error('A collaboration stage failed or was interrupted.');
        if (tasks.length === 3 && tasks.every(task => task.status === 'succeeded')) break;
        await pause(250); continue;
      }
      task = service.store.listTasks().find(value => value.sourceEventId === service!.store.getMessage(sent.replyMessageIds![0]!)?.eventId);
      task ??= service.store.listTasks()[0];
      if (task && ['succeeded', 'failed', 'cancelled', 'paused', 'unknown'].includes(task.status)) break;
      if (!task && service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'failed') throw Error('Router failed to answer or dispatch.');
      await pause(250);
    }
    if (!task || task.status !== 'succeeded') throw Error('Native task did not succeed: ' + (task?.status ?? 'no-task') + ' ' + (task?.error ?? ''));
    stage = 'assert-handoff'; progress(stage);
    if (collaborative ? dispatches.length < 3 || dispatches.length > 7 || service.store.listTasks().length !== 3 : dispatches.length !== 1 || service.store.listTasks().length !== 1) throw Error('Unexpected extra or missing native task.');
    const dispatch = dispatches.findLast(work => work.laneId === `worker-${task!.id}`)!, manifest = JSON.parse(await readFile(path.join(dispatch.cwd, '.worldlinebox/task-input.json'), 'utf8'));
    const selectedNames = manifest.files.map((file: { name: string }) => file.name).sort();
    const expected = ['orders.csv', 'regions.md', 'refunds.json', 'policy.md'].sort();
    for (const work of dispatches) {
      const selected = JSON.parse(await readFile(path.join(work.cwd, '.worldlinebox/task-input.json'), 'utf8'));
      const taskCard = service.store.getTask(work.laneId.slice('worker-'.length))!;
      if (selected.requirements !== taskCard.goal || !work.prompt.startsWith(taskCard.goal)) throw Error('A stage handoff differs from its task card.');
      const initialAnalysis = !collaborative || taskCard.id !== task.id;
      if (initialAnalysis && JSON.stringify(selected.files.map((file: { name: string }) => file.name).sort()) !== JSON.stringify(expected)) throw Error('An analysis stage did not select exactly its four input files.');
      if (initialAnalysis && /netYuan\s*=|净收入\s*[=＝]/u.test(taskCard.goal)) throw Error('Router added a formula before any Worker had read the policy.');
      for (const value of ['UNRELATED_CHAT_9C1', 'UNRELATED_ATTACHMENT_7F2', 'unrelated-sound-list.txt', '咖喱', '口型动画', 'handoffMessages', 'correlationId'])
        if (work.prompt.includes(value) || JSON.stringify(selected).includes(value)) throw Error('A stage received unrelated context: ' + value);
      for (const file of selected.files) if (!path.isAbsolute(file.path) || hash(await readFile(file.path)) !== file.sha256) throw Error('A stage input was changed or has invalid provenance.');
    }
    if (!collaborative && JSON.stringify(selectedNames) !== JSON.stringify(expected)) throw Error('Router did not select exactly the four task-relevant files.');
    if (collaborative) {
      const plans = service.store.taskTransaction(sql => sql.prepare('SELECT record_json FROM bot_workflows').all()) as Array<{ record_json: string }>;
      if (plans.length !== 1) throw Error('Expected one durable collaboration plan.');
      const plan = JSON.parse(plans[0]!.record_json) as { id: string; stages: Array<{ key: string; dependsOn: string[]; taskId?: string }> };
      if (plan.stages.length !== 3 || plan.stages.filter(stage => stage.dependsOn.length === 0).length !== 2 || !plan.stages.some(stage => stage.dependsOn.length === 2 && stage.taskId === task!.id)) throw Error('Wrong collaboration dependency graph.');
      if (!(timeline[0]!.start < timeline[1]!.end! && timeline[1]!.start < timeline[0]!.end!)) throw Error('The independent Workers did not actually overlap.');
      const finalRun = timeline.findLast(row => row.taskId === task!.id)!;
      if (finalRun.states.filter(task => task.id !== finalRun.taskId && task.status === 'succeeded').length !== 2) throw Error('Dependent work started before both prerequisites succeeded.');
      if (!['financial.json', 'audit.json'].every(name => selectedNames.includes(name))) throw Error('Final Worker did not receive both intermediate report files.');
      if (new Set(timeline.map(row => row.sessionId)).size !== 3) throw Error('Workers did not use independent native sessions.');
      const reads = service.store.taskTransaction(sql => sql.prepare('SELECT task_id FROM bot_workflow_reads WHERE plan_id=?').all(plan.id)) as Array<{ task_id: string }>;
      if (reads.length < 2) throw Error('Router did not read the prerequisites before dispatching integration.');
      report.collaboration = { stages: plan.stages, nativeSessions: 3, actualParallelWorkers: 2, dependentStageAfterBothSucceeded: true, routerReadPrerequisiteResults: true, intermediateFilesDelivered: true, timeline };
    }
    for (const file of manifest.files) if (!path.isAbsolute(file.path) || hash(await readFile(file.path)) !== file.sha256) throw Error('Staged file path or hash invalid.');
    for (const text of ['UNRELATED_CHAT_9C1', 'UNRELATED_ATTACHMENT_7F2', 'unrelated-sound-list.txt', '咖喱', '口型动画', 'handoffMessages', 'correlationId'])
      if (dispatch.prompt.includes(text) || JSON.stringify(manifest).includes(text)) throw Error('Unrelated context leaked: ' + text);
    if (!dispatch.prompt.startsWith(task.goal) || manifest.requirements !== task.goal) throw Error('Task card and actual handoff differ.');
    if (/netYuan\s*=\s*grossYuan\s*\+\s*shippingYuan|毛收入\s*[+＋]\s*运费/u.test(task.goal)) throw Error('Router invented an incorrect formula before reading the source policy.');
    stage = 'assert-analysis'; progress(stage);
    const analysisBytes = await readFile(path.join(dispatch.cwd, 'analysis.json')), analysis = JSON.parse(analysisBytes.toString('utf8'));
    if (collaborative && (!JSON.stringify(analysis.sourceReports).includes('financial.json') || !JSON.stringify(analysis.sourceReports).includes('audit.json'))) throw Error('Final report does not cite both prerequisite reports.');
    if (analysis.netYuan === undefined || Number(analysis.netYuan) !== 207 || Number(analysis.grossYuan) !== 250 || Number(analysis.shippingYuan) !== 13 || Number(analysis.refundYuan) !== 30) throw Error('Incorrect multi-file totals.');
    if (JSON.stringify([...analysis.includedOrderIds].sort()) !== JSON.stringify(['A01', 'A02', 'A05'])) throw Error('Incorrect eligible orders.');
    if (JSON.stringify(analysis.excluded.map((value: { orderId: string }) => value.orderId).sort()) !== JSON.stringify(['A04', 'A06', 'A08']) || analysis.excluded.some((value: { reason: string }) => !value.reason?.trim())) throw Error('Missing exclusion reasons.');
    if (/1380000000[1-8]/u.test(analysisBytes.toString('utf8'))) throw Error('Report exposed excluded phone fields.');
    for (const [name, content] of Object.entries(data)) {
      if (await readFile(path.join(inputs, name), 'utf8') !== content) throw Error('Original file changed.');
      const ref = refs.find(value => value.name === name)!; if (hash(await readFile((await media.getForAgent(conversationId, ref.id)).path)) !== hash(content)) throw Error('Canonical original changed.');
    }
    await writeFile(path.join(output, 'analysis.json'), analysisBytes);
    await writeFile(path.join(output, 'task-requirements.txt'), task.goal);
    await writeFile(path.join(output, 'fixtures.json'), JSON.stringify(data, null, 2));
    const replyDeadline = Date.now() + 60000;
    while (Date.now() < replyDeadline && !service.store.recentMessages(conversationId, { limit: 20 }).some(message => message.senderId === DEFAULT_BOT_COMPANION_ID && message.content.includes('207'))) { await service.handle({ type: 'state', conversationId }); await pause(250); }
    const published = service.store.publicationsForTask(task.id);
    if (!published.length) throw Error('The actual report file was not delivered to the chat.');
    report.passed = true; report.task = { status: task.status, goalChars: task.goal.length, promptChars: dispatch.prompt.length, selectedNames, nativeDispatches: dispatches.length, publishedFiles: published.length };
    report.analysis = analysis; report.sourceFilesUnchanged = true; report.unrelatedContextExcluded = true; report.errors = errors;
    report.requiredContext = { regionAndPeriod: /华东|\bE\b/u.test(task.goal) && /2026-11-01/u.test(task.goal) && /2026-11-07/u.test(task.goal),
      correctionPolicy: /替换|覆盖/u.test(task.goal), originalUnit: /分/u.test(task.goal), readOnly: /只读|不得修改|不修改/u.test(task.goal), noPhone: /手机号|电话/u.test(task.goal), noNetwork: /网络|联网/u.test(task.goal) };
    if (!Object.values(report.requiredContext as object).every(Boolean)) throw Error('Router omitted an important requirement from its task handoff.');
    report.selectedAttachmentIdsMatch = collaborative ? true : JSON.stringify([...(task.extra.attachmentIds as string[])].sort()) === JSON.stringify(fileIds(expected).sort());
  } catch (error) { report.passed = false; report.stage = stage; report.error = safe(error); report.errors = errors; }
  finally {
    if (service) try {
      const Sqlite = Database as new (filename: string, options: { readonly: boolean }) => BotTaskSql & { close(): void };
      const db = new Sqlite(path.join(root, 'bot/router/app-brain.sqlite'), { readonly: true });
      try {
        const snapshot = { tasks: service.store.listTasks().map(task => ({ id: task.id, status: task.status, title: task.extra.title, summary: task.summary, error: task.error })),
          turns: db.prepare('SELECT event_id,state,text,error FROM app_turns').all(), calls: db.prepare('SELECT event_id,call_id,name,args_json,state,result_json FROM app_calls').all(), timeline };
        await writeFile(path.join(output, 'router-journal.json'), JSON.stringify(snapshot, null, 2).replaceAll(secret || '\0', '<redacted>'));
      } finally { db.close(); }
    } catch (error) { report.diagnosticError = safe(error); }
    try { await service?.shutdown(); await native?.close(); } catch (error) { report.passed = false; report.cleanupError = safe(error); }
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n'); process.send?.(report);
    app.exit(report.passed ? 0 : 1);
  }
});
