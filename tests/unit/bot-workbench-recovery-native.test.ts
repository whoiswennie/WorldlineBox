import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { NativeServiceMemory } from '../fixtures/bot-native-service';

type Event = { seq: number; type: string; data: { id?: string; inserted?: Array<{ id: string; source: { kind: string; rpcId?: string } }>;
  message?: { content: Array<{ type: string; text?: string }> }; reason?: { kind: string }; source?: { kind: string } } };
type Snapshot = { status: string; model: { provider: string; model: string }; events: Event[] };
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => item.text ?? '').join('') : '';
class WorkbenchMemory extends NativeServiceMemory {
  private readonly prepared = new Map<string, Awaited<ReturnType<NativeServiceMemory['prepareTurn']>>>();
  override async prepareTurn(input: Parameters<NativeServiceMemory['prepareTurn']>[0]) {
    const prepared = await super.prepareTurn(input); this.prepared.set(input.requestId, prepared); return prepared;
  }
  override async resumePrepared(input: Parameters<NativeServiceMemory['resumePrepared']>[0]) {
    const prepared = this.prepared.get(input.requestId); if (!prepared) throw Error('No prepared test memory'); return prepared;
  }
}

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('recovers a failed cold Web turn and queues behind live Web work on the exact same native Agent', async () => {
  const requests: Array<{ model: string; users: string[]; action?: string }> = [], trace: Array<{ eventId?: string; type: string }> = [];
  let held: ServerResponse | undefined;
  const reply = (response: ServerResponse, answer: string) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const word of [answer.slice(0, 5), answer.slice(5)]) response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: word }, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 70, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const value = JSON.parse(raw) as { model: string; messages: Array<{ role: string; content: unknown }> };
    const users = value.messages.filter(message => message.role === 'user').map(message => text(message.content));
    const action = users.findLast(user => user.startsWith('MANUAL_') || user.startsWith('{"clock"') || user === 'SEED_OTHER');
    requests.push({ model: value.model, users, action });
    if (action === 'MANUAL_HELD' || action === 'MANUAL_COLD_HELD') { held = response; return; }
    reply(response, 'ANSWER_' + (action?.startsWith('MANUAL_') ? action : requests.length));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing model port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let service: BotService | undefined;
  const evidence = path.resolve('artifacts/companion-workbench-recovery'); await mkdir(evidence, { recursive: true });
  try {
    let client = await native.instances.ensureHost(native.instance.id);
    const plugin = path.join(native.root, 'manual-web-fixture'), addressFile = path.join(native.root, 'manual-web-port.json'); await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: '@worldlinebox-test/manual-workbench', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(path.join(plugin, 'index.js'), (await readFile(path.resolve('tests/fixtures/native-workbench-plugin.mjs'), 'utf8')).replace("'__ADDRESS_FILE__'", JSON.stringify(addressFile)));
    await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: test-manual-workbench\n      name: "@worldlinebox-test/manual-workbench"\n');
    expect(await client.request('/plugins', { action: 'add', spec: 'file:' + plugin.replaceAll('\\', '/') }, undefined, 180000)).toMatchObject({ application: 'applied' });
    const web = async <T = Snapshot>(action: string, sessionId: string, extra = {}): Promise<T> => {
      const { port } = JSON.parse(await readFile(addressFile, 'utf8')) as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, sessionId, ...extra }), signal: AbortSignal.timeout(30000) });
      const result = await response.json(); if (!response.ok) throw Error(JSON.stringify(result)); return result as T;
    };
    const brain = new BotDshBrain({ getHost: async () => ({ client }) });
    const root = path.join(native.root, 'chat'), media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') }); await mkdir(root);
    service = new BotService({ root, media, memory: new WorkbenchMemory(path.join(root, 'memory')), onEvent: () => undefined,
      model: () => ({ apiFormat: 'openai_chat', model: 'workbench-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-only', contextWindow: 65536, maxTokens: 1024 }),
      brain: { run: input => brain.run({ ...input, onEvent: event => { trace.push(event); input.onEvent?.(event); } }), cancel: id => brain.cancel(id),
        cancelDurable: (input, suspend) => brain.cancelDurable(input, suspend), send: (id, input) => brain.send(id, input), archive: id => brain.archive(id), close: () => brain.close() } });
    const initial = (await service.handle({ type: 'state' })).snapshot!, room = initial.conversations.find(room => room.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    const waitReply = async (id: string) => {
      const until = Date.now() + 45000;
      for (;;) {
        const message = service!.store.getMessage(id);
        if (message?.status === 'sent') return message;
        if (message?.status === 'failed' || Date.now() > until) throw Error('Companion did not recover: ' + message?.error);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const send = (id: string) => service!.handle({ type: 'message.send', conversationId: room.id, requestId: id, content: id });
    const first = await send('INITIAL_COMPANION'); await waitReply(first.replyMessageIds![0]!);
    const topic = (await service.handle({ type: 'state', conversationId: room.id })).snapshot!.chatRuntime!.topic!;
    const binding = service.store.taskTransaction(sql => sql.prepare('SELECT native_lane_id FROM bot_topic_bindings WHERE topic_id=?').get(topic.id)) as { native_lane_id: string };
    const sessionId = BotDshBrain.sessionId(binding.native_lane_id);
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    await web('prompt', sessionId, { id: 'web-cold-error', text: 'MANUAL_COLD_FAILED' });
    const failed = await web('wait', sessionId);
    expect(failed.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason?.kind).toBe('error');
    expect(JSON.stringify(failed.events)).toContain('伙伴模型连接尚未恢复'); expect(JSON.stringify(failed.events)).not.toContain('NO_ADAPTER');
    const second = await send('AFTER_COLD_WEB_FAILURE'); await waitReply(second.replyMessageIds![0]!);
    const afterRecovery = await web('wait', sessionId); expect(afterRecovery.events.length).toBeGreaterThan(failed.events.length);
    // Configure a second real adapter, then switch in the Web UI. The bridge
    // must not overwrite a frozen request with its previous model identity.
    const other: BotDshRun = { laneId: 'other-native-model', eventId: 'seed-other-model', cwd: path.join(native.root, 'other'), system: 'Test model route', prompt: 'SEED_OTHER',
      role: 'worker', workerAccess: 'full', tools: [], workerTools: [], callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'f'.repeat(64) },
      model: { apiFormat: 'openai_chat', model: 'other-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-only', contextWindow: 65536, maxTokens: 1024 } };
    await brain.run(other); const otherModel = (await web('wait', BotDshBrain.sessionId(other.laneId))).model;
    await web('select', sessionId, { selection: otherModel });
    await web('prompt', sessionId, { id: 'web-warm-success', text: 'MANUAL_WARM_SUCCESS' });
    const warm = await web('wait', sessionId);
    expect(warm.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason?.kind).toBe('completed');
    expect(requests.findLast(request => request.action === 'MANUAL_WARM_SUCCESS')?.model).toBe('other-fixture');
    const third = await send('AFTER_MANUAL_MODEL_SWITCH'); await waitReply(third.replyMessageIds![0]!);
    await web('prompt', sessionId, { id: 'web-hold', text: 'MANUAL_HELD' });
    const until = Date.now() + 15000; while (!held) { if (Date.now() > until) throw Error('No manual live request'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const queued = await send('QUEUED_BEHIND_WEB');
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(service.store.getMessage(queued.replyMessageIds![0]!)?.status).not.toBe('sent');
    const beforeRelease = requests.length; reply(held, 'MANUAL_TASK_DONE'); held = undefined;
    await waitReply(queued.replyMessageIds![0]!); expect(requests.length).toBeGreaterThan(beforeRelease);
    // A native-configured default also restores a stale app route before a
    // cold Web request starts. Queue admission must not replace that writer.
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    await brain.run(other); await web('default', BotDshBrain.sessionId(other.laneId));
    await web('prompt', sessionId, { id: 'web-cold-hold', text: 'MANUAL_COLD_HELD' });
    const coldUntil = Date.now() + 15000; while (!held) { if (Date.now() > coldUntil) throw Error('No cold manual request'); await new Promise(resolve => setTimeout(resolve, 20)); }
    expect((await web('state', sessionId)).model.model).toBe('other-fixture');
    const coldQueued = await send('QUEUED_BEHIND_COLD_WEB');
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(service.store.getMessage(coldQueued.replyMessageIds![0]!)?.status).not.toBe('sent');
    reply(held, 'COLD_MANUAL_DONE'); held = undefined;
    await waitReply(coldQueued.replyMessageIds![0]!);
    const final = await web('wait', sessionId), history = final.events.filter(event => event.type === 'user/message');
    const ingress = final.events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted ?? []);
    // A model-setup failure can happen before user/message is committed. The
    // durable inbox still proves that exact Web submission was accepted once.
    for (const id of ['web-cold-error', 'web-warm-success', 'web-hold', 'web-cold-hold']) expect(ingress.filter(message => message.source.rpcId === id), id).toHaveLength(1);
    for (const sent of [first, second, third, queued, coldQueued]) {
      const event = service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE reply_message_id=?').get(sent.replyMessageIds![0]!)) as { id: string };
      expect(history.filter(row => row.data.id === 'worldlinebox-bot:' + event.id)).toHaveLength(1);
      expect(ingress.filter(message => message.id === 'worldlinebox-bot:' + event.id)).toHaveLength(1);
      expect(trace.filter(frame => frame.eventId === event.id).map(frame => frame.type)).toEqual(expect.arrayContaining(['status', 'text_stream', 'text', 'complete']));
    }
    expect(requests.findLast(request => request.action?.includes('QUEUED_BEHIND_WEB'))?.users.some(user => user.includes('MANUAL_WARM_SUCCESS'))).toBe(true);
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, runtime: native.runtimeVersion, actualNativeController: true,
      model: 'local-scripted-SSE', actualServiceQueue: true, sameSession: sessionId, coldManualFailureRecovered: true, warmModelSwitch: true,
      queuedBehindNativeWork: true, coldNativeDefaultRestored: true, coldLiveAgentAdopted: true,
      noInputDuplication: true, liveEventsAfterRecovery: true, requests: requests.length }, null, 2));
  } finally { await service?.shutdown(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 240000);
