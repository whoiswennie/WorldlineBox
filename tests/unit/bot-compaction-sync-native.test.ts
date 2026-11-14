import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { startMobileGateway } from '../../src/main/companion-bot/mobile-gateway';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import type { BotNativeContext } from '../../src/shared/companion-native-context';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { NativeServiceMemory } from '../fixtures/bot-native-service';

class Memory extends NativeServiceMemory {
  private readonly prepared = new Map<string, Awaited<ReturnType<NativeServiceMemory['prepareTurn']>>>();
  override async prepareTurn(input: Parameters<NativeServiceMemory['prepareTurn']>[0]) { const value = await super.prepareTurn(input); this.prepared.set(input.requestId, value); return value; }
  override async resumePrepared(input: Parameters<NativeServiceMemory['resumePrepared']>[0]) { const value = this.prepared.get(input.requestId); if (!value) throw Error('Missing prepared test turn'); return value; }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 45000) { const deadline = Date.now() + ms; while (!await check()) { if (Date.now() > deadline) throw Error(label); await pause(20); } }

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('pushes native auto/manual compaction, queues concurrent input and preserves independent topic context', async () => {
  let held: ServerResponse | undefined, hold = true, failSummary = 0, normalCalls = 0, summaries = 0;
  const reply = (response: ServerResponse, content: string, inputTokens = 700) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const wire = JSON.parse(body) as { messages: Array<{ role: string; content: string | Array<{ text?: string }> }> };
    const content = wire.messages.map(message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text ?? '').join(''));
    const summary = content.some(value => value.startsWith('You are now acting as a compaction engine'));
    if (summary) { summaries++; if (hold) { held = response; return; } reply(response, failSummary-- > 0 ? '' : '## Goal\nContinue the current test topic. Preserve all explicit input IDs and deliverables.\n## Next Step\nAnswer the newest user input.'); }
    else { normalCalls++; reply(response, 'NATIVE_REPLY_' + normalCalls, summaries === 0 ? 27000 : 700); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing model port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let service: BotService | undefined; const pushed: BotNativeContext[] = [];
  const evidence = path.resolve('artifacts/companion-compaction-sync'); await mkdir(evidence, { recursive: true });
  try {
    const client = await native.instances.ensureHost(native.instance.id);
    const plugin = path.join(native.root, 'native-command-fixture'), addressFile = path.join(native.root, 'native-command-port.json'); await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: '@worldlinebox-test/manual-workbench', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(path.join(plugin, 'index.js'), (await readFile(path.resolve('tests/fixtures/native-workbench-plugin.mjs'), 'utf8')).replace("'__ADDRESS_FILE__'", JSON.stringify(addressFile)));
    await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: test-manual-workbench\n      name: "@worldlinebox-test/manual-workbench"\n');
    expect(await client.request('/plugins', { action: 'add', spec: 'file:' + plugin.replaceAll('\\', '/') }, undefined, 180000)).toMatchObject({ application: 'applied' });
    const web = async (action: string, sessionId: string, extra = {}) => {
      const { port } = JSON.parse(await readFile(addressFile, 'utf8')) as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, sessionId, ...extra }), signal: AbortSignal.timeout(60000) });
      const value = await response.json(); if (!response.ok) throw Error(JSON.stringify(value)); return value;
    };
    const brain = new BotDshBrain({ getHost: async () => ({ client }) }), root = path.join(native.root, 'chat'); await mkdir(root);
    const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
    const watch = brain.watchTopicContext.bind(brain); brain.watchTopicContext = (lane, onSample, signal) => watch(lane, sample => { pushed.push(sample); onSample(sample); }, signal);
    service = new BotService({ root, brain, media, memory: new Memory(path.join(root, 'memory')), onEvent: () => undefined,
      model: () => ({ apiFormat: 'openai_chat', model: 'native-compaction-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-only', contextWindow: 32768, maxTokens: 1024 }) });
    const room = (await service.handle({ type: 'state' })).snapshot!.conversations.find(room => room.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    const state = async () => (await service!.handle({ type: 'state', conversationId: room.id })).snapshot!;
    const sample = async () => (await state()).chatRuntime?.contexts?.[DEFAULT_BOT_COMPANION_ID];
    const send = (id: string, content = id) => service!.handle({ type: 'message.send', conversationId: room.id, requestId: id, content });
    const settled = async (id: string) => until(() => { const reply = service!.store.getMessage(id); if (reply?.status === 'failed') throw Error(reply.error); return reply?.status === 'sent'; }, 'Reply did not settle');
    const material = '测试资料，不是用户事实。\n' + '这里保存项目需求和输入文件说明，需要按顺序完成每一个步骤，并保留相关约定。'.repeat(700);
    const initial = await send('LARGE_INITIAL', material); await settled(initial.replyMessageIds![0]!);
    const topicA = (await state()).chatRuntime!.topic!;
    const read = () => service!.handle({ type: 'topic.context', conversationId: room.id, topicId: topicA.id, companionId: DEFAULT_BOT_COMPANION_ID });
    const before = (await read()).topicContext!.sample!;
    const preset = await web('preset', before.sessionId); expect(preset.content).toMatch(/auto:\s*true/); expect(preset.content).toMatch(/thresholdRatio:\s*0\.6/);
    const warmup = await send('SECOND_OLD_INPUT', material);
    await until(() => !!held || service!.store.getMessage(warmup.replyMessageIds![0]!)?.status === 'sent', 'Second native turn did not progress');
    const next = held ? warmup : await send('TRIGGER_AUTOMATIC');
    await until(() => !!held, 'Native automatic compaction did not request a summary');
    await until(async () => (await sample())?.activity?.phase === 'compacting', 'Automatic compression did not push to the UI state', 3000);
    expect((await sample())?.activity?.compaction?.origin).toBe('automatic');
    hold = false; reply(held!, '## Goal\nKeep the test project requirements.\n## Next Step\nAnswer the follow-up.'); held = undefined;
    await settled(next.replyMessageIds![0]!);
    await until(async () => (await sample())?.activity?.phase === 'idle', 'Native automatic compaction did not settle');
    const afterAutomatic = await sample(); expect(afterAutomatic?.pressure?.projectedTokens).toBeLessThan(before.pressure!.projectedTokens!);
    await service.handle({ type: 'topic.new', conversationId: room.id, requestId: 'INDEPENDENT_TOPIC' });
    const other = await send('OTHER_TOPIC_INPUT'); await settled(other.replyMessageIds![0]!); const topicB = (await state()).chatRuntime!.topic!;
    const otherBefore = (await service.handle({ type: 'topic.context', conversationId: room.id, topicId: topicB.id, companionId: DEFAULT_BOT_COMPANION_ID })).topicContext!.sample!;
    await service.handle({ type: 'topic.select', conversationId: room.id, topicId: topicA.id }); await read();
    hold = true; const manual = web('command', before.sessionId, { text: '/compact' });
    await until(() => !!held, 'Native manual compaction did not reach summary');
    await until(async () => (await sample())?.activity?.phase === 'compacting', 'External manual compression was not pushed', 3000);
    expect((await web('state', before.sessionId)).status).toBe('idle');
    expect((await sample())?.activity?.compaction?.origin).toBe('manual');
    expect(await client.request('/idle', {})).toMatchObject({ idle: false, known: true });
    const during = await sample(), callsBeforeQueue = normalCalls, queued = await send('QUEUED_DURING_MANUAL'); await pause(1200);
    expect(normalCalls).toBe(callsBeforeQueue); expect(service.store.getMessage(queued.replyMessageIds![0]!)?.status).not.toBe('failed');
    const otherDuring = (await service.handle({ type: 'topic.context', conversationId: room.id, topicId: topicB.id, companionId: DEFAULT_BOT_COMPANION_ID })).topicContext!.sample!;
    expect(otherDuring.sessionId).not.toBe(before.sessionId); expect(otherDuring.asOfSeq).toBe(otherBefore.asOfSeq); expect(otherDuring.activity?.phase).toBe('idle');
    hold = false; reply(held!, '## Goal\nResume this topic with its actual newest request.'); held = undefined;
    await manual; await settled(queued.replyMessageIds![0]!);
    // Failed native /compact is observed independently of a chat turn. The
    // queue must then continue from retained history without replaying input.
    await read(); hold = true; failSummary = 2;
    const failedCommand = web('command', before.sessionId, { text: '/compact' }); await until(() => !!held, 'No failure-test summary');
    const afterFailure = await send('QUEUED_AFTER_FAILED_COMPACTION'); await pause(200);
    hold = false; failSummary--; reply(held!, ''); held = undefined;
    await failedCommand; await settled(afterFailure.replyMessageIds![0]!);
    expect(pushed.some(value => value.activity?.compaction?.state === 'failed')).toBe(true);
    const nativeStats = await web('projections', before.sessionId), final = (await read()).topicContext!.sample!;
    expect(final.pressure).toEqual(nativeStats.values.contextPressure); expect(final.breakdown).toEqual(nativeStats.values.contextBreakdown); expect(final.usage).toEqual(nativeStats.values.tokenUsage);
    const history = await web('state', before.sessionId);
    for (const sent of [initial, warmup, next, queued, afterFailure]) {
      const event = service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE reply_message_id=?').get(sent.replyMessageIds![0]!)) as { id: string };
      expect(history.events.filter((eventRow: { type: string; data: { id?: string } }) => eventRow.type === 'user/message' && eventRow.data.id === 'worldlinebox-bot:' + event.id)).toHaveLength(1);
    }
    const portProbe = createServer();
    await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const mobilePort = (portProbe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
    const mobileToken = 'a'.repeat(64);
    await writeFile(path.join(root, 'mobile-access.json'), JSON.stringify({ port: mobilePort, token: mobileToken }));
    const gateway = await startMobileGateway({ root, bot: async () => service!, media: async () => media, report: () => undefined });
    try {
      failSummary = 0;
      const mobileCompact = await fetch(`http://127.0.0.1:${mobilePort}/mobile/v1/requests`, {
        method: 'POST',
        headers: { authorization: `Bearer ${mobileToken}` },
        body: JSON.stringify({ type: 'topic.compact', conversationId: room.id, topicId: topicA.id,
          companionId: DEFAULT_BOT_COMPANION_ID, requestId: 'mobile-native-compact' }),
        signal: AbortSignal.timeout(45_000),
      });
      expect(await mobileCompact.json()).toMatchObject({ ok: true, compacted: true });
    } finally { gateway?.close(); }
    await writeFile(path.join(evidence, 'native-result.json'), JSON.stringify({ passed: true, runtime: native.runtimeVersion, model: 'local-scripted-SSE',
      actualNativeAutoCompaction: true, actualNativeCommand: true, actualServiceQueue: true, pushWithoutStatisticPolling: true,
      noInputDuplication: true, independentTopics: true, failedCompactionRecovered: true, exactNativeProjectionMatch: true, summaries, before, afterAutomatic, during, final }, null, 2));
  } catch (error) { await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(error), normalCalls, summaries, pushed: pushed.slice(-6) }, null, 2)); throw error; }
  finally { await service?.shutdown(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 240000);
