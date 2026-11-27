import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMaintenanceStore } from '../../src/main/companion-bot/memory-maintenance-store';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { BotService } from '../../src/main/companion-bot/service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import type { BotMaintenanceCandidates, BotMaintenanceCandidateDetail, BotMaintenanceJob } from '../../src/shared/companion-bot-maintenance';
import { createBotNativeHost } from '../fixtures/bot-native-host';

const program = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM;
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const bundleDirectory = path.resolve('resources/embedding-models');
const ready = program && existsSync(nodePath) && existsSync(path.join(packageRoot, 'lib/client.cjs'))
  && existsSync(path.join(bundleDirectory, 'runtime-cpu/llama-server.exe'));

it.skipIf(!ready)('dreams from a persisted private diary after a missed night, yields to a real chat, then resumes once while idle', async () => {
  const host = await createBotNativeHost(program!);
  const diary = '我给潮汐手账画了一只银色的鲸鱼，打算把它放在书架最上层。';
  const secret = '我把铜色潜望镜留给了灯塔管理员。';
  const narrative = '梦里银鲸沿着书架游过了退潮后的海湾。';
  const observation = '请看一下刚才的梦境任务，并告诉我你听到了。';
  const dreamPrompts: string[] = [], observedJobs: string[] = [], providerCalls: string[] = [];
  let sourceId = '', sourceChecksum = '', jobId = '', release!: () => void;
  const pausedProvider = new Promise<void>(resolve => { release = resolve; });
  const provider = createServer(async (request, response) => {
    let wire = '';
    for await (const chunk of request) wire += chunk;
    const body = JSON.parse(wire) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
    const prompt = JSON.stringify(body.messages);
    const dreaming = prompt.includes('来自VCP-Agent灵魂系统的回响');
    providerCalls.push(dreaming ? 'dream' : prompt.includes(observation) ? 'chat' : 'other');
    let delta: Record<string, unknown>, finish = 'stop';
    if (dreaming) {
      dreamPrompts.push(prompt);
      if (dreamPrompts.length === 1) await pausedProvider;
      delta = { content: JSON.stringify({ narrative, candidates: [{ type: 'insight', sourceIds: [sourceId],
        content: '梦中的银鲸让我想起画潮汐手账的耐心。', tags: ['潮汐手账'], reason: '梦中意象', uncertainties: ['属于梦中联想'],
        quotes: [{ sourceId, text: diary }] }] }) };
    } else if (prompt.includes(observation) && body.tools?.some(tool => tool.function.name === 'memory_maintenance')
      && !body.messages.some(message => message.role === 'tool')) {
      delta = { tool_calls: [{ index: 0, id: 'observe-idle-dream', type: 'function', function: {
        name: 'memory_maintenance', arguments: JSON.stringify({ operation: 'status', jobId }) } }] };
      finish = 'tool_calls';
    } else {
      for (const message of body.messages.filter(message => message.role === 'tool')) observedJobs.push(JSON.stringify(message.content));
      delta = { content: '听到了，我在这里。' };
    }
    if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  if (!address || typeof address === 'string') throw Error('Missing model fixture');
  const encoder = new GlobalEmbeddingService({ userDataPath: host.root, bundleDirectory,
    koffiPath: createRequire(path.resolve('package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
  const gateway = new VcpEmbeddingGateway(encoder);
  const root = path.join(host.root, 'companion');
  let client: Awaited<ReturnType<typeof host.instances.ensureHost>>;
  const realNow = Date.now.bind(Date);
  const morning = new Date(); morning.setHours(9, 0, 0, 0);
  const evening = new Date(morning); evening.setDate(evening.getDate() - 1); evening.setHours(21);
  let offset = evening.getTime() - realNow();
  const clock = vi.spyOn(Date, 'now');
  const open = () => {
    const memory = new BotMemoryService({ root: path.join(host.root, 'memory'), runtime: async () => ({ nodePath, packageRoot }),
      embedding: async () => { const profile = await encoder.resolveProfile(); return gateway.configuration(profile.selectionId, profile); } });
    const brain = new BotDshBrain({ getHost: async () => ({ client }) });
    const service = new BotService({ root, memory, brain, prewarmMemory: false, onEvent: () => undefined,
      model: () => ({ apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:' + address.port, apiKey: 'protocol-fixture', model: 'native-protocol' }) });
    return { service, memory };
  };
  let instance: ReturnType<typeof open> | undefined;
  try {
    client = await host.instances.ensureHost(host.instance.id);
    clock.mockImplementation(() => realNow() + offset);
    await mkdir(root);
    instance = open();
    const previous = instance.service;
    const previousMemory = instance.memory;
    const room = (await previous.handle({ type: 'state' })).snapshot!.conversations.find(item => item.kind === 'direct')!;
    const audience = { conversationId: room.id, companionId: room.memberIds.find(id => id !== 'user')! };
    const otherId = (await previous.handle({ type: 'companion.create', name: '守灯人', persona: '记录灯塔的生活。' })).conversationId!;
    const otherRoom = previous.store.getConversation(otherId)!;
    const other = { conversationId: otherId, companionId: otherRoom.memberIds.find(id => id !== 'user')! };
    await previous.handle({ type: 'memory.maintenance.settings.update', ...other, settings: { enabled: false } });
    await previous.handle({ type: 'chat.activity', conversationId: room.id });
    for (const [owner, content, tag] of [[audience, diary, '手账'], [other, secret, '灯塔']] as const) {
      await previous.handle({ type: 'memory.remember', ...owner, requestId: 'note-' + owner.companionId, content, tags: [tag] });
      const scope = { ...owner, securityDomainId: previous.store.getConversation(owner.conversationId)!.securityDomainId };
      await vi.waitFor(async () => {
        const notes = await previousMemory.list(scope);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ indexState: 'indexed', content });
        if (owner === audience) {
          sourceId = notes[0]!.id;
          const note = await previousMemory.readNote(scope, { id: sourceId }) as { checksum: string };
          expect(note.checksum).toBeTruthy();
          sourceChecksum = note.checksum;
        }
      }, { timeout: 45_000, interval: 250 });
    }
    expect(dreamPrompts).toHaveLength(0);
    await previous.shutdown();
    instance = undefined;

    // Closing the service discards native worker sessions and JS scheduler state.
    // Only the companion database and its indexed diary survive the missed night.
    offset = morning.getTime() - realNow();
    instance = open();
    const app = instance.service;
    await app.handle({ type: 'state' });
    app.awaken();
    const jobs = async (owner = audience) => ((await app.handle({ type: 'memory.maintenance.list', ...owner })).memory as { items: BotMaintenanceJob[] }).items;
    const job = async () => (await app.handle({ type: 'memory.maintenance.get', ...audience, jobId })).memory as BotMaintenanceJob;
    expect(await jobs()).toEqual([]);
    offset += 25_000;
    await vi.waitFor(async () => {
      const scheduled = (await jobs())[0];
      expect(scheduled).toMatchObject({ trigger: 'idle', kind: 'dream', automatic: true });
      expect(dreamPrompts, JSON.stringify({ phase: scheduled?.phase, error: scheduled?.error, providerCalls })).toHaveLength(1);
      jobId = scheduled!.id;
    }, { timeout: 60_000, interval: 150 });
    expect(dreamPrompts[0]).toContain('你今天脑海中闪过的微小片段（近期）');
    expect(dreamPrompts[0]).toContain(sourceId);
    expect(dreamPrompts[0]).toContain(diary);
    expect(dreamPrompts[0]).not.toContain(secret);
    expect(await jobs(other)).toEqual([]);

    await app.handle({ type: 'chat.activity', conversationId: room.id });
    const turn = await app.handle({ type: 'message.send', conversationId: room.id, content: observation, requestId: 'foreground-observe-dream' });
    const reply = turn.replyMessageIds![0]!;
    await vi.waitFor(async () => {
      const event = app.store.eventForReply(reply);
      expect(event?.status, event?.error).toBe('done');
      expect(app.store.getMessage(reply)?.content).toContain('听到了');
      expect(await job()).toMatchObject({ status: 'queued', phase: 'waiting_idle' });
    }, { timeout: 60_000, interval: 150 });
    expect(observedJobs.some(result => result.includes(jobId))).toBe(true);
    release();
    expect(dreamPrompts).toHaveLength(1);
    offset += 130_000;
    await vi.waitFor(async () => {
      const completed = await job();
      expect(completed.narrative, completed.error).toBe(narrative);
      expect(completed.status).toBe('review');
    }, { timeout: 60_000, interval: 200 });
    expect(dreamPrompts.length).toBeGreaterThanOrEqual(2);
    expect(dreamPrompts.every(prompt => prompt.includes(diary) && !prompt.includes(secret))).toBe(true);
    const candidates = (await app.handle({ type: 'memory.maintenance.candidates', ...audience, jobId })).memory as BotMaintenanceCandidates;
    expect(candidates.items).toHaveLength(1);
    const candidate = (await app.handle({ type: 'memory.maintenance.candidate', ...audience, jobId, candidateId: candidates.items[0]!.id })).memory as BotMaintenanceCandidateDetail;
    expect(candidate).toMatchObject({ type: 'insight', status: 'pending', quotes: [{ sourceId, text: diary }],
      sources: [expect.objectContaining({ id: sourceId, checksum: sourceChecksum })] });
    // Give the real scheduler another daytime sweep beyond the native cooldown.
    const previousCalls = dreamPrompts.length;
    const sweep = vi.spyOn(BotMaintenanceStore.prototype, 'scheduleIdleDream');
    try {
      offset += 8 * 3_600_000 + 60_000;
      await vi.waitFor(() => expect(sweep).toHaveBeenCalled(), { timeout: 10_000, interval: 150 });
      await sweep.mock.results[0]!.value;
    } finally { sweep.mockRestore(); }
    expect((await jobs()).map(item => item.id)).toEqual([jobId]);
    expect(dreamPrompts).toHaveLength(previousCalls);
    expect(await jobs(other)).toEqual([]);
  } finally {
    release();
    try { await instance?.service.shutdown(); await gateway.close(); await encoder.close(); }
    finally {
      clock.mockRestore();
      provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await host.close();
    }
  }
}, 210_000);
