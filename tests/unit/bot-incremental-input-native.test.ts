import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { NativeServiceMemory } from '../fixtures/bot-native-service';

type Envelope = { message: { id: string; content: string }; files: Array<{ id: string; path: string }> };
type Wire = { role: string; content: string | Array<{ text?: string }> };
const text = (message: Wire) => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('\n');

// The real DSH Host, plugin, native Session and filesystem tool execute here.
// Only inference and VCP recall are deterministic, isolated fixtures.
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('delivers one incremental envelope per native turn and retains original history exactly once across topic reuse', async () => {
  const requests: Array<{ latest: string; envelopes: Envelope[] }> = [], errors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Wire[] };
      const envelopes = body.messages.flatMap(message => {
        if (message.role !== 'user') return [];
        try { const value = JSON.parse(text(message)) as Envelope; return value.message?.id && Array.isArray(value.files) ? [value] : []; } catch { return []; }
      });
      const latest = envelopes.at(-1);
      if (latest) requests.push({ latest: latest.message.id, envelopes });
      const lastUser = body.messages.findLastIndex(message => message.role === 'user');
      const hasRead = body.messages.slice(lastUser + 1).some(message => message.role === 'tool');
      const delta = latest?.files.length && !hasRead
        ? { tool_calls: [{ index: 0, id: 'read-' + latest.message.id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: latest.files[0]!.path }) } }] }
        : { content: latest ? 'NATIVE_DONE ' + latest.message.id : '{"notes":[]}' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end('Fixture failure'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing model port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let service: BotService | undefined;
  try {
    const client = await native.instances.ensureHost(native.instance.id), brain = new BotDshBrain({ getHost: async () => ({ client }) });
    const root = path.join(native.root, 'chat'), media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') }); await mkdir(root, { recursive: true });
    service = new BotService({ root, brain, media, memory: new NativeServiceMemory(path.join(root, 'memory')), onEvent: () => undefined,
      model: () => ({ apiFormat: 'openai_chat', model: 'incremental-native-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', contextWindow: 32768, maxTokens: 2048 }) });
    const initial = (await service.handle({ type: 'state' })).snapshot!, room = initial.conversations.find(room => room.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    const file = path.join(root, 'original.txt'); await writeFile(file, 'NATIVE_ORIGINAL_DATA');
    const ref = (await media.importFiles({ conversationId: room.id, paths: [file] }))[0]!;
    const send = async (requestId: string, attachmentIds?: string[], conversationId=room.id) => {
      const sent = await service!.handle({ type: 'message.send', conversationId, requestId, content: requestId, attachmentIds });
      const deadline = Date.now() + 40000;
      while (service!.store.getMessage(sent.replyMessageIds![0]!)?.status !== 'sent') {
        const reply = service!.store.getMessage(sent.replyMessageIds![0]!);
        if (reply?.status === 'failed' || Date.now() > deadline) throw Error('Native reply failed: ' + reply?.error);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return sent.messageId!;
    };
    const first = await send('original-upload', [ref.id]);
    const topic = (await service.handle({ type: 'state', conversationId: room.id })).snapshot!.chatRuntime!.topic!;
    const second = await send('plain-follow-up');
    const third = await send('third-follow-up');
    await service.handle({ type: 'topic.new', conversationId: room.id, requestId: 'separate-topic' });
    const separate = await send('independent-request');
    await service.handle({ type: 'topic.select', conversationId: room.id, topicId: topic.id });
    const reconnected = await send('return-to-original');
    const latest = (id: string) => requests.findLast(request => request.latest === id)!.envelopes;
    expect(latest(first).map(item => item.message.id)).toEqual([first]);
    expect(latest(second).map(item => item.message.id)).toEqual([first, second]);
    expect(latest(third).map(item => item.message.id)).toEqual([first, second, third]);
    expect(latest(separate).map(item => item.message.id)).toEqual([separate]);
    expect(latest(reconnected).map(item => item.message.id)).toEqual([first, second, third, reconnected]);
    expect(latest(reconnected).map(item => item.files.length)).toEqual([1, 0, 0, 0]);
    expect(path.isAbsolute(latest(first)[0]!.files[0]!.path)).toBe(true); expect(errors).toEqual([]);
    expect(requests.filter(request => request.latest === first)).toHaveLength(2); // Native read + final response.
    const bob=await service.handle({type:'companion.create',name:'Bob',persona:'Independent collaborator'});
    const bobId=service.store.getConversation(bob.conversationId!)!.memberIds.find(id=>id!=='user')!;
    const group=(await service.handle({type:'conversation.create',kind:'group',title:'Native topic files',memberIds:[DEFAULT_BOT_COMPANION_ID,bobId],participationMode:'mentions'})).conversationId!;
    const groupRef=(await media.importFiles({conversationId:group,paths:[file]}))[0]!;
    const groupFirst=await send('@大肥鱼 topic-upload',[groupRef.id],group);
    const groupJoined=await send('@Bob join-topic',undefined,group);
    const groupFollowup=await send('@Bob continue-topic',undefined,group);
    expect(latest(groupJoined).map(item=>item.message.id)).toEqual([groupJoined]);
    expect(latest(groupJoined)[0]!.files.map(file=>file.id)).toEqual([groupRef.id]);
    expect(latest(groupFollowup).map(item=>item.message.id)).toEqual([groupJoined,groupFollowup]);
    expect(latest(groupFollowup).at(-1)!.files).toEqual([]);
    const evidence = path.resolve('artifacts/companion-incremental-inputs'); await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'native-result.json'), JSON.stringify({ passed: true, runtimeVersion: native.runtimeVersion,
      actualDshHost: true, actualNativeFileRead: true, modelEndpoint: 'local-scripted-fixture', vcpRecall: 'fixture',
      turns: [first, second, third, separate, reconnected,groupFirst,groupJoined,groupFollowup].map(id => ({ nativeHistoryInputs: latest(id).length, latestInputFiles: latest(id).at(-1)!.files.length })),
      everyOriginalMessageOccursOnce: true, existingTopicRestored: true, topicFilesBootstrappedForNewCompanion:true }, null, 2));
  } finally { await service?.shutdown(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 180000);
