import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

// Explicit local Host contract test: real installed DSH CLI/Node/persistence
// and maintained provider serializer, deterministic local protocol fixture.
// This is not an online model quality test.
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('runs isolated native brain lanes, real tool continuation and durable duplicate replay', async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
  let heldResolve!: () => void;
  let writeDispatches = 0;
  const held = new Promise<void>(resolve => { heldResolve = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/bot/tool') {
      expect(request.headers.authorization).toBe('Bearer ' + 'f'.repeat(64));
      if (data.name === 'worker_effect_start' || data.name === 'worker_effect_commit') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: data.name === 'worker_effect_start' ? { state: 'admitted', callId: data.callId } : { recorded: true } })); return;
      }
      expect(data.name).toBe('memory_search'); expect(data.args).toEqual({ query: 'frozen fact' });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ text: 'memory result', found: true })); return;
    }
    requests.push(data);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const used = data.messages.some((message: { role: string }) => message.role === 'tool');
    const content = data.messages.map((message: { content?: string }) => message.content ?? '').join('\n');
    if (content.includes('hold-until-recovery') && !content.includes('宿主恢复事件') && (!content.includes('hold-after-tool') || used)) {
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'held' }, finish_reason: null }] }) + '\n\n');
      heldResolve(); return;
    }
    const write = data.messages.some((message: { content?: string }) => typeof message.content === 'string' && message.content.includes('write-native-artifact'));
    const useTool = write || data.messages.some((message: { content?: string }) => typeof message.content === 'string' && message.content.includes('use-memory'));
    const delta = useTool && !used ? { tool_calls: [{ index: 0, id: 'native-tool-' + randomUUID(), type: 'function', function: {
      name: write ? 'write' : 'memory_search', arguments: JSON.stringify(write ? { file_path: 'native-result.txt', content: 'native worker proof' } : { query: 'frozen fact' }) } }] }
      : { content: 'pong-from-native-loop' };
    if (write && !used) writeDispatches++;
    response.write('data: ' + JSON.stringify({ id: 'fixture-' + randomUUID(), choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: useTool && !used ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const callbacks = { url: baseUrl + '/bot/tool', token: 'f'.repeat(64) };
  const model = { apiFormat: 'openai_chat' as const, model: 'protocol-fixture', apiKey: 'not-a-provider-secret', baseUrl };
  const tools = [{ name: 'memory_search', description: 'Read a trusted test memory.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }];
  try {
    const cwd = path.join(native.root, 'brain'); await mkdir(cwd);
    const a = { laneId: 'lane-a', eventId: 'event-a', cwd: path.join(cwd, 'a'), system: 'Private identity ALPHA.', prompt: 'use-memory', model, tools, callback: callbacks };
    const b = { ...a, laneId: 'lane-b', eventId: 'event-b', cwd: path.join(cwd, 'b'), system: 'Private identity BETA.', prompt: 'reply directly' };
    const first = await Promise.all([brain.run(a), brain.run(b)]);
    expect(first.map(result => result.text)).toEqual(['pong-from-native-loop', 'pong-from-native-loop']);
    expect(first[0]!.sessionId).not.toBe(first[1]!.sessionId);
    const before = requests.length;
    const duplicate = await brain.run(a); expect(duplicate).toEqual(first[0]); expect(requests).toHaveLength(before);
    expect(requests.some(request => request.messages.some(message => message.role === 'tool'))).toBe(true);
    for (const request of requests) {
      expect(request.tools?.map(tool => tool.function.name)).toEqual(['memory_search']);
      const systems = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
      expect(systems.includes('ALPHA') && systems.includes('BETA')).toBe(false);
    }
    const beforeWorker = requests.length;
    const worker = await brain.run({ ...a, laneId: 'worker-ticket-stable-id', eventId: 'worker-event-stable-id',
      cwd: path.join(cwd, 'worker'), system: 'Execute the delegated task in this workspace.', prompt: 'write-native-artifact', tools: [], role: 'worker' });
    expect(worker.status).toBe('succeeded');
    expect(requests[beforeWorker]?.tools?.map(tool => tool.function.name)).toContain('write');
    const workerCalls = requests.slice(before).filter(request => request.messages.some(message => message.role === 'tool'));
    expect(workerCalls.at(-1)?.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n')).not.toMatch(/(?:error|unavailable|denied|not found)/i);
    expect(await readFile(path.join(cwd, 'worker', 'native-result.txt'), 'utf8')).toBe('native worker proof');
    const suspendedInput = { ...a, role: 'worker' as const, tools: [], laneId: 'suspended-lane', eventId: 'suspended-event',
      prompt: 'write-native-artifact hold-until-recovery hold-after-tool', cwd: path.join(cwd, 'suspended') };
    const suspension = new AbortController();
    const running = brain.run({ ...suspendedInput, signal: suspension.signal }).catch(() => undefined);
    await held;
    expect(await readFile(path.join(cwd, 'suspended', 'native-result.txt'), 'utf8')).toBe('native worker proof');
    const writesBeforeRestart = writeDispatches;
    suspension.abort(Object.assign(new Error('Application stopped; retain native work.'), { code: 'BOT_SUSPEND' }));
    await running; await brain.close();
    await native.instances.stop(native.instance.id);
    const restored = await native.instances.ensureHost(native.instance.id);
    const reopened = new BotDshBrain({ getHost: async () => ({ client: restored }) });
    expect((await reopened.run(suspendedInput)).text).toBe('pong-from-native-loop');
    expect(writeDispatches).toBe(writesBeforeRestart);
    const beforeRestore = requests.length;
    expect(await reopened.run(a)).toEqual(first[0]); expect(requests).toHaveLength(beforeRestore);
  } finally { await brain.close().catch(() => undefined); await native.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 240000);
