import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BotService, type BotServiceOptions } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain, type BotDshResult, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import type { BotEvent as UiEvent, BotMessage } from '../../src/shared/companion-bot';
import type { BotEvent, BotSource } from '../../src/main/companion-bot/types';

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
async function fixture(options: { holdFirstReply?: boolean; retention?: BotServiceOptions['retention']; summaryText?: string; chatReply?(body: ProviderBody): ScriptedChat | undefined } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-app-service-'));
  const requests: ProviderBody[] = [], failures: string[] = [], events: UiEvent[] = [];
  let release!: () => void;
  const firstReply = new Promise<void>(resolve => { release = resolve; });
  let captures = 0, taskRequest = 0, summaries = 0;
  const observedTriggers: Array<{ eventId: string; content: string; source: string }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes) as ProviderBody; requests.push(body);
      if (Buffer.byteLength(bytes, 'utf8') + 256 + (body.max_tokens ?? 0) > 32768) throw new Error('The local provider received a request outside its 32k budget');
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
    override async run(input: BotDshRun): Promise<BotDshResult> {
      if (input.role !== 'worker') throw new Error('Ordinary conversation was incorrectly delegated to DSH');
      workerRuns.push(input); const file = path.join(input.cwd, 'result.txt'); await writeFile(file, 'APP_ROUTER_WORKER_OK');
      if (await readFile(file, 'utf8') !== 'APP_ROUTER_WORKER_OK') throw new Error('Worker did not verify its actual artifact');
      return { text: '已生成并读取核验 result.txt：APP_ROUTER_WORKER_OK', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', inputContextCommitted: true };
    }
  }({ getHost: host });
  const app = new BotAppBrain({ root: path.join(root, 'app-brain') }), router = new BotBrainRouter({ app, worker }), memory = new Memory(path.join(root, 'memory'));
  const preparation = { phase: 'starting-host', elapsedMs: 99000 };
  const service = new BotService({ root, brain: router, brainRuntime: 'worldlinebox', memory,
    retention: options.retention,
    runtimePreparation: () => preparation, model: () => ({ apiFormat: 'openai_chat', model: 'local-sse-fixture', baseUrl, apiKey: 'fixture-no-paid-request', maxTokens: 1024, contextWindow: 32768 }),
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
it('keeps App waiting on its model instead of presenting an unrelated native Host startup phase', async () => {
  const f = await fixture({ holdFirstReply: true }), reply = f.send('你好', 'app-progress');
  const waiting = await until(async () => {
    const message = (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!.messages.find(message => message.progress?.phase === 'waiting-model');
    return f.requests.length && message ? message : undefined;
  });
  expect(waiting.progress?.phase).toBe('waiting-model'); f.service.runtimePreparationChanged();
  f.preparation.phase = 'failed'; f.service.runtimePreparationChanged();
  const state = (await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!;
  expect(state.messages.some(message => message.progress?.phase === 'waiting-runtime')).toBe(false);
  expect(state.messages.find(message => message.id === waiting.id)?.progress?.phase).toBe('waiting-model');
  f.release(); expect((await reply).status).toBe('sent'); expect(f.host).not.toHaveBeenCalled(); expect(f.workerRuns).toEqual([]);
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
