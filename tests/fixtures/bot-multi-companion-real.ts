/** Opt-in real provider + real official DSH, isolated fictional business data.
 * Admission may be held to make a user intervention deterministic. Neither
 * model replies nor native tool outputs are replaced by scripted answers. */
import { app, safeStorage } from 'electron';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { createBotNativeHost } from './bot-native-host';

const root = process.env.WORLDLINEBOX_MULTI_COMPANION_ROOT!, output = process.env.WORLDLINEBOX_MULTI_COMPANION_OUTPUT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
const scenario = process.env.WORLDLINEBOX_MULTI_COMPANION_SCENARIO === 'peer' ? 'peer' : 'group';
if (process.env.WORLDLINEBOX_MULTI_COMPANION_REAL !== '1' || !root || !output || !source) throw Error('Explicit isolated real acceptance inputs are required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
const progress = (stage: string, details: object = {}) => process.send?.({ kind: 'multi-companion-progress', stage, ...details });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
class NoMemory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> { return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'isolated-handoff', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  /** A disabled fixture service rejects before performing I/O, and can prove
   * absence. Production VCP unknown-effect safeguards remain unmodified. */
  override async remember(): Promise<unknown> { throw new Error('Memory disabled in isolated acceptance: no write was performed.'); }
  override async rememberReceipt() { return { found: false }; }
  override async close() {}
}
type JournalDb = { prepare(sql: string): { all(): unknown[] }; close(): void };
const Sqlite = createRequire(path.join(process.cwd(), 'package.json'))('better-sqlite3') as { new(filename: string, options: { readonly: boolean }): JournalDb };

void app.whenReady().then(async () => {
  let service: BotService | undefined, native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined, media: BotMediaService | undefined, secret = '', stage = 'configuration';
  let releaseWest!: () => void; const westGate = new Promise<void>(resolve => { releaseWest = resolve; });
  const report: Record<string, unknown> = { kind: 'multi-companion-result', scenario, passed: false, actualModel: false, actualNativeWorker: false, memoryDisabled: true,
    memoryBoundary: 'Fixture remember rejects before I/O; rememberReceipt proves found:false. Production memory tools remain in the real Router catalog.',
    executionEnvironment: 'One isolated official DSH host; distinct companion Router lanes, task workspaces and native Worker sessions.' };
  const errors: string[] = [], timeline: Array<{ taskId: string; companionId: string; conversationId: string; prompt: string; continuation?: unknown; startedAt: number; nativeStartedAt?: number; endedAt?: number; sessionId?: string; toolNames: string[]; cwd: string }> = [];
  const routerRequests: Array<{ eventId: string; laneId: string; prompt: string }> = [];
  const states: Array<{ at: number; tasks: unknown[] }> = []; const seenStates = new Set<string>();
  const redact = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/giu, 'Bearer <redacted>');
  const safe = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const sample = () => {
    if (!service) return;
    const tasks = service.store.listTasks().map(task => ({ id: task.id, companionId: task.companionId, conversationId: task.conversationId, status: task.status, progress: task.extra.progress, title: task.extra.title }));
    const fingerprint = JSON.stringify(tasks); if (!seenStates.has(fingerprint) && states.length < 600) { seenStates.add(fingerprint); states.push({ at: Date.now(), tasks }); }
  };
  const until = async (check: () => boolean | Promise<boolean>, label: string, ms = 180000) => {
    stage = label; progress(label); const deadline = Date.now() + ms;
    while (!await check()) { sample(); if (Date.now() > deadline) throw Error('Timed out: ' + label); await pause(200); }
    sample();
  };
  try {
    const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/u.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('Configured model is unavailable.');
    const model = { ...resolveStoredLlmConfig(profile), apiKey: safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin'))) };
    secret = model.apiKey; if (model.apiFormat !== 'openai_chat' || !model.baseUrl || !secret) throw Error('Configured OpenAI Chat model is required.');
    report.model = { model: model.model, apiFormat: model.apiFormat, endpointHost: new URL(model.baseUrl).host };
    stage = 'native-host'; progress(stage, report.model as object);
    native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!); process.send?.({ kind: 'multi-companion-owned-root', root: native.root });
    const client = await native.instances.ensureHost(native.instance.id); report.dshVersion = native.runtimeVersion;
    const botRoot = path.join(root, 'bot'), inputRoot = path.join(root, 'inputs'); await mkdir(inputRoot);
    media = new BotMediaService({ root: path.join(botRoot, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
    const brain = new BotBrainRouter({ worker: new BotDshBrain({ getHost: async () => ({ client }) }), app: new BotAppBrain({ root: path.join(botRoot, 'router'),
      fetchFn: async (...args) => { if (new URL(String(args[0])).host === new URL(model.baseUrl!).host) report.actualModel = true; return fetch(...args); },
      reconcileTool: (call, signal) => service!.reconcileToolReceipt(call, signal) }) });
    const run = brain.run.bind(brain);
    brain.run = async input => {
      if (input.role !== 'worker') { routerRequests.push({ eventId: input.eventId, laneId: input.laneId, prompt: input.prompt }); service?.store.setMetadata(`skipCapture:${input.eventId}`, 'true'); return run(input); }
      const task = service!.store.getTask(input.laneId.slice('worker-'.length))!;
      const row: typeof timeline[number] = { taskId: task.id, companionId: task.companionId, conversationId: task.conversationId, prompt: input.prompt,
        continuation: input.taskContinuation, cwd: input.cwd, startedAt: Date.now(), toolNames: [] }; timeline.push(row);
      await writeFile(path.join(output, `worker-prompt-${timeline.length}.txt`), input.prompt); progress('worker-admitted', { owner: row.companionId, taskId: row.taskId, continuation: !!row.continuation });
      try {
        if (scenario === 'group' && task.companionId === 'gpt' && !input.taskContinuation) {
          await new Promise<void>((resolve, reject) => { const abort = () => reject(input.signal?.reason ?? Error('Admission cancelled')); input.signal?.addEventListener('abort', abort, { once: true });
            westGate.then(() => { input.signal?.removeEventListener('abort', abort); resolve(); }); if (input.signal?.aborted) abort(); });
        }
        row.nativeStartedAt = Date.now();
        const result = await run({ ...input, onEvent: event => { if (event.type === 'tool_call' && event.toolName) row.toolNames.push(event.toolName); input.onEvent?.(event); } });
        row.sessionId = result.sessionId; report.actualNativeWorker = true; return result;
      } finally { row.endedAt = Date.now(); }
    };
    service = new BotService({ root: botRoot, brainRuntime: 'worldlinebox', brain, media, prewarmMemory: false,
      memory: new NoMemory({ root: path.join(botRoot, 'memory'), runtime: async () => { throw Error('Memory disabled for isolated collaboration fixture.'); }, embedding: async () => { throw Error('No memory embedding in handoff fixture.'); } }),
      model: () => ({ ...model, baseUrl: model.baseUrl! }), onEvent: () => sample(), report: error => { const message = safe(error); errors.push(message); progress('runtime-error', { message }); } });
    await service.handle({ type: 'state' });
    const a = DEFAULT_BOT_COMPANION_ID, aName = service.store.getCompanion(a)!.name, bName = service.store.getCompanion('gpt')!.name;
    const direct = service.store.openDirect(a), otherPrivate = service.store.openDirect('gpt');
    for (const [conversationId, marker] of [[direct.id, 'PRIVATE_A_CANARY_3C9'], [otherPrivate.id, 'PRIVATE_B_CANARY_8D2']] as const)
      service.store.enqueue({ conversationId, senderId: 'user', recipientIds: [], sourceMessageId: randomUUID(), content: marker + '：仅本私聊的无关个人资料，不能发给其他会话。' });
    const room = scenario === 'group' ? service.store.createGroup({ title: '真实多伙伴核算协作', memberIds: [a, 'gpt'], participationMode: 'mentions' }) : direct;
    report.conversation = { id: room.id, kind: room.kind, members: room.memberIds };
    const data: Record<string, string> = {
      'orders.csv': 'order_id,region,status,date,gross_cents,shipping_cents,refund_cents\nA01,E,paid,2026-11-02,12000,800,1000\nA02,E,paid,2026-11-03,8000,0,0\nA03,W,paid,2026-11-03,15000,1000,2000\nA04,E,cancelled,2026-11-04,9000,0,0\nA05,E,paid,2026-11-05,5000,500,500\nA06,E,paid,2026-10-31,6000,0,1000\nA07,W,paid,2026-11-06,7000,500,0\nA08,E,pending,2026-11-07,6000,400,1000\n',
      'policy.md': '# 统计口径\nE为华东，W为华西。日期2026-11-01至2026-11-07（含首尾），只计paid。金额全为人民币分。净收入=毛收入-运费-退款。退款更正以refunds.json替换旧值，不相加。\n',
      'refunds.json': JSON.stringify({ replacements: { A01: 2000, A05: 1000 }, unit: 'CNY_cent' }),
      'unrelated-hobby.txt': 'UNRELATED_HOBBY_79A：午饭咖喱和桌宠动画，与核算无关。\n',
    };
    for (const [name, content] of Object.entries(data)) await writeFile(path.join(inputRoot, name), content);
    const refs = await media.importFiles({ conversationId: room.id, paths: Object.keys(data).map(name => path.join(inputRoot, name)) });
    service.store.enqueue({ conversationId: room.id, senderId: 'user', recipientIds: [], sourceMessageId: randomUUID(), content: '先收资料，不执行。政策和更正适用于全部订单；音效/爱好无关。', attachments: refs });
    const send = async (content: string, replyToTaskId?: string) => {
      const result = await service!.handle({ type: 'message.send', conversationId: room.id, content, requestId: randomUUID(), ...(replyToTaskId ? { replyToTaskId } : {}) });
      if (!result.ok) throw Error('Message was rejected.'); for (const reply of result.replyMessageIds ?? []) service!.store.setMetadata(`skipCapture:${service!.store.getMessage(reply)!.eventId}`, 'true');
      return result;
    };
    let finalTaskIdForAudit = '';
    if (scenario === 'group') {
      stage = 'group-initial-work';
      await send(`@${aName} @${bName} 请一起完成这次核算。明确分工表如下，请每位仅领取自己姓名所在行，派发前核对本人姓名与区域，不能领取其他伙伴那一行：
| 伙伴姓名 | 唯一负责区域 | 交付文件 |
| ${aName} | 华东 E | east.json |
| ${bName} | 华西 W | west.json |
各自登记仅包含本人区域的一阶段计划，通过自己的DSH Worker读取orders.csv、policy.md、refunds.json，只读原件、不联网，按政策和更正计算本区域金额。各自仅派一份任务；收到结果核对是否符合本人分工，若有错沿原任务更正，不重复创建任务。输出字段region、includedOrderIds、excluded（本区域被排除的orderId及reason）、grossYuan、shippingYuan、refundYuan、netYuan，单位元保留两位小数。每人把自己的真实文件发送在本群并简述数字，暂不汇总对方任务，也不要新建群或联系其他私聊。无关爱好和私聊不传给Worker。本次是隔离验收，不保存长期记忆。`);
      await until(() => service!.store.listTasks().some(task => task.companionId === a && task.status === 'succeeded') && timeline.some(row => row.companionId === 'gpt'), 'east-complete-west-held');
      const eastTask = service.store.listTasks().find(task => task.companionId === a)!;
      stage = 'user-amendment';
      await send(`补充原任务：华东还须排除A02（用户明确要求，reason写“用户排除”），按其余原口径重新核算并更新同一份east.json，再发送更新后的真实文件。请沿此原任务继续，不新建任务；不改任何原件，不处理华西，不保存长期记忆。`, eastTask.id);
      await until(() => timeline.some(row => row.taskId === eastTask.id && row.continuation && row.nativeStartedAt && !row.endedAt), 'same-task-amendment-admitted');
      releaseWest();
      await until(async () => {
        const row = timeline.filter(row => row.taskId === eastTask.id).findLast(row => row.continuation);
        if (!row || service!.store.getTask(eastTask.id)?.status !== 'succeeded') return false;
        try { return Number(JSON.parse(await readFile(path.join(row.cwd, 'east.json'), 'utf8')).netYuan) === 127; } catch { return false; }
      }, 'same-task-amendment-complete');
      await until(() => service!.store.listTasks().filter(task => task.companionId === 'gpt' && task.status === 'succeeded').length === 1, 'west-complete');
      await until(async () => {
        const corrected = timeline.findLast(row => row.taskId === eastTask.id && row.continuation), west = service!.store.listTasks().find(task => task.companionId === 'gpt');
        if (!corrected || !west) return false;
        const expectedEast = hash(await readFile(path.join(corrected.cwd, 'east.json')));
        return service!.store.publicationsForTask(eastTask.id).some(publication => service!.store.getMessage(publication.messageId)?.attachments?.some(ref => ref.name === 'east.json' && ref.sha256 === expectedEast))
          && service!.store.publicationsForTask(west.id).some(publication => service!.store.getMessage(publication.messageId)?.attachments?.some(ref => ref.name === 'west.json'));
      }, 'group-both-real-reports-delivered', 90000);
      stage = 'group-combine';
      await send(`@${aName} 现在两位的报告都已交付。请读取本群最新east.json与west.json，east必须采用我补充“排除A02”之后的最新版本，交给你的一位DSH Worker合并两份真实报告，生成combined.json，字段eastNetYuan、westNetYuan、totalNetYuan、sourceReports（两份报告文件名及hash或来源说明）。只读两份报告、不重做原始核算、不联网。请把最终文件发送本群并报告合计；这项汇总只由你执行，GPT不用另派任务。不要保存长期记忆。`);
      await until(() => service!.store.listTasks().filter(task => task.companionId === a).length === 2 && service!.store.listTasks().every(task => task.status === 'succeeded'), 'group-final-complete');
      const final = timeline.findLast(row => row.companionId === a && row.taskId !== eastTask.id)!;
      finalTaskIdForAudit = final.taskId;
      const combined = JSON.parse(await readFile(path.join(final.cwd, 'combined.json'), 'utf8'));
      if (Number(combined.eastNetYuan) !== 127 || Number(combined.westNetYuan) !== 185 || Number(combined.totalNetYuan) !== 312) throw Error('Group correction or consolidation totals are wrong.');
      const eastRuns = timeline.filter(row => row.taskId === eastTask.id);
      if (eastRuns.length < 2 || new Set(eastRuns.map(row => row.sessionId)).size !== 1) throw Error('Amendment did not reuse the original task and native Session.');
      const eastCorrection = eastRuns.find(row => row.continuation)!, westRun = timeline.find(row => row.companionId === 'gpt')!;
      if (!(eastCorrection.nativeStartedAt! < westRun.endedAt! && westRun.nativeStartedAt! < eastCorrection.endedAt!)) throw Error('The two companions did not have overlapping actual native executions.');
      await until(() => service!.store.publicationsForTask(final.taskId).length > 0, 'group-final-file-delivered', 90000);
      report.result = combined; report.userAmendment = { sameTask: true, sameNativeSession: true, correctedEast: 127, originalEast: 207 }; report.realParticipants = [a, 'gpt']; report.actualParallelWorkers = 2; report.controlledInitialAdmissionGate = true;
      await writeFile(path.join(output, 'combined.json'), JSON.stringify(combined, null, 2));
    } else {
      stage = 'peer-delegation'; releaseWest();
      await send(`请你和${bName}私下协作完成这次核算：先建立一份有依赖关系的小计划，华东和华西可并行，两边的真实报告都到齐后才能汇总。你负责华东E，请正式委派给${bName}负责华西W。通过真实伙伴委派/私聊通道只分享orders.csv、policy.md、refunds.json及这项工作的必要要求，不能复制我的私聊闲聊或其他资料。两位各用自己的DSH Worker，只读原件、不联网，按政策与更正计算；你交付east.json，${bName}交付west.json，各包含region、includedOrderIds、netYuan，单位元。你完成east.json后先把真实文件发在我这个私聊；${bName}完成后把真实报告和文件返回给你。你收到两边真实文件后再交给自己的汇总Worker，让它从本任务附带的真实east.json和west.json绝对路径读取内容，生成combined.json（eastNetYuan、westNetYuan、totalNetYuan、sourceReports）；不能只摘抄JSON文字代替文件交接，不得让汇总Worker搜索其他任务目录找文件。只把这两份区域报告交给汇总Worker，不再重复转交orders.csv、policy.md、refunds.json。把最终文件发回我与你的这个原私聊；不要新建群，不要代替${bName}执行她的核算。这是隔离验收，不保存长期记忆。`);
      await until(() => service!.store.listTasks().some(task => task.companionId === 'gpt' && task.status === 'succeeded'), 'peer-worker-complete', 240000);
      let finalTaskId = '';
      await until(async () => {
        for (const row of timeline.filter(row => row.companionId === a)) try {
          const result = JSON.parse(await readFile(path.join(row.cwd, 'combined.json'), 'utf8'));
          if (Number(result.eastNetYuan) === 207 && Number(result.westNetYuan) === 185 && Number(result.totalNetYuan) === 392 && service!.store.getTask(row.taskId)?.status === 'succeeded') {
            report.result = result; finalTaskId = row.taskId; return true;
          }
        } catch { /* Await the real generated artifact. */ }
        return false;
      }, 'peer-result-return-and-consolidation', 240000);
      const peer = service.store.conversations().find(room => room.kind === 'peer' && room.memberIds.includes(a) && room.memberIds.includes('gpt'));
      if (!peer || peer.memberIds.includes('user') || peer.memberIds.length !== 2) throw Error('Delegation did not use the real two-companion peer audience.');
      await until(() => service!.store.publicationsForTask(finalTaskId).some(publication => {
        const message = service!.store.getMessage(publication.messageId);
        return message?.conversationId === direct.id && message.attachments?.some(ref => ref.name === 'combined.json');
      }), 'peer-final-file-delivered', 90000);
      const final = timeline.findLast(row => row.taskId === finalTaskId);
      if (!final) throw Error('The final artifact did not return to the original user conversation.');
      finalTaskIdForAudit = final.taskId;
      const peerMessages = service.store.messagesPage(peer.id, { limit: 200 }).items;
      for (const message of peerMessages) for (const marker of ['PRIVATE_A_CANARY_3C9', 'PRIVATE_B_CANARY_8D2', 'UNRELATED_HOBBY_79A', '午饭咖喱', '桌宠动画'])
        if (message.content.includes(marker)) throw Error('Delegation exposed unrelated private/history data to peer: ' + marker);
      const peerFiles = peerMessages.flatMap(message => message.attachments ?? []);
      const transferredInputs: object[] = [];
      for (const name of ['orders.csv', 'policy.md', 'refunds.json']) {
        const original = refs.find(ref => ref.name === name)!, transferred = peerFiles.find(ref => ref.name === name && ref.sha256 === original.sha256);
        if (!transferred || transferred.id === original.id || hash(await readFile((await media.getForAgent(peer.id, transferred.id)).path)) !== original.sha256) throw Error('Peer did not receive a verified scoped copy of ' + name);
        transferredInputs.push({ name, sourceId: original.id, peerId: transferred.id, sha256: transferred.sha256 });
      }
      if (peerFiles.some(ref => ref.name === 'unrelated-hobby.txt')) throw Error('Peer received the unrelated attachment.');
      const west = peerFiles.find(ref => ref.name === 'west.json');
      const returnedWest = west && service.store.messagesPage(direct.id, { limit: 200 }).items.flatMap(message => message.attachments ?? []).find(ref => ref.name === 'west.json' && ref.sha256 === west.sha256);
      if (!west || !returnedWest || hash(await readFile((await media.getForAgent(direct.id, returnedWest.id)).path)) !== west.sha256) throw Error('The real peer west.json did not return to the original private audience.');
      const proxy = service.store.listTasks().find(task => task.companionId === a && task.conversationId === direct.id && task.extra.delegationProxy === true);
      const delegatedWorker = service.store.listTasks().find(task => task.companionId === 'gpt' && task.conversationId === peer.id && task.extra.delegationId === proxy?.extra.externalDelegationId);
      if (!proxy || proxy.status !== 'succeeded' || typeof proxy.extra.externalDelegationId !== 'string' || !delegatedWorker) throw Error('Private collaboration did not close a real formal delegation and its linked peer Worker.');
      report.peer = { conversationId: peer.id, userRole: peer.userRole, members: peer.memberIds, targetUsedOwnWorker: true, resultReturnedToOriginalDirect: true,
        delegationId: proxy.extra.externalDelegationId, proxyTaskId: proxy.id, delegatedWorkerTaskId: delegatedWorker.id,
        transferredInputs, returnedReport: { name: west.name, sha256: west.sha256, originalDirectId: returnedWest.id } };
      await writeFile(path.join(output, 'combined.json'), JSON.stringify(report.result, null, 2));
    }
    stage = 'assert-context-and-files';
    const promptAudit: object[] = [];
    for (const row of timeline) {
      for (const marker of ['PRIVATE_A_CANARY_3C9', 'PRIVATE_B_CANARY_8D2', 'UNRELATED_HOBBY_79A', '午饭咖喱', '桌宠动画']) if (row.prompt.includes(marker)) throw Error('Worker received unrelated private/history data: ' + marker);
      const saved = JSON.parse(await readFile(path.join(row.cwd, '.worldlinebox/task-input.json'), 'utf8'));
      if (saved.requirements !== service.store.getTask(row.taskId)!.goal || saved.files.some((file: { name: string }) => file.name === 'unrelated-hobby.txt')) throw Error('Task requirements or selected file scope was not preserved.');
      if (row.taskId === finalTaskIdForAudit && (!['east.json', 'west.json'].every(name => saved.files.some((file: { name: string }) => file.name === name))
        || saved.files.some((file: { name: string; path: string }) => !['east.json', 'west.json'].includes(file.name) || !path.isAbsolute(file.path))))
        throw Error('Consolidation Worker did not receive exactly the two scoped real reports by absolute path.');
      promptAudit.push({ taskId: row.taskId, companionId: row.companionId, promptChars: row.prompt.length, requirementChars: saved.requirements.length,
        fileNames: saved.files.map((file: { name: string }) => file.name), exactTaskRequirements: true, unrelatedPrivateHistoryAbsent: true });
    }
    for (const [name, content] of Object.entries(data)) {
      if (await readFile(path.join(inputRoot, name), 'utf8') !== content) throw Error('Original fixture changed.');
      const ref = refs.find(ref => ref.name === name)!; if (hash(await readFile((await media.getForAgent(room.id, ref.id)).path)) !== hash(content)) throw Error('Canonical input was changed.');
    }
    await until(() => !(service!.store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE status IN ('queued','running') LIMIT 1").all()) as unknown[]).length,
      'all-routers-settled', 90000);
    report.passed = true; report.workers = timeline.map(({ taskId, companionId, conversationId, startedAt, nativeStartedAt, endedAt, sessionId, toolNames, continuation }) => ({ taskId, companionId, conversationId, startedAt, nativeStartedAt, endedAt, sessionId, toolNames, continuation: !!continuation }));
    report.sourceFilesUnchanged = true; report.contextScopePassed = true; report.allRoutersSettled = true; report.promptAudit = promptAudit; report.stateSamples = states.length; report.errors = errors;
  } catch (error) { report.passed = false; report.stage = stage; report.error = safe(error); report.errors = errors; }
  finally {
    releaseWest();
    if (service) try {
      const db = new Sqlite(path.join(root, 'bot/router/app-brain.sqlite'), { readonly: true });
      try { const calls = db.prepare('SELECT event_id,name,args_json,state,result_json FROM app_calls').all() as Array<{ name: string }>;
        report.memoryWriteAttempts = calls.filter(call => call.name === 'memory_write').length;
        await writeFile(path.join(output, 'router-journal.json'), redact(JSON.stringify({ tasks: service.store.listTasks(), conversations: service.store.conversations(),
        messages: service.store.conversations().map(room => ({ conversationId: room.id, items: service!.store.messagesPage(room.id, { limit: 200 }).items })),
        turns: db.prepare('SELECT event_id,state,text,error FROM app_turns').all(), calls, routerRequests, timeline, states }, null, 2))); } finally { db.close(); }
    } catch (error) { report.diagnosticError = safe(error); }
    try { await service?.shutdown(); await native?.close(); } catch (error) { report.passed = false; report.cleanupError = safe(error); }
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2)); process.send?.(report); app.exit(report.passed ? 0 : 1);
  }
});
