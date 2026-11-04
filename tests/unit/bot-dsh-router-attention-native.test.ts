import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { preserveBotNativeJournals } from '../fixtures/bot-native-journal-evidence';

class NoMemoryModel extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No memory runtime in the native protocol fixture'); }, embedding: async () => { throw Error('No embedding in the native protocol fixture'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, inputHash: 'fixture', messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async close() {}
}
type Message = { role: string; content?: unknown };
type Envelope = { envelope: { eventId: string }; trigger: { source: string; content: string; task?: { taskId: string; questionId?: string } };
  tasks: Array<{ id: string; goal: string; attention?: { questionId: string } }> };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, detail: string) {
  const deadline = Date.now() + 45000;
  while (!check()) { if (Date.now() > deadline) throw Error(`Native router acceptance timed out: ${detail}`); await pause(20); }
}

/** Genuine App HTTP/tool receipts, native DSH tools and native question polling.
 * The localhost driver is scripted: this checks transport/authority, not model quality. */
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('uses a full-access group worker on the shared Host and lets its App router resolve known details while asking the user for a missing preference', async () => {
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const output = path.resolve('artifacts/superagent-bot-development/dsh-router-attention-native', path.basename(native.root)); await mkdir(output, { recursive: true });
  const appRoot = path.join(native.root, 'application'), destination = path.join(native.root, 'explicitly-authorized-output');
  await mkdir(appRoot); await mkdir(destination);
  const protectedFile = path.join(destination, 'preserve.txt'); await writeFile(protectedFile, 'MUST_REMAIN_UNCHANGED');
  const goal = (kind: 'AUTO' | 'PREF') => `NATIVE_${kind}: 只在 ${destination} 写入 ${kind.toLowerCase()}-proof.txt；AUTO采用JSON，PREF颜色尚未指定；不得读取或修改 preserve.txt，不删除文件，不扫描其他目录。`;
  const appSteps = new Map<string, number>(), requestLog: Array<Record<string, unknown>> = [], hostRequests: Array<string | undefined> = [];
  let service: BotService | undefined, appBrain: BotAppBrain | undefined, worker: BotDshBrain | undefined;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as { messages: Message[]; tools?: Array<{ function?: { name: string } }> };
      const appRequest = body.tools?.some(tool => tool.function?.name === 'dsh_task');
      let call: { name: string; args: object; id: string } | undefined, content = '{"notes":[]}';
      if (appRequest) {
        const envelope = body.messages.toReversed().map(message => { try { return JSON.parse(String(message.content)) as Envelope; } catch { return undefined; } }).find(value => value?.trigger && value.envelope);
        if (!envelope) throw Error('App request lacks the real trigger envelope');
        const eventId = envelope.envelope.eventId, step = appSteps.get(eventId) ?? 0; appSteps.set(eventId, step + 1);
        const trigger = envelope.trigger;
        requestLog.push({ engine: 'app', eventId, step, source: trigger.source, task: trigger.task });
        if (trigger.source === 'user' && /^NATIVE_(AUTO|PREF)$/u.test(trigger.content) && step === 0) {
          const kind = trigger.content.endsWith('AUTO') ? 'AUTO' : 'PREF';
          call = { name: 'dsh_task', args: { title: `原生${kind}验收`, goal: goal(kind) }, id: `delegate-${kind}` };
        } else if (trigger.source === 'task' && trigger.task?.questionId) {
          const task = service!.store.getTask(trigger.task.taskId)!;
          if (task.goal.startsWith('NATIVE_PREF')) content = '你希望选择Blue还是Green？';
          else if (step === 0) call = { name: 'dsh_task_control', args: { operation: 'status', taskId: task.id }, id: 'read-real-question' };
          else if (step === 1) call = { name: 'dsh_task_control', args: { operation: 'answer', taskId: task.id, questionId: trigger.task.questionId,
            answers: [{ id: 'format', selected: ['JSON'] }] }, id: 'answer-authorized-format' };
          else content = '已依据原目标继续处理。';
        } else if (trigger.source === 'user' && trigger.content === '颜色选Blue' && step === 0) {
          const pending = envelope.tasks.find(task => task.goal.startsWith('NATIVE_PREF') && task.attention);
          if (!pending?.attention) throw Error('User response lost the pending native question');
          call = { name: 'dsh_task_control', args: { operation: 'answer', taskId: pending.id, questionId: pending.attention.questionId,
            answers: [{ id: 'colour', selected: ['Blue'] }] }, id: 'answer-real-user-preference' };
        } else content = trigger.source === 'task' ? '任务已完成，实际文件已核验。' : '任务已经交给执行器。';
      } else if (body.tools?.length) {
        const serialized = JSON.stringify(body.messages), prefix = serialized.includes('NATIVE_AUTO:') ? 'AUTO' : 'PREF';
        const tools = body.messages.filter(message => message.role === 'tool');
        requestLog.push({ engine: 'native', kind: prefix, toolReceipts: tools.length, results: tools.map(message => message.content) });
        if (!tools.length) call = { name: 'ask_user_question', id: `ask-${prefix}`, args: { questions: [{ id: prefix === 'AUTO' ? 'format' : 'colour',
          question: prefix === 'AUTO' ? '原目标明确JSON，采用什么格式？' : '原目标没有指定颜色，用户希望什么颜色？',
          options: (prefix === 'AUTO' ? ['JSON', 'Markdown'] : ['Blue', 'Green']).map(label => ({ label, description: `Fixture ${label}` })) }] } };
        else if (tools.length === 1) {
          expect(JSON.stringify(tools[0])).toContain(prefix === 'AUTO' ? 'JSON' : 'Blue');
          call = { name: 'write', id: `write-${prefix}`, args: { file_path: path.join(destination, `${prefix.toLowerCase()}-proof.txt`), content: `FULL_NATIVE_${prefix}` } };
        } else { expect(JSON.stringify(tools.at(-1))).not.toMatch(/Error:|denied/iu); content = `实际产物 FULL_NATIVE_${prefix} 已写入`; }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content };
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 40 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('Local protocol endpoint unavailable');
    const client = await native.instances.ensureHost(native.instance.id), hostPid = client.pid;
    worker = new BotDshBrain({ getHost: async instanceId => { hostRequests.push(instanceId); return { client, instance: native.instance }; } });
    appBrain = new BotAppBrain({ root: appRoot });
    const brain = new BotBrainRouter({ app: appBrain, worker });
    service = new BotService({ root: path.join(appRoot, 'bot'), brain, brainRuntime: 'worldlinebox', memory: new NoMemoryModel(appRoot), onEvent: () => undefined,
      model: () => ({ apiFormat: 'openai_chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local-protocol-fixture', apiKey: 'local-fixture-no-billing', contextWindow: 131072, maxTokens: 2048 }) });
    await service.handle({ type: 'state' });
    const created = await service.handle({ type: 'conversation.create', kind: 'group', title: '真实DSH主脑问答验收', memberIds: [DEFAULT_BOT_COMPANION_ID], participationMode: 'all' });
    const room = created.conversationId!;
    await service.handle({ type: 'message.send', conversationId: room, content: 'NATIVE_AUTO', requestId: 'native-auto' });
    await until(() => service!.store.listTasks(room).some(task => task.goal.startsWith('NATIVE_AUTO') && task.status === 'succeeded'), 'auto task result');
    const auto = service.store.listTasks(room).find(task => task.goal.startsWith('NATIVE_AUTO'))!;
    expect(auto.extra.workerAccess).toBe('full'); expect(auto.goal).toBe(goal('AUTO'));
    expect((await readFile(path.join(destination, 'auto-proof.txt'), 'utf8')).trim()).toBe('FULL_NATIVE_AUTO');
    await service.handle({ type: 'message.send', conversationId: room, content: 'NATIVE_PREF', requestId: 'native-pref' });
    await until(() => service!.store.listTasks(room).some(task => task.goal.startsWith('NATIVE_PREF') && task.status === 'waiting'), 'unknown preference waits');
    const pref = service.store.listTasks(room).find(task => task.goal.startsWith('NATIVE_PREF'))!;
    await until(() => service!.store.messagesPage(room).items.some(message => message.senderId === DEFAULT_BOT_COMPANION_ID && message.content === '你希望选择Blue还是Green？' && message.status === 'sent'), 'natural user question');
    expect(await readFile(path.join(destination, 'pref-proof.txt'), 'utf8').catch(() => 'ABSENT')).toBe('ABSENT');
    expect(service.store.taskTransaction(sql => sql.prepare('SELECT answers_json FROM bot_task_questions WHERE task_id=?').get(pref.id))).toMatchObject({ answers_json: null });
    await service.handle({ type: 'message.send', conversationId: room, content: '颜色选Blue', requestId: 'native-user-preference' });
    await until(() => service!.store.getTask(pref.id)?.status === 'succeeded', 'explicit user preference reaches worker');
    expect((await readFile(path.join(destination, 'pref-proof.txt'), 'utf8')).trim()).toBe('FULL_NATIVE_PREF');
    expect(await readFile(protectedFile, 'utf8')).toBe('MUST_REMAIN_UNCHANGED');
    expect(service.store.listTasks(room)).toHaveLength(2); expect(new Set(hostRequests)).toEqual(new Set([undefined])); expect(client.pid).toBe(hostPid);
    expect(service.store.taskTransaction(sql => sql.prepare('SELECT COUNT(*) AS n FROM bot_task_controls WHERE kind=\'answer\'').get())).toMatchObject({ n: 2 });
    await service.shutdown(); service = undefined;
    await preserveBotNativeJournals(native.root, path.join(output, 'native-journals.json'), value => value);
    const journals = JSON.parse(await readFile(path.join(output, 'native-journals.json'), 'utf8')) as Array<{ path: string; records: Array<{ type: string; data?: Record<string, unknown> }> }>;
    const workerJournals = journals.filter(journal => journal.records.some(record => record.type === 'user/message' && JSON.stringify(record).includes('NATIVE_')));
    expect(workerJournals).toHaveLength(2);
    for (const journal of workerJournals) {
      expect(journal.records.filter(record => record.type === 'sandbox/mode').at(-1)?.data).toMatchObject({ mode: 'danger-full-access' });
      expect(journal.records.filter(record => record.type === 'approval/policy').at(-1)?.data).toMatchObject({ policy: 'never' });
      expect(journal.records.some(record => record.type === 'approval/asked')).toBe(false);
    }
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ actualNativeHost: true, actualAppHttp: true, actualToolHttp: true, usesPaidModel: false, modelQualityAcceptance: false,
      hostPid, sharedInstanceId: native.instance.id, taskIds: [auto.id, pref.id], nativeFullAccessSessions: workerJournals.length, knownDetailAnsweredAutomatically: true,
      missingPreferenceWaitedForUser: true, nativeExternalWorkspaceWritesVerified: 2, protectedFileUnchanged: true, originalGoalAndConstraintsUnchanged: true, requestLog }, null, 2));
  } finally {
    await writeFile(path.join(output, 'requests.json'), JSON.stringify(requestLog, null, 2));
    await preserveBotNativeJournals(native.root, path.join(output, 'native-journals.json'), value => value).catch(() => undefined);
    if (service) await writeFile(path.join(output, 'task-records.json'), JSON.stringify(service.store.listTasks(), null, 2));
    await service?.shutdown(); await appBrain?.close(); await worker?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await native.close();
  }
}, 120000);
