/** Opt-in production Router/native Worker acceptance. The only injected
 * fault is termination of this fixture's own DSH Host process tree. */
import { app, safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BotService } from '../../src/main/companion-bot/service';
import type { BotTaskSql } from '../../src/main/companion-bot/store';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { botTaskElapsedMs } from '../../src/shared/companion-bot-task-clock';
import { createBotNativeHost } from './bot-native-host';
import type { BotTask } from '../../src/main/companion-bot/types';

const root = process.env.WORLDLINEBOX_RESILIENCE_ROOT!, output = process.env.WORLDLINEBOX_RESILIENCE_OUTPUT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
if (process.env.WORLDLINEBOX_RESILIENCE_REAL !== '1' || !root || !output || !source) throw Error('Explicit isolated real resilience inputs are required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const exists = (file: string) => access(file).then(() => true, () => false);
const progress = (stage: string, data: object = {}) => process.send?.({ kind: 'resilience-progress', stage, ...data });
const taskPhase = (task: BotTask) => (task.extra.progress as { phase?: string } | undefined)?.phase;
class NoMemory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> { return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'memory-disabled-for-resilience', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  override async close() {}
}
void app.whenReady().then(async () => {
  let service: BotService | undefined, native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined, secret = '', stage = 'configuration', conversationId = '';
  const report: Record<string, unknown> = { kind: 'resilience-result', passed: false, actualModel: false, actualNativeWorker: false, memoryDisabled: true,
    design: ['actual user conversation pause', 'supplement while paused', 'same task resume', 'owned DSH process interruption and same session recovery', 'actual user conversation stop', 'frozen timer and no late result'] };
  const safe = (error: unknown) => (error instanceof Error ? error.message : String(error)).replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/giu, 'Bearer <redacted>').slice(0, 1600);
  const errors: string[] = [], transitions: Array<{ at: number; taskId: string; status: string; phase?: string }> = [];
  const dispatches: Array<{ taskId: string; eventId: string; sessionId: string; cwd: string; at: number; promptHash: string; result?: string; error?: string }> = [];
  try {
    const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = catalog.profiles.find((value: { id: string }) => value.id === catalog.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/u.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('No decryptable configured model.');
    const model = { ...resolveStoredLlmConfig(profile), apiKey: safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin'))) };
    secret = model.apiKey;
    if (model.apiFormat !== 'openai_chat' || !model.baseUrl || new URL(model.baseUrl).host !== 'api.deepseek.com' || model.model !== 'deepseek-flash' || !secret) throw Error('This acceptance requires the configured official api.deepseek.com / deepseek-flash connection.');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host }; progress(stage, report.model as object);
    stage = 'native-host'; native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!); process.send?.({ kind: 'resilience-owned-root', root: native.root }); report.dshVersion = native.runtimeVersion;
    const botRoot = path.join(root, 'bot'), inputs = path.join(root, 'inputs'); await mkdir(inputs);
    const records = path.join(inputs, 'records.json'), gate = path.join(inputs, 'release.txt'); await writeFile(records, JSON.stringify({ values: [2, 3, 5] }));
    const media = new BotMediaService({ root: path.join(botRoot, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
    const worker = new BotDshBrain({ getHost: async (_id, signal) => ({ client: await native!.instances.ensureHost(native!.instance.id, signal) }) });
    const brain = new BotBrainRouter({ worker, app: new BotAppBrain({ root: path.join(botRoot, 'router'), fetchFn: async (...args) => { report.actualModel = true; return fetch(...args); }, reconcileTool: (call, signal) => service!.reconcileToolReceipt(call, signal) }) });
    const run = brain.run.bind(brain);
    brain.run = async input => {
      if (input.role !== 'worker') return run(input);
      const row: typeof dispatches[number] = { taskId: input.laneId.slice(7), eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), cwd: input.cwd, at: Date.now(), promptHash: createHash('sha256').update(input.prompt).digest('hex') }; dispatches.push(row);
      await writeFile(path.join(output, `worker-prompt-${dispatches.length}.txt`), input.prompt); progress('native-dispatch', { taskId: row.taskId, attempt: dispatches.length });
      try { const result = await run(input); report.actualNativeWorker = true; row.result = result.status; return result; }
      catch (error) { row.error = safe(error); throw error; }
    };
    service = new BotService({ root: botRoot, brainRuntime: 'worldlinebox', brain, media, prewarmMemory: false,
      memory: new NoMemory({ root: path.join(botRoot, 'memory'), runtime: async () => { throw Error('Memory disabled for this acceptance.'); }, embedding: async () => { throw Error('No memory embedding.'); } }),
      model: () => ({ ...model, baseUrl: model.baseUrl! }), onEvent: () => { for (const task of service?.store.listTasks() ?? []) { const last = transitions.findLast(value => value.taskId === task.id); if (last?.status !== task.status || last?.phase !== taskPhase(task)) transitions.push({ at: Date.now(), taskId: task.id, status: task.status, phase: taskPhase(task) }); } }, report: error => errors.push(safe(error)) });
    await service.handle({ type: 'state' }); conversationId = service.store.openDirect(DEFAULT_BOT_COMPANION_ID).id;
    const waitFor = async <T>(label: string, read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 120000): Promise<T> => {
      const deadline = Date.now() + timeout; let last: T;
      while (Date.now() < deadline) { await service!.handle({ type: 'state', conversationId }); last = await read(); if (accept(last)) return last; await pause(250); }
      throw Error(`${label} timed out; tasks=${JSON.stringify(service!.store.listTasks().map(task => ({ id: task.id, status: task.status, phase: taskPhase(task), error: task.error })))}`);
    };
    const clockFor = async (taskId: string) => {
      const response = await service!.handle({ type: 'task.get', conversationId, taskId });
      if (!response.ok || !response.task) throw Error('Could not read the same normalized task clock used by the UI.');
      return botTaskElapsedMs(response.task);
    };
    const chat = async (content: string, taskId?: string) => {
      progress('user-message', { text: content.slice(0, 80) });
      const response = await service!.handle({ type: 'message.send', conversationId, content, requestId: randomUUID(), ...(taskId ? { replyToTaskId: taskId } : {}) });
      if (!response.ok || !response.replyMessageIds?.[0]) throw Error('Actual user message was rejected.');
      const id = response.replyMessageIds[0], event = service!.store.getMessage(id)!.eventId; service!.store.setMetadata(`skipCapture:${event}`, 'true');
      return { replyId: id, eventId: event };
    };
    const initial = await chat(`请通过 DSH 建立一个批次核对任务，题目“分批核对与恢复验收”。严格只建一个dsh_task，不创建dsh_plan，不拆成多个Worker；以下两段是同一个Worker任务内部的步骤，共享工作目录。本次还要验证真实结构化反问：Worker在读取样例前必须实际调用一次原生ask_user，询问“最终报告使用哪种语言？”，选项“中文”和“英文”，并收到回答才继续。这是必要验收步骤不能省略；我已经明确授权使用中文，因此主脑收到这个Worker问题后，主动读取原问题并以中文原选项回答，不再反问我，不能由主脑替Worker伪造提问。原始样例文件绝对路径：${records}。全程不联网，只读原件，只在这个任务工作目录写结果。阶段一读取 values 并计算 count/sum，把真实结果写 phase-1.json。阶段二必须等待门文件 ${gate} 出现后，才继续完成 final.json（含 count、sum、label），并通过原聊天交付文件。label 初始为“初始”，后续我会补充更正。为了让我验证暂停和断线恢复，阶段一后使用一个最长180秒的 Python 等待进程，每秒检查门文件；可将终端等待分成≤10秒片段，但门未出现不可结束任务或编造完成。中断后沿用此任务和会话，从已有检查点继续，不重复派发新任务。不记录长期记忆。`);
    stage = 'phase-one'; progress(stage);
    await waitFor('native dispatch', () => dispatches[0], Boolean);
    const first = dispatches[0]!, taskId = first.taskId;
    await waitFor('worker-created phase-one checkpoint', () => exists(path.join(first.cwd, 'phase-1.json')), Boolean, 180000);
    const checkpointBytes = await readFile(path.join(first.cwd, 'phase-1.json')), checkpoint = JSON.parse(checkpointBytes.toString('utf8'));
    if (checkpoint.count !== 3 || checkpoint.sum !== 10) throw Error('Actual first phase result is incorrect.'); report.actualNativeWorker = true;
    await writeFile(path.join(output, 'phase-1.json'), checkpointBytes);
    stage = 'conversational-pause'; progress(stage, { taskId }); await chat('暂停这个分批核对任务，现在先不要继续。请你真正暂停执行器，保留原任务和已经完成的检查点，不要新建任务。', taskId);
    await waitFor('conversation pause', () => service!.store.getTask(taskId), task => task?.status === 'paused');
    const frozen = await clockFor(taskId); await pause(1800);
    if (await clockFor(taskId) !== frozen || await exists(path.join(first.cwd, 'final.json'))) throw Error('Paused task continued its normalized UI clock or created the final result.');
    stage = 'supplement-while-paused'; progress(stage); const supplement = await chat('只补充信息，不恢复任务：最终 final.json 的 label 必须改成“用户补充-橙色”，仍先保持暂停。这个更正取代初始label。', taskId);
    await waitFor('supplement Router response', () => service!.store.getMessage(supplement.replyId), message => !!message && !['queued', 'running'].includes(message.status));
    if (service.store.getTask(taskId)?.status !== 'paused') throw Error('Supplement without resume unexpectedly resumed the task.');
    stage = 'conversational-resume'; progress(stage); await chat('现在继续刚才暂停的原任务，保留原会话与phase-1.json检查点，最终label使用我补充的“用户补充-橙色”。继续等待门文件，不要额外派新任务。', taskId);
    await waitFor('same task resumed', () => service!.store.getTask(taskId), task => task?.status === 'running');
    await waitFor('resumed native attachment', () => dispatches.filter(row => row.taskId === taskId).length, count => count >= 2);
    stage = 'owned-host-process-interruption'; progress(stage);
    const own = native.instances.get(native.instance.id); if (!own.pid || own.pid === process.pid || own.id !== native.instance.id || !native.root.startsWith(path.join(process.env.TEMP!, 'worldlinebox-bot-host-'))) throw Error('Cannot prove fault target is this acceptance Host.');
    await promisify(execFile)('taskkill.exe', ['/PID', String(own.pid), '/T', '/F'], { windowsHide: true }); report.interruptedOwnedPid = own.pid;
    stage = 'same-session-recovery'; progress(stage);
    await waitFor('host interruption observed', () => ({ task: service!.store.getTask(taskId), attempts: dispatches.filter(row => row.taskId === taskId).length }), value => value.task?.status === 'paused' || value.attempts >= 3);
    if (service.store.getTask(taskId)?.status === 'paused') {
      await chat('刚才执行环境意外断开了。现在明确继续这个原任务，重新启用它自己的执行环境，沿原会话和原检查点恢复；不要新建任务。label仍使用“用户补充-橙色”。', taskId);
      report.explicitResumeAfterHostInterruption = true;
    }
    await waitFor('recovered native dispatch', () => dispatches.filter(row => row.taskId === taskId).length, count => count >= 3);
    await writeFile(gate, 'release supplied by the acceptance environment; business output must still be produced by the actual Worker.');
    const completed = await waitFor('recovered native completion', () => service!.store.getTask(taskId), task => task?.status === 'succeeded', 180000);
    const finalBytes = await readFile(path.join(first.cwd, 'final.json')), final = JSON.parse(finalBytes.toString('utf8'));
    if (final.count !== 3 || final.sum !== 10 || final.label !== '用户补充-橙色') throw Error('Recovered Worker failed the actual result or supplemental label.');
    const work = dispatches.filter(row => row.taskId === taskId);
    if (new Set(work.map(row => row.sessionId)).size !== 1 || new Set(work.map(row => row.eventId)).size !== 1 || service.store.listTasks().length !== 1) throw Error('Recovery duplicated the original task/session/event.');
    const questions = service.store.taskTransaction(sql => sql.prepare('SELECT question_id,state,questions_json,answers_json FROM bot_task_questions WHERE task_id=?').all(taskId)) as Array<{ question_id: string; state: string; questions_json: string; answers_json: string | null }>;
    if (!questions.length || !questions.some(question => ['answered', 'closed'].includes(question.state) && question.answers_json?.includes('中文'))) throw Error('No actual native structured question and Router-provided Chinese answer were recorded.');
    const publications = service.store.publicationsForTask(taskId);
    if (!publications.length) throw Error('The real recovered Worker did not publish its artifact to the original chat.');
    if (await readFile(records, 'utf8') !== JSON.stringify({ values: [2, 3, 5] })) throw Error('The original sample file was modified.');
    await writeFile(path.join(output, 'final.json'), finalBytes);
    if (/ENOENT|运行时缺失|无法启动/u.test(completed!.summary ?? '')) report.nativeToolLimitation = 'The actual native report disclosed unavailable pwsh/ripgrep tooling and verified the release gate with file tools; terminal long-process cancellation is not claimed by this run.';
    report.recovery = { initial, taskId, nativeAttempts: work.length, sameTaskSessionEvent: true, originalCheckpoint: checkpoint, output: final, pausedClockMs: frozen, status: completed!.status, actualNativeQuestions: questions,
      publications, finalSha256: createHash('sha256').update(finalBytes).digest('hex'), originalSampleUnchanged: true };
    stage = 'conversational-stop'; progress(stage);
    const second = await chat(`再建立一个独立停止验收任务“等待后停止”。读取原样例 ${records}，在任务目录写 stop-ready.json（count=真实数量），然后等待 ${path.join(inputs, 'never-release.txt')}。每秒检查，最多120秒；门文件不存在就绝不能输出 stop-final.json。出现后才写最终文件并交付。这只是本地样例任务，不联网、不修改原件，不记录长期记忆。`);
    await waitFor('second actual task', () => service!.store.listTasks().find(task => task.id !== taskId), Boolean);
    const stoppedTask = service.store.listTasks().find(task => task.id !== taskId)!;
    await waitFor('second native dispatch', () => dispatches.find(row => row.taskId === stoppedTask.id), Boolean);
    const stoppedWork = dispatches.find(row => row.taskId === stoppedTask.id)!;
    await waitFor('second ready checkpoint', () => exists(path.join(stoppedWork.cwd, 'stop-ready.json')), Boolean, 180000);
    await chat('停止“等待后停止”这个任务。我不需要它了，立即停止，不要恢复、不要重派，也不要继续等待门文件。保留已产生的样例检查点即可。', stoppedTask.id);
    await waitFor('conversation stop', () => service!.store.getTask(stoppedTask.id), task => task?.status === 'cancelled');
    const clock = await clockFor(stoppedTask.id), dispatchCount = dispatches.length, summary = service.store.getTask(stoppedTask.id)!.summary;
    await writeFile(path.join(inputs, 'never-release.txt'), 'late release after user cancellation'); await pause(4500); await service.handle({ type: 'state', conversationId });
    const late = service.store.getTask(stoppedTask.id)!;
    if (late.status !== 'cancelled' || await clockFor(stoppedTask.id) !== clock || late.summary !== summary || dispatches.length !== dispatchCount || await exists(path.join(stoppedWork.cwd, 'stop-final.json'))) throw Error('Stopped task accepted late work, resumed, or continued counting.');
    report.stop = { source: second, taskId: stoppedTask.id, status: late.status, clockMs: clock, noLateResultAfterRelease: true, noRedispatch: true };
    report.passed = true; report.errors = errors;
  } catch (error) { report.passed = false; report.stage = stage; report.error = safe(error); report.errors = errors; }
  finally {
    if (service) try {
      const Sqlite = Database as new (filename: string, options: { readonly: boolean }) => BotTaskSql & { close(): void };
      const db = new Sqlite(path.join(root, 'bot/router/app-brain.sqlite'), { readonly: true });
      try { await writeFile(path.join(output, 'router-journal.json'), JSON.stringify({ tasks: service.store.listTasks(), messages: conversationId ? service.store.recentMessages(conversationId, { limit: 50 }) : [],
        turns: db.prepare('SELECT event_id,state,text,error FROM app_turns').all(), calls: db.prepare('SELECT event_id,call_id,name,args_json,state,result_json FROM app_calls').all(), dispatches, transitions }, null, 2).replaceAll(secret || '\0', '<redacted>')); } finally { db.close(); }
    } catch (error) { report.diagnosticError = safe(error); }
    try { await service?.shutdown(); await native?.close(); } catch (error) { report.passed = false; report.cleanupError = safe(error); }
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n'); process.send?.(report); app.exit(report.passed ? 0 : 1);
  }
});
