import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { BotService, type BotServiceOptions } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain, type BotDshResult, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import type { BotEvent as UiEvent, BotMessage } from '../../src/shared/companion-bot';
import type { BotEvent, BotSource } from '../../src/main/companion-bot/types';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { BotAppBrainStore } from '../../src/main/companion-bot/app-brain-store';
import { builtinBotPersonaTemplates } from '../../src/shared/builtin-bot-personas';
import { reportWorkerOutcome } from '../fixtures/bot-worker-report';
import { DEFAULT_MODEL_CONTEXT_WINDOW } from '../../src/shared/model-budget';

class Memory extends BotMemoryService {
  readonly records: Array<Parameters<BotMemoryService['remember']>> = [];
  private readonly prepared = new Map<string, BotMemoryPrepared>();
  constructor(root: string) { super({ root, runtime: async () => { throw new Error('No native memory fixture process'); }, embedding: async () => { throw new Error('No embedding fixture process'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    const prepared: BotMemoryPrepared = { requestId: input.requestId, inputHash: 'fixture', scope: input.scope, messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
    this.prepared.set(input.requestId, prepared); return prepared;
  }
  override async resumePrepared(input: Parameters<BotMemoryService['resumePrepared']>[0]): Promise<BotMemoryPrepared> {
    const prepared = this.prepared.get(input.requestId); if (!prepared) throw new Error('No original preparation'); return prepared;
  }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async remember(...input: Parameters<BotMemoryService['remember']>) { this.records.push(input); return { indexed: 1, pending: 0 }; }
  override async close() {}
}
interface ProviderMessage { role: string; content?: unknown; tool_call_id?: string }
interface ProviderBody { messages: ProviderMessage[]; stream?: boolean; tools?: unknown[]; max_tokens?: number }
type ScriptedChat = string | { name: string; args: Record<string, unknown> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const text = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('') : '';
const sse = (response: ServerResponse, delta: object, finishReason: string | null = null) => response.write('data: ' + JSON.stringify({ id: 'fixture-completion', choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\n');
async function until<T>(read: () => Promise<T | undefined>, timeout = 12000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (value !== undefined) return value; if (Date.now() >= deadline) throw new Error('App service fixture timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function fixture(options: { holdFirstReply?: boolean; retention?: BotServiceOptions['retention']; summaryText?: string;
  upgradeWorkerAccess?(): Promise<void>; chatReply?(body: ProviderBody): ScriptedChat | undefined; workerWaitFirst?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-app-service-'));
  const requests: ProviderBody[] = [], failures: string[] = [], events: UiEvent[] = [];
  let release!: () => void;
  const firstReply = new Promise<void>(resolve => { release = resolve; });
  let captures = 0, taskRequest = 0, summaries = 0;
  const observedTriggers: Array<{ eventId: string; content: string; source: string }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(bytes) as ProviderBody; requests.push(body);
      if (Buffer.byteLength(bytes, 'utf8') + 256 + (body.max_tokens ?? 0) > DEFAULT_MODEL_CONTEXT_WINDOW) throw new Error('The local provider received a request outside its 100k template budget');
      if (!request.url?.endsWith('/chat/completions') || body.stream !== true) { response.writeHead(400).end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.flushHeaders();
      const system = body.messages.filter(message => message.role === 'system').map(message => text(message.content)).join('\n');
      if (system.includes('对话记忆编码器')) {
        captures++;
        const supplied = body.messages.filter(message => message.role === 'user').some(message => text(message.content).includes('麦茶'));
        sse(response, { content: JSON.stringify({ notes: supplied ? [{ content: '用户晚上喝麦茶，白天仍喝咖啡。', tags: ['饮品', '时段偏好'] }] : [] }) });
      } else if (!body.tools?.length) {
        summaries++; sse(response, { content: options.summaryText ?? '已确认多来源事件分别收到，用户只要求在当前受众中持续回应。没有创建任务；需要精确原话时回查VCP，不把摘要冒充原文。' });
      } else {
        let trigger: { content?: string; source?: string } | undefined;
        for (const message of [...body.messages].reverse()) if (message.role === 'user') {
          try { const value = JSON.parse(text(message.content)) as { envelope?: { eventId: string }; trigger?: typeof trigger };
            if (value.trigger) { trigger = value.trigger; if (value.envelope && trigger?.content && trigger.source) observedTriggers.push({ eventId: value.envelope.eventId, content: trigger.content, source: trigger.source }); break; } } catch { /* Historical data may be plain text. */ }
        }
        const scripted = options.chatReply?.(body);
        if (scripted && typeof scripted !== 'string') {
          sse(response, { tool_calls: [{ index: 0, id: 'scripted-local-read', type: 'function', function: { name: scripted.name, arguments: JSON.stringify(scripted.args) } }] }, 'tool_calls');
          response.write('data: [DONE]\n\n'); response.end(); return;
        }
        if (trigger?.content?.includes('委派一个测试任务') && body.messages.at(-1)?.role !== 'tool') {
          taskRequest++;
          sse(response, { tool_calls: [{ index: 0, id: 'delegate-once', type: 'function', function: { name: 'dsh_task', arguments: JSON.stringify({ goal: '在任务工作区写 result.txt，内容 APP_ROUTER_WORKER_OK，再实际读取核验。', title: '应用主脑委派验收' }) } }] }, 'tool_calls');
          response.write('data: [DONE]\n\n'); response.end(); return;
        }
        if (options.holdFirstReply && requests.length === 1) await firstReply;
        if (response.destroyed) return;
        const answer = typeof scripted === 'string' ? scripted : trigger?.source === 'task' ? '收到执行器的真实完成回执。' : trigger?.content?.includes('委派一个测试任务') ? '已提交独立任务，等待真实回执。' : '你好，我在这里。';
        sse(response, { content: answer.slice(0, 3) }); await Promise.resolve(); sse(response, { content: answer.slice(3) });
      }
      sse(response, {}, 'stop'); response.write('data: [DONE]\n\n'); response.end();
    })().catch(error => { const actual = error && typeof error === 'object' && 'actual' in error ? error.actual : undefined;
      failures.push((error instanceof Error ? error.message : String(error)) + (actual === undefined ? '' : '\nActual local fixture value: ' + JSON.stringify(actual)));
      if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local provider did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`, host = vi.fn(async () => { throw new Error('No DSH Host available in this fixture'); }), workerRuns: BotDshRun[] = [];
  const worker = new class extends BotDshBrain {
    override async upgradeWorkerAccess(input: Parameters<BotDshBrain['upgradeWorkerAccess']>[0]) {
      if (options.upgradeWorkerAccess) {
        await options.upgradeWorkerAccess();
        return { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, workerAccess: 'full' as const };
      }
      return super.upgradeWorkerAccess(input);
    }
    override async run(input: BotDshRun): Promise<BotDshResult> {
      if (input.role !== 'worker') throw new Error('Ordinary conversation was incorrectly delegated to DSH');
      workerRuns.push(input); const file = path.join(input.cwd, 'result.txt'); await writeFile(file, 'APP_ROUTER_WORKER_OK');
      if (await readFile(file, 'utf8') !== 'APP_ROUTER_WORKER_OK') throw new Error('Worker did not verify its actual artifact');
      await reportWorkerOutcome(input, { state: options.workerWaitFirst && workerRuns.length === 1 ? 'waiting' : 'ready',
        summary: options.workerWaitFirst && workerRuns.length === 1 ? '保留原任务，等待用户后续指导。' : '已生成并读取核验 result.txt：APP_ROUTER_WORKER_OK', verification: ['实际读取 result.txt，与要求的字节内容一致。'] });
      return { text: '已生成并读取核验 result.txt：APP_ROUTER_WORKER_OK', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', inputContextCommitted: true };
    }
  }({ getHost: host });
  const app: BotAppBrain = new BotAppBrain({ root: path.join(root, 'app-brain'), reconcileTool: (call, signal) => service.reconcileToolReceipt(call, signal) }),
    router = new BotBrainRouter({ app, worker }), memory = new Memory(path.join(root, 'memory'));
  const preparation = { phase: 'starting-host', elapsedMs: 99000 };
  const service: BotService = new BotService({ root, brain: router, brainRuntime: 'worldlinebox', memory,
    retention: options.retention,
    runtimePreparation: () => preparation, model: () => ({ apiFormat: 'openai_chat', model: 'local-sse-fixture', baseUrl, apiKey: 'fixture-no-paid-request', maxTokens: 1024, contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW }),
    onEvent: event => { events.push(event); } });
  cleanups.push(async () => {
    release();
    try { await service.shutdown(); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, conversationId = snapshot.conversations[0]!.id;
  const send = async (content: string, requestId: string, targetConversationId = conversationId): Promise<BotMessage> => {
    const response = await service.handle({ type: 'message.send', conversationId: targetConversationId, content, requestId }); if (!response.ok || !response.messageId) throw new Error('Fixture message not accepted');
    return until(async () => {
      const state = (await service.handle({ type: 'state', conversationId: targetConversationId })).snapshot!;
      const message = state.messages.find(message => message.senderId !== 'user' && service.store.getEvent(message.eventId)?.sourceMessageRecordId === response.messageId && ['sent', 'failed', 'cancelled'].includes(message.status));
      if (message?.status === 'failed') throw new Error((message.error ?? 'App turn failed') + (failures.length ? '\nLocal fixture failures:\n' + failures.join('\n') : '')); return message;
    });
  };
  return { root, service, memory, app, worker, host, workerRuns, requests, failures, events, conversationId, preparation, release, send, observedTriggers,
    get captures() { return captures; }, get taskRequest() { return taskRequest; }, get summaries() { return summaries; } };
}
it('streams an ordinary chat through the real App engine while the DSH Host is unavailable', async () => {
  const f = await fixture(), message = await f.send('你好', 'hello-no-host');
  expect(message).toMatchObject({ status: 'sent', content: '你好，我在这里。', timing: { elapsedMs: expect.any(Number), firstTextMs: expect.any(Number) } });
  expect(f.events.some(event => event.type === 'text' && event.text.length > 0)).toBe(true);
  expect((await f.service.handle({ type: 'state' })).snapshot?.runtime.engine).toBe('worldlinebox');
  expect(f.host).not.toHaveBeenCalled(); expect(f.workerRuns).toEqual([]); expect(f.requests).toHaveLength(1); expect(f.failures).toEqual([]);
});
it('uses each activated persona in the next App model request without rewriting an already dispatched turn', async () => {
  const f = await fixture({ holdFirstReply: true });
  const companionId = 'builtin-dafeiyu', builtin = builtinBotPersonaTemplates(companionId);
  const listed = await f.service.handle({ type: 'companion.personas.list', companionId });
  expect(listed.ok).toBe(true); expect(listed.personas?.items).toHaveLength(5);
  expect(listed.personas?.items.every(item => !('prompt' in item))).toBe(true);
  const original = await f.service.handle({ type: 'companion.personas.get', companionId, id: listed.personas!.activeId });
  const accepted = await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '第一条普通聊天', requestId: 'persona-before-switch' });
  expect(accepted.ok).toBe(true);
  await until(async () => f.requests.length ? true : undefined);
  const dispatchedSystem = f.requests[0]!.messages.filter(message => message.role === 'system').map(message => text(message.content)).join('\n');
  expect(dispatchedSystem).toContain(original.persona!.prompt);
  const firstDocument = builtin.find(item => item.id === 'dafeiyu-original')!;
  expect((await f.service.handle({ type: 'companion.personas.activate', companionId, id: firstDocument.id })).ok).toBe(true);
  expect(f.requests[0]!.messages.filter(message => message.role === 'system').map(message => text(message.content)).join('\n')).toBe(dispatchedSystem);
  f.release();
  await until(async () => (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!.messages.some(message => message.senderId === companionId && message.status === 'sent') ? true : undefined);
  const assertNextPersona = async (prompt: string, requestId: string) => {
    const before = f.requests.length;
    const reply = await f.send('接着普通聊天', requestId);
    expect(reply.status).toBe('sent');
    const request = f.requests.slice(before).find(body => !!body.tools?.length)!;
    const systems = request.messages.filter(message => message.role === 'system');
    expect(systems).toHaveLength(1);
    const system = text(systems[0]!.content);
    expect(system.slice(system.indexOf('【你的身份与人格】'))).toBe(`【你的身份与人格】\n姓名：大肥鱼\n${prompt}`);
    expect(system).toContain('DSH是独立执行器');
  };
  await assertNextPersona(firstDocument.prompt, 'persona-first-document');
  for (const template of builtin.filter(item => item.id !== 'default' && item.id !== firstDocument.id)) {
    expect((await f.service.handle({ type: 'companion.personas.activate', companionId, id: template.id })).ok).toBe(true);
    await assertNextPersona(template.prompt, `persona-${template.id}`);
  }
  const custom = await f.service.handle({ type: 'companion.personas.save', companionId, name: '星海朋友', prompt: 'PERSONA_CUSTOM_A：以轻快的语气相处。', activate: true });
  expect(custom.persona?.name).toBe('星海朋友');
  await assertNextPersona(custom.persona!.prompt, 'persona-new-custom');
  const renamed = await f.service.handle({ type: 'companion.personas.save', companionId, id: custom.persona!.id, name: '星海老友', prompt: 'PERSONA_CUSTOM_B：以简洁沉稳的语气相处。' });
  expect(renamed.persona).toMatchObject({ id: custom.persona!.id, name: '星海老友' });
  expect(renamed.personas?.activeId).toBe(custom.persona!.id);
  await assertNextPersona(renamed.persona!.prompt, 'persona-edited-active');
  const restored = await f.service.handle({ type: 'companion.personas.restore', companionId });
  expect(restored.personas?.activeId).toBe('default');
  expect(restored.personas?.items.some(item => item.id === custom.persona!.id && item.name === '星海老友')).toBe(true);
  await assertNextPersona(builtin[0]!.prompt, 'persona-restored-default');
  expect(f.host).not.toHaveBeenCalled(); expect(f.workerRuns).toEqual([]); expect(f.failures).toEqual([]);
}, 25000);
it('retires a cancelled answer waiting for DSH access and lets the same companion chat when the shared runtime becomes ready', async () => {
  let release!: () => void, entered!: () => void, questionId = '', taskId = '', answerRequests = 0;
  const ready = new Promise<void>(resolve => { release = resolve; }), upgrading = new Promise<void>(resolve => { entered = resolve; });
  const upgrade = vi.fn(async () => { entered(); await ready; });
  const f = await fixture({ upgradeWorkerAccess: upgrade, chatReply: body => {
    const last = body.messages.at(-1);
    const trigger = last?.role === 'user' ? (JSON.parse(String(last.content)) as { trigger?: { source?: string; content?: string } }).trigger : undefined;
    if (trigger?.source === 'task' && trigger.content?.includes('等待回答') && questionId) {
      answerRequests++;
      return { name: 'dsh_task_control', args: { operation: 'answer', taskId, questionId, answers: [{ id: 'next_step', selected: ['先不做这件事'] }] } };
    }
    return '你好，继续聊吧。';
  } });
  cleanups.push(async () => { release(); });
  const original = await f.send('你好', 'original-task-source'), source = f.service.store.getEvent(original.eventId)!;
  taskId = 'startup-question-task';
  const task = f.service.store.createTask({ id: taskId, conversationId: f.conversationId, companionId: source.companionId,
    sourceEventId: source.id, goal: '恢复原任务', extra: { nativeAttempted: true, userPaused: true } });
  const callId = 'original-native-question';
  questionId = 'question-' + createHash('sha256').update(`work-${taskId}:${callId}`).digest('hex').slice(0, 48);
  const runtime = new BotTaskRuntime(f.service.store);
  runtime.question(task, { callId, questionId, questions: [{ id: 'next_step', question: '如何继续？', options: [{ label: '先不做这件事', description: '保留原记录' }] }] });
  // The original native worker is unavailable during startup; its durable
  // question and saved paused state remain, without launching a second worker.
  f.service.store.updateTask(taskId, { status: 'paused' });
  await upgrading;
  const reply = await until(async () => {
    const messages = (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!.messages;
    return messages.find(message => message.senderId === source.companionId && message.status === 'running' && message.id !== original.id);
  });
  expect(upgrade).toHaveBeenCalledTimes(1);
  await f.service.handle({ type: 'reply.cancel', messageId: reply.id });
  expect(f.service.store.getEvent(reply.eventId)?.status).toBe('cancelled');
  // Reproduce the old call finally reaching the controller after cancellation.
  // It must not answer or restart an ended task.
  f.service.store.updateTask(taskId, { status: 'cancelled' });
  f.preparation.phase = 'ready'; release();
  const recovered = await f.send('你好', 'after-delayed-host-ready');
  expect(recovered).toMatchObject({ status: 'sent', content: '你好，继续聊吧。' });
  await until(async () => f.service.store.pendingCancelledNativeAdmissions(source.laneId).length === 0 ? true : undefined);
  const journal = new BotAppBrainStore(path.join(f.root, 'app-brain', 'app-brain.sqlite'));
  try { expect(journal.get(reply.eventId)?.state).toBe('cancelled'); }
  finally { journal.close(); }
  expect(f.service.store.getTask(taskId)?.status).toBe('cancelled');
  expect(f.service.store.taskTransaction(sql => sql.prepare('SELECT 1 FROM bot_task_controls WHERE task_id=?').get(taskId))).toBeUndefined();
  expect(answerRequests).toBe(1); expect(upgrade).toHaveBeenCalledTimes(1); expect(f.workerRuns).toEqual([]); expect(f.host).not.toHaveBeenCalled();
}, 25000);
it('extracts a post-reply memory through App and retains source receipts without invoking DSH', async () => {
  const f = await fixture(), message = await f.send('从今天起，晚上喝麦茶，白天仍喝咖啡。', 'capture-app-only');
  await until(async () => f.memory.records.length ? true : undefined);
  expect(f.captures).toBe(1); expect(f.memory.records).toHaveLength(1);
  expect(f.memory.records[0]?.[0]).toMatchObject({ conversationId: f.conversationId });
  expect(f.memory.records[0]?.[1]).toMatchObject({ sourceRootEventId: message.eventId, sourceMessageIds: expect.arrayContaining([message.id]), content: expect.stringContaining('晚上喝麦茶') });
  expect(f.host).not.toHaveBeenCalled(); expect(f.workerRuns).toEqual([]); expect(f.failures).toEqual([]);
}, 20000);
it('dispatches only an explicit dsh_task to the worker and consumes its actual task and artifact receipts', async () => {
  const f = await fixture(); await f.send('请委派一个测试任务，生成并核验结果文件。', 'actual-worker-delegation');
  const task = await until(async () => { const task = f.service.store.listTasks(f.conversationId)[0]; return task?.status === 'succeeded' ? task : undefined; });
  await until(async () => (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!.messages.some(message => message.content === '收到执行器的真实完成回执。') ? true : undefined);
  expect(f.taskRequest).toBe(1); expect(f.workerRuns).toHaveLength(1); expect(f.service.store.listTasks(f.conversationId)).toHaveLength(1);
  expect(task).toMatchObject({ sessionId: BotDshBrain.sessionId('worker-' + task.id), summary: expect.stringContaining('APP_ROUTER_WORKER_OK') });
  expect(await readFile(path.join(f.workerRuns[0]!.cwd, 'result.txt'), 'utf8')).toBe('APP_ROUTER_WORKER_OK');
  const receipts = f.service.store.taskTransaction(sql => sql.prepare("SELECT value FROM bot_metadata WHERE key LIKE 'effect:%'").all()) as Array<{ value: string }>;
  expect(receipts.some(row => JSON.stringify(JSON.parse(row.value)).includes(task.id))).toBe(true);
  expect(f.host).not.toHaveBeenCalled(); expect(f.failures).toEqual([]);
}, 20000);
it('delivers a host-bound chat followup to the existing worker without rerouting it through the main model', async () => {
  const f = await fixture({ workerWaitFirst: true }); await f.send('委派一个测试任务。', 'followup-original');
  const work = await until(async () => { const work = f.service.store.listTasks(f.conversationId)[0]; return work?.status === 'paused' && work.extra.turnOutcome ? work : undefined; });
  const sent = await f.service.handle({ type: 'message.send', conversationId: f.conversationId, requestId: 'bound-guidance',
    content: '保留原目标，请核验并提交完成报告。', replyToTaskId: work.id });
  const first = sent.messageId!;
  expect((await f.service.handle({ type: 'message.send', conversationId: f.conversationId, requestId: 'bound-guidance',
    content: '保留原目标，请核验并提交完成报告。', replyToTaskId: work.id })).messageId).toBe(first);
  await until(async () => f.service.store.getTask(work.id)?.status === 'succeeded' ? true : undefined);
  expect(f.service.store.listTasks(f.conversationId)).toHaveLength(1); expect(f.workerRuns).toHaveLength(2);
  expect(f.workerRuns[1]).toMatchObject({ laneId: f.workerRuns[0]!.laneId, eventId: f.workerRuns[0]!.eventId,
    taskContinuation: { text: '保留原目标，请核验并提交完成报告。' } });
  const source = f.service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').get(first)) as { id: string };
  expect(f.observedTriggers.some(trigger => trigger.eventId === source.id)).toBe(false);
  expect(f.service.store.taskTransaction(sql => sql.prepare('SELECT state FROM bot_task_followups WHERE task_id=? AND event_id=?').get(work.id, source.id))).toMatchObject({ state: 'delivered' });
  const receipt = (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!.messages.find(message => message.id === first)?.taskFollowup;
  expect(receipt).toMatchObject({ taskId: work.id, state: 'delivered', title: '应用主脑委派验收' });
  expect(f.failures).toEqual([]);
}, 20000);

it('keeps App chat independent while the DSH Host starts, fails and later becomes ready', async () => {
  const f = await fixture({ holdFirstReply: true }), reply = f.send('你好', 'app-progress');
  const waiting = await until(async () => {
    const message = (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!.messages.find(message => message.progress?.phase === 'waiting-model');
    return f.requests.length && message ? message : undefined;
  });
  expect(waiting.progress?.phase).toBe('waiting-model');
  for (const phase of ['starting-host', 'failed', 'ready']) {
    f.preparation.phase = phase; f.service.runtimePreparationChanged();
    const state = (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!;
    expect(state.messages.some(message => message.progress?.phase === 'waiting-runtime' || message.progress?.phase === 'retrying')).toBe(false);
    expect(state.messages.find(message => message.id === waiting.id)?.progress?.phase).toBe('waiting-model');
  }
  f.release(); expect((await reply).status).toBe('sent'); expect(f.host).not.toHaveBeenCalled(); expect(f.workerRuns).toEqual([]);
  expect(await f.send('你好', 'app-after-host-ready')).toMatchObject({ status: 'sent', content: '你好，我在这里。' });
  expect(f.host).not.toHaveBeenCalled(); expect(f.workerRuns).toEqual([]); expect(f.requests).toHaveLength(2); expect(f.failures).toEqual([]);
});

it('drains 60 mixed-source queued events across bounded app summaries and retention handoffs without DSH', async () => {
  const f = await fixture({ retention: { maxTurns: 24 } });
  const originalHandoff = f.app.handoff.bind(f.app), summariesBeforeHandoff: number[] = [];
  const handoff = vi.spyOn(f.app, 'handoff').mockImplementation(async input => { summariesBeforeHandoff.push(f.summaries); return originalHandoff(input); });
  const initial = (await f.service.handle({ type: 'state' })).snapshot!, targetId = initial.conversations[0]!.memberIds.find(id => id !== 'user')!;
  const peerId = initial.companions.find(companion => companion.id !== targetId)!.id;
  const created = await f.service.handle({ type: 'conversation.create', kind: 'world', title: '持续事件队列验收', memberIds: [targetId, peerId], participationMode: 'mentions' });
  expect(created.ok).toBe(true); const conversationId = created.conversationId!;
  const sources: BotSource[] = ['user', 'companion', 'group', 'world', 'task', 'gateway'], expected: BotEvent[] = [];
  // These are trusted internal ingress records. This verifies source scheduling,
  // not a real QQ/WeChat gateway transport or a real completed worker task.
  for (let index = 0; index < 60; index++) {
    const source = sources[index % sources.length]!;
    const senderId = source === 'companion' ? peerId : source === 'world' ? 'world' : source === 'task' ? 'task-service' : 'user';
    const content = `队列第${index}条、来源${source}：` + '当前只讨论一个小角落，接续当前事件，不替人执行、不重复旧消息。'.repeat(30);
    const event = f.service.store.enqueue({ conversationId, source, senderId, sourceInstanceId: 'local-mixed-source-fixture', sourceMessageId: `continuous-${index}`,
      recipientIds: [targetId], correlationId: `continuous-root-${index}`, content }).events[0];
    expect(event).toBeDefined(); expected.push(event!);
  }
  await until(async () => {
    const events = expected.map(event => f.service.store.getEvent(event.id)!);
    const failure = events.find(event => ['failed', 'cancelled'].includes(event.status));
    if (failure) throw new Error(`Continuous event ${failure.sourceMessageId} ended ${failure.status}: ${failure.error ?? ''}`);
    return events.every(event => event.status === 'done') ? true : undefined;
  }, 45000);
  const observed = f.observedTriggers.filter(trigger => expected.some(event => event.id === trigger.eventId));
  expect(observed).toHaveLength(60); expect(new Set(observed.map(trigger => trigger.eventId)).size).toBe(60);
  expect(new Set(observed.map(trigger => trigger.source))).toEqual(new Set(sources));
  for (const event of expected) {
    expect(observed.find(trigger => trigger.eventId === event.id)).toMatchObject({ content: event.content, source: event.source });
    expect(f.service.store.getMessage(event.replyMessageId)?.status).toBe('sent');
  }
  expect(f.service.store.getLane(expected[0]!.laneId)!.epoch).toBeGreaterThanOrEqual(3);
  expect(handoff).toHaveBeenCalledTimes(2); expect(summariesBeforeHandoff[0]).toBeGreaterThan(0);
  expect(f.summaries).toBeGreaterThanOrEqual(2);
  expect(f.host).not.toHaveBeenCalled(); expect(f.workerRuns).toEqual([]); expect(f.failures).toEqual([]);
}, 60000);

it('reads exact Unicode source and handoff pages in their own audience and refuses a different conversation', async () => {
  const privateSource = 'PRIVATE_SOURCE_A_ONLY：' + '🐳只整理这一个角落。'.repeat(90);
  const privateSummary = 'PRIVATE_HANDOFF_A_ONLY：' + '🐳这是受众A的原始交接摘要，不能流入其他聊天。'.repeat(100);
  let plan: ((body: ProviderBody) => ScriptedChat) | undefined;
  const f = await fixture({ retention: { maxTurns: 1 }, summaryText: privateSummary, chatReply: body => plan?.(body) });
  const originalReply = await f.send(privateSource, 'private-source-a');
  const originalEvent = f.service.store.getEvent(originalReply.eventId)!;
  await f.send('延续当前聊天，保持资料归属。', 'handoff-a');
  const lastTool = (body: ProviderBody): Record<string, unknown> => JSON.parse(text(body.messages.at(-1)?.content)) as Record<string, unknown>;
  let step = 0, ownHandoffCallId = '', handoffWasView = false, sourceWasView = false, sourceCallId = '';
  let reading: 'source' | 'source-page' | 'handoff' | 'handoff-page' = 'source';
  let handoffText = '', handoffPages = 0;
  const expectedSourcePage = Array.from(privateSource).slice(2, 45).join('');
  const expectedHandoffPage = Array.from(privateSummary).slice(750, 1550).join('');
  plan = body => {
    if (step++ === 0) return { name: 'chat_read_message', args: { messageId: originalEvent.sourceMessageRecordId, offset: 2, limit: 43 } };
    const result = lastTool(body);
    if (reading === 'source') {
      if (result.kind === 'durable_tool_result_view') {
        sourceWasView = true; sourceCallId = body.messages.at(-1)!.tool_call_id!; reading = 'source-page';
        expect(result).toMatchObject({ callId: sourceCallId, read: { tool: 'agent_read_tool_result', callId: sourceCallId } });
        return { name: 'agent_read_tool_result', args: { callId: sourceCallId, jsonPath: '/text', offset: 0, limit: 4096 } };
      }
      expect(result).toMatchObject({ messageId: originalEvent.sourceMessageRecordId, offset: 2, text: expectedSourcePage, nextOffset: 45 });
      reading = 'handoff'; return { name: 'context_handoff_read', args: { section: 'summary', offset: 750 } };
    }
    if (reading === 'source-page') {
      expect(result).toMatchObject({ kind: 'tool_result_page', callId: sourceCallId, jsonPath: '/text', offset: 0, total: expectedSourcePage.length, value: expectedSourcePage });
      reading = 'handoff'; return { name: 'context_handoff_read', args: { section: 'summary', offset: 750 } };
    }
    if (reading === 'handoff') {
      ownHandoffCallId = body.messages.at(-1)!.tool_call_id!; expect(ownHandoffCallId).toBeTruthy();
      if (result.kind === 'durable_tool_result_view') {
        handoffWasView = true; reading = 'handoff-page';
        expect(result).toMatchObject({ callId: ownHandoffCallId, read: { tool: 'agent_read_tool_result', callId: ownHandoffCallId } });
        expect(result.view).toMatchObject({ available: true, section: 'summary', offset: 750, totalChars: Array.from(privateSummary).length });
        return { name: 'agent_read_tool_result', args: { callId: ownHandoffCallId, jsonPath: '/text', offset: 0, limit: 4096 } };
      }
      expect(result).toMatchObject({ available: true, section: 'summary', offset: 750, totalChars: Array.from(privateSummary).length, text: expectedHandoffPage, nextOffset: 1550 });
    } else {
      expect(result).toMatchObject({ kind: 'tool_result_page', callId: ownHandoffCallId, jsonPath: '/text', offset: handoffText.length,
        total: expectedHandoffPage.length });
      expect(typeof result.value).toBe('string'); expect(String(result.value).length).toBeGreaterThan(0);
      expect(result.value).toBe(expectedHandoffPage.slice(handoffText.length, handoffText.length + String(result.value).length));
      handoffText += String(result.value); handoffPages++;
      if (typeof result.nextOffset === 'number') {
        expect(result.nextOffset).toBe(handoffText.length);
        return { name: 'agent_read_tool_result', args: { callId: ownHandoffCallId, jsonPath: '/text', offset: result.nextOffset, limit: 4096 } };
      }
      expect(handoffText).toBe(expectedHandoffPage);
    }
    return '已核对当前聊天的原话和交接。';
  };
  expect((await f.send('读取当前聊天已分享的原话与交接摘要。', 'read-own-a')).status).toBe('sent');
  expect(step).toBe(3 + Number(sourceWasView) + handoffPages); expect(handoffWasView).toBe(handoffPages > 0);
  const targetId = f.service.store.getConversation(f.conversationId)!.memberIds.find(id => id !== 'user')!;
  const other = await f.service.handle({ type: 'conversation.create', kind: 'group', title: '另一个受众', memberIds: [targetId], participationMode: 'all' });
  expect(other.ok).toBe(true); step = 0;
  plan = body => {
    const serialized = JSON.stringify(body.messages); expect(serialized).not.toContain('PRIVATE_SOURCE_A_ONLY'); expect(serialized).not.toContain('PRIVATE_HANDOFF_A_ONLY');
    if (step++ === 0) return { name: 'chat_read_message', args: { messageId: originalEvent.sourceMessageRecordId, offset: 0, limit: 100 } };
    if (step === 2) { expect(typeof lastTool(body).error).toBe('string'); return { name: 'context_handoff_read', args: { section: 'summary', offset: 0 } }; }
    if (step === 3) { expect(lastTool(body)).toMatchObject({ available: false });
      return { name: 'agent_read_tool_result', args: { callId: ownHandoffCallId, jsonPath: '/text', offset: 0, limit: 4096 } }; }
    expect(lastTool(body)).toEqual({ error: '当前上下文没有可读取的已确认工具回执。' }); return '当前聊天不能读取另一受众的资料。';
  };
  expect((await f.send('检查这个编号是否属于当前聊天。', 'refuse-private-a', other.conversationId!)).status).toBe('sent');
  expect(step).toBe(4); expect(f.host).not.toHaveBeenCalled(); expect(f.workerRuns).toEqual([]); expect(f.failures).toEqual([]);
}, 30000);
