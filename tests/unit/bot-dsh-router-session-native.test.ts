import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain, BotDshAbortAcknowledgedError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { NativeHostEvent } from '../../src/main/dsh/native-host-client';
import { createBotNativeHost } from '../fixtures/bot-native-host';

type WireMessage = { role: string; content: string | Array<{ text?: string }>; tool_calls?: Array<{ function: { name: string; arguments: string } }> };
const bodyText = (message: WireMessage) => typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => block.text ?? '').join('\n');

/** A real installed DSH Host executes native filesystem, delivery, subagents,
 * persistence and tool callbacks. Only the model wire is a local scripted peer. */
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('uses fresh native turns, real file deliveries and workspace-scoped cross-session collaboration', async () => {
  const requests: Array<{ scenario: string; messages: WireMessage[] }> = [], errors: unknown[] = [], callbacks: string[] = [];
  const counts = new Map<string, number>(); let firstSession = '', childSession = '';
  const reply = (response: ServerResponse, value: string | { name: string; args: object }) => {
    const delta = typeof value === 'string' ? { content: value } : { tool_calls: [{ index: 0, id: 'call_' + Math.random().toString(36).slice(2), type: 'function', function: { name: value.name, arguments: JSON.stringify(value.args) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: typeof value === 'string' ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 200, completion_tokens: 30 } }) + '\n\ndata: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      if (request.url === '/bot/tool') {
        callbacks.push(input.name);
        expect(['memory_recall', 'chat_ask_user']).toContain(input.name);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true,
          result: input.name === 'chat_ask_user' ? { text: '用户确认继续' } : { memories: ['Native VCP callback evidence'] } })); return;
      }
      const messages = input.messages as WireMessage[], userTexts = messages.filter(message => message.role === 'user').map(bodyText).join('\n');
      const scenario = userTexts.includes('SCENARIO=audience-child') ? 'audience-child' : userTexts.includes('SCENARIO=audience') ? 'audience' : userTexts.includes('SCENARIO=cancel') ? 'cancel' : userTexts.includes('SCENARIO=resume') ? 'resume' : userTexts.includes('SCENARIO=child') ? 'child'
        : userTexts.includes('SCENARIO=cooperate') ? 'cooperate' : userTexts.includes('SCENARIO=foreign') ? 'foreign' : 'delivery';
      if (scenario === 'cooperate') expect(userTexts).not.toContain('SCENARIO=delivery');
      requests.push({ scenario, messages });
      const step = counts.get(scenario) ?? 0; counts.set(scenario, step + 1);
      if (scenario === 'cancel') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return; }
      if (step > 16) throw Error('Unexpected native continuation: ' + scenario);
      const toolResults = messages.filter(message => message.role === 'tool').map(bodyText);
      const serialized = toolResults.join('\n');
      if (scenario === 'audience-child') {
        if (step > 0) expect(serialized).toContain('outside the current conversation audience');
        reply(response, step === 0 ? { name: 'sessions_read', args: { sessionId: firstSession } } : 'CHILD_AUDIENCE_ISOLATED');
      } else if (scenario === 'audience') {
        if (step === 1) { expect(serialized).toContain(BotDshBrain.sessionId('turn-audience')); expect(serialized).not.toContain(firstSession); expect(serialized).not.toContain('FINAL_NATIVE_DELIVERY'); }
        if (step === 2 || step === 3) expect(serialized).toContain('outside the current conversation audience');
        const plan = [{ name: 'sessions_list', args: {} }, { name: 'sessions_read', args: { sessionId: firstSession } },
          { name: 'sessions_send', args: { sessionId: firstSession, message: 'A group cannot wake private history' } },
          { name: 'sessions_spawn', args: { prompt: 'SCENARIO=audience-child Verify private Session history is refused.' } }];
        reply(response, plan[step] ?? 'GROUP_AUDIENCE_ISOLATED');
      } else if (scenario === 'delivery') {
        const plan = [
          { name: 'memory_recall', args: { query: '上次约定' } },
          { name: 'write', args: { file_path: 'report.txt', content: 'COUNT=2\n' } },
          { name: 'edit', args: { file_path: 'report.txt', old_string: 'COUNT=2', new_string: 'COUNT=3' } },
          { name: 'read', args: { file_path: 'report.txt' } },
          { name: 'present', args: { files: [{ path: 'report.txt', description: '真实 DSH 交付' }] } },
        ];
        reply(response, plan[step] ?? '  FINAL_NATIVE_DELIVERY\n');
      } else if (scenario === 'child') {
        expect(messages.filter(message => message.role === 'system').map(bodyText).join('\n')).toContain('COMPANION_PERSONA');
        reply(response, step === 0 ? { name: 'write', args: { file_path: 'child.txt', content: 'CHILD_REAL_FILE' } }
          : step === 1 ? { name: 'present', args: { files: [{ path: 'child.txt' }] } } : 'CHILD_DONE');
      } else if (scenario === 'resume') reply(response, step === 0 ? { name: 'write', args: { file_path: 'resumed.txt', content: 'RESUMED_REAL_FILE' } } : 'RESUMED_DONE');
      else if (scenario === 'foreign') reply(response, step === 0 ? { name: 'sessions_read', args: { sessionId: firstSession } } : 'FOREIGN_SCOPE_REJECTED');
      else {
        if (step === 1) { expect(serialized).toContain(firstSession); expect(serialized).toContain('SCENARIO=delivery'); expect(serialized).toContain('FINAL_NATIVE_DELIVERY'); expect(serialized).toContain('firstPromptPreview'); }
        if (step === 4) {
          const matches = serialized.match(/"sessionId"\s*:\s*"([A-Za-z0-9_-]+)"/g) ?? [];
          childSession = matches.map(value => JSON.parse('{' + value + '}').sessionId).findLast(value => value !== firstSession && !value.startsWith('wlb-bot-')) ?? '';
          expect(childSession).not.toBe('');
        }
        const plan = [
          { name: 'sessions_list', args: {} },
          { name: 'sessions_read', args: { sessionId: firstSession } },
          { name: 'ask_user_question', args: { questions: [{ id: 'continue', question: '是否继续原生子会话测试？', options: [{ label: '继续', description: '执行真实文件任务' }] }] } },
          { name: 'sessions_spawn', args: { prompt: 'SCENARIO=child Create the child file then report.', title: '通用文件子任务' } },
          { name: 'sessions_wait', args: { sessionId: childSession, timeoutMs: 30000 } },
          { name: 'sessions_send', args: { sessionId: firstSession, message: 'SCENARIO=resume Write resumed.txt in this workspace, then finish.' } },
          { name: 'sessions_wait', args: { sessionId: firstSession, timeoutMs: 30000 } },
        ];
        reply(response, plan[step] ?? 'DONE_COOPERATION');
      }
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let brain: BotDshBrain | undefined;
  const cwd = path.join(native.root, 'companion'), trace: NativeHostEvent[] = [];
  const input = (scenario: string, directory = cwd): BotDshRun => ({ laneId: 'turn-' + scenario, eventId: 'event-' + scenario, role: 'worker', workerAccess: 'full', cwd: directory,
    audience: scenario === 'audience' ? { conversationId: 'group-fixture', kind: 'group', allowedConversationIds: ['group-fixture'] } : { conversationId: 'direct-fixture', kind: 'direct', allowedConversationIds: ['direct-fixture', 'group-fixture'] },
    workspaceTitle: '测试伙伴', sessionTitle: scenario, system: 'COMPANION_PERSONA. Complete the requested native task. Use present for files.', prompt: 'SCENARIO=' + scenario,
    tools: [], workerTools: [
      { name: 'memory_recall', description: 'Recall VCP memory', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'chat_ask_user', description: 'Ask the user in the chat frontend', parameters: { type: 'object', properties: { question: { type: 'string' } } } },
    ], callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'f'.repeat(64) },
    model: { apiFormat: 'openai_chat', model: 'local-native-router-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', contextWindow: 32768, maxTokens: 2048 },
    onEvent: event => trace.push(event) });
  try {
    let client = await native.instances.ensureHost(native.instance.id);
    brain = new BotDshBrain({ getHost: async () => ({ client }) });
    await mkdir(cwd, { recursive: true });
    const delivered = await brain.run(input('delivery')); firstSession = delivered.sessionId;
    expect(errors).toEqual([]); expect(delivered).toMatchObject({ status: 'succeeded', text: '  FINAL_NATIVE_DELIVERY\n' });
    expect(await readFile(path.join(cwd, 'report.txt'), 'utf8')).toBe('COUNT=3\n');
    const delivery = trace.find(event => event.type === 'artifacts');
    expect(delivery).toMatchObject({ nativeSessionId: firstSession, artifacts: [{ path: path.join(cwd, 'report.txt'), description: '真实 DSH 交付' }] });
    const beforeReplay = requests.length; expect(await brain.run(input('delivery'))).toMatchObject(delivered); expect(requests).toHaveLength(beforeReplay);
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    expect(await brain.run(input('delivery'))).toMatchObject(delivered); expect(requests).toHaveLength(beforeReplay);
    await brain.archive('turn-delivery');
    const cooperation = await brain.run(input('cooperate'));
    expect(errors).toEqual([]); expect(cooperation).toMatchObject({ status: 'succeeded', text: 'DONE_COOPERATION' });
    expect(await readFile(path.join(cwd, 'child.txt'), 'utf8')).toBe('CHILD_REAL_FILE');
    expect(await readFile(path.join(cwd, 'resumed.txt'), 'utf8')).toBe('RESUMED_REAL_FILE');
    expect(callbacks).toEqual(['memory_recall', 'chat_ask_user']);
    expect(trace.some(event => event.type === 'artifacts' && event.artifacts?.some(file => file.path === path.join(cwd, 'child.txt')))).toBe(true);
    const group = await brain.run(input('audience')); expect(group.text).toBe('GROUP_AUDIENCE_ISOLATED'); expect(errors).toEqual([]);
    expect(counts.get('audience-child')).toBeGreaterThanOrEqual(2);
    const foreign = await brain.run(input('foreign', path.join(native.root, 'other-companion')));
    expect(foreign.status).toBe('succeeded');
    const controller = new AbortController();
    const pendingCancel = brain.run({ ...input('cancel'), signal: controller.signal }).catch(error => error);
    const cancellationDeadline = Date.now() + 10000;
    while (!counts.has('cancel')) { if (Date.now() > cancellationDeadline) throw Error('Cancellation fixture never reached native model'); await new Promise(resolve => setTimeout(resolve, 10)); }
    controller.abort(new Error('User stopped only this native turn'));
    const cancelled = await pendingCancel; expect(cancelled).toBeInstanceOf(BotDshAbortAcknowledgedError); expect(cancelled.result.status).toBe('cancelled');
    expect(requests.filter(value => value.scenario === 'foreign').at(-1)?.messages.some(message => message.role === 'tool' && bodyText(message).includes('outside the companion workspace'))).toBe(true);
  } catch (error) {
    throw new Error(String(error) + '; native scenarios=' + JSON.stringify(Object.fromEntries(counts)) + '; wire errors=' + errors.map(value => String(value)).join('|') + '; tools=' + JSON.stringify(trace.filter(event => event.type === 'tool_result').slice(-3)) + '; trace=' + JSON.stringify(trace.slice(-6)), { cause: error });
  } finally { await brain?.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 180000);
