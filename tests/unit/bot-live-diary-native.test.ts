import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { BotService } from '../../src/main/companion-bot/service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import type { BotMaintenanceCandidates, BotMaintenanceJob } from '../../src/shared/companion-bot-maintenance';

const runtimeDirectory = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM;
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const bundleDirectory = path.resolve('resources/embedding-models');

it.skipIf(!runtimeDirectory || !existsSync(nodePath) || !existsSync(path.join(packageRoot, 'lib/client.cjs')) || !existsSync(path.join(bundleDirectory, 'manifest.json')))(
  'lets the live companion author a tagged diary and recall it in a new topic without a lookup tool', async () => {
    const host = await createBotNativeHost(runtimeDirectory!);
    const fact = '周六观鸟定在青鹭湾北岸，六点在观景台碰头。', question = '周六我们几点在哪里碰头？';
    const diary = '我们约好周六早上六点在青鹭湾北岸观景台集合观鸟。';
    const dreamNarrative = '我梦见观景台的栏杆长出了羽毛。';
    const duringDream = '请把重叠的纸张分开，告诉我可以继续。';
    let dreamSource = '', dreamInFlight = false, finishDream!: () => void;
    const releaseDream = new Promise<void>(resolve => { finishDream = resolve; });
    const modelCalls: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = [];
    // A deterministic provider chooses DailyNote from the actual advertised
    // tools. All dispatch, authorization, indexing, topic routing and recall
    // use the installed DSH and bundled VCP/CPU encoder.
    const provider = createServer(async (request, response) => {
      let wire = ''; for await (const chunk of request) wire += chunk;
      const body = JSON.parse(wire) as typeof modelCalls[number];
      modelCalls.push(body);
      const has = (needle: string) => body.messages.some(message => JSON.stringify(message.content).includes(needle));
      const recall = has(question), writing = !has(duringDream) && !recall && has(fact) && body.tools?.some(tool => tool.function.name === 'memory_write')
        && !body.messages.some(message => message.role === 'tool');
      const dreaming = has('来自VCP-Agent灵魂系统的回响') && has(diary) && !!dreamSource && has(dreamSource);
      if (dreaming) {
        dreamInFlight = true;
        await releaseDream;
        dreamInFlight = false;
      }
      const delta = dreaming ? { content: JSON.stringify({ narrative: dreamNarrative, candidates: [{
        type: 'insight', sourceIds: [dreamSource], content: '梦中羽毛也许和我期待观鸟有关。', tags: ['观鸟'], reason: '梦中的联想',
        uncertainties: ['这只是梦中的联想'], quotes: [{ sourceId: dreamSource, text: diary }],
      }] }) } : has(duringDream) ? { content: '纸张已分开，可以继续。' } : writing ? { tool_calls: [{ index: 0, id: 'live-diary-decision', type: 'function', function: {
        name: 'memory_write', arguments: JSON.stringify({ content: diary, tags: ['观鸟', '青鹭湾', '集合地点'] }) } }] }
        : { content: recall ? has(diary) ? '早上六点，青鹭湾北岸观景台。' : '我没找到集合地点。' : '好，周六见。' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: writing ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const address = provider.address(); if (!address || typeof address === 'string') throw Error('Missing model fixture');
    const encoder = new GlobalEmbeddingService({ userDataPath: host.root, bundleDirectory,
      koffiPath: createRequire(path.resolve('package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
    const gateway = new VcpEmbeddingGateway(encoder);
    const memory = new BotMemoryService({ root: path.join(host.root, 'memory'), runtime: async () => ({ nodePath, packageRoot }),
      embedding: async () => { const profile = await encoder.resolveProfile(); return gateway.configuration(profile.selectionId, profile); } });
    let service: BotService | undefined;
    try {
      const client = await host.instances.ensureHost(host.instance.id);
      const brain = new BotDshBrain({ getHost: async () => ({ client }) });
      const root = path.join(host.root, 'companion'); await mkdir(root);
      service = new BotService({ root, brain, memory, prewarmMemory: false,
        model: () => ({ apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:' + address.port, apiKey: 'protocol-fixture', model: 'native-protocol' }), onEvent: () => undefined });
      const app = service;
      const room = (await app.handle({ type: 'state' })).snapshot!.conversations.find(conversation => conversation.kind === 'direct')!;
      const send = async (content: string, requestId: string) => {
        const result = await app.handle({ type: 'message.send', conversationId: room.id, content, requestId });
        const reply = result.replyMessageIds![0]!;
        await vi.waitFor(() => {
          const event = app.store.eventForReply(reply)!;
          if (event.status === 'failed') throw Error(event.error ?? 'Native turn failed');
          expect(event.status).toBe('done');
        }, { timeout: 60000, interval: 150 });
        return app.store.eventForReply(reply)!;
      };
      const first = await send(fact, 'route-decision');
      const scope = { conversationId: room.id, companionId: first.companionId, securityDomainId: first.securityDomainId };
      await vi.waitFor(async () => {
        const notes = await memory.list(scope);
        expect(notes).toHaveLength(1);
        dreamSource = notes[0]!.id;
        expect(notes[0]).toMatchObject({ sourceEventId: first.id, sourceMessageIds: [first.sourceMessageRecordId, first.replyMessageId],
          content: diary, indexState: 'indexed' });
        expect(await memory.readNote(scope, { id: notes[0]!.id })).toMatchObject({ tags: expect.arrayContaining(['观鸟', '青鹭湾']) });
      }, { timeout: 30000, interval: 150 });
      const topic = await app.handle({ type: 'topic.new', conversationId: room.id, requestId: 'fresh-topic' });
      expect(topic.ok).toBe(true);
      const before = modelCalls.length;
      const second = await send(question, 'route-question');
      expect(app.store.getMessage(second.replyMessageId)?.content).toContain('青鹭湾北岸观景台');
      const followups = modelCalls.slice(before).filter(call => call.messages.some(message => JSON.stringify(message.content).includes(question)));
      expect(followups.length).toBeGreaterThan(0);
      expect(followups[0]!.messages.some(message => JSON.stringify(message.content).includes(diary))).toBe(true);
      expect(followups.every(call => call.messages.every(message => message.role !== 'tool'))).toBe(true);

      const audience = { companionId: scope.companionId, conversationId: room.id };
      const run = await app.handle({ type: 'memory.maintenance.run', ...audience, kind: 'dream', requestId: 'bird-dream' });
      const jobId = (run.memory as BotMaintenanceJob).id;
      await vi.waitFor(() => expect(dreamInFlight).toBe(true), { timeout: 30000, interval: 100 });
      const whileDreaming = await send(duringDream, 'ordinary-chat-while-dreaming');
      expect(app.store.getMessage(whileDreaming.replyMessageId)?.content).toContain('可以继续');
      expect(dreamInFlight).toBe(true);
      finishDream();
      await vi.waitFor(async () => {
        const job = (await app.handle({ type: 'memory.maintenance.get', ...audience, jobId })).memory as BotMaintenanceJob;
        expect(job.narrative, job.error).toBe(dreamNarrative);
      }, { timeout: 60000, interval: 200 });
      const { items } = (await app.handle({ type: 'memory.maintenance.candidates', ...audience, jobId })).memory as BotMaintenanceCandidates;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: 'insight', status: 'pending', sourceCount: 1 });
      expect(await memory.list(scope)).toHaveLength(1);
      await app.handle({ type: 'memory.maintenance.review', ...audience, jobId, candidateId: items[0]!.id,
        revision: items[0]!.revision, decision: 'approve', requestId: 'save-dream-insight' });
      await vi.waitFor(async () => {
        const notes = await memory.list(scope);
        expect(notes).toHaveLength(2);
        expect(notes.some(note => note.content?.includes('梦境感悟（非用户事实）'))).toBe(true);
      }, { timeout: 30000, interval: 200 });
    } finally {
      finishDream();
      try { await service?.shutdown(); await memory.close(); await gateway.close(); await encoder.close(); }
      finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await host.close(); }
    }
  }, 180000);
