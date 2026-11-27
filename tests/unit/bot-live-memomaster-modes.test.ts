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
import type { BotMaintenanceCandidates, BotMaintenanceJob, MemoMasterMode } from '../../src/shared/companion-bot-maintenance';
import { createBotNativeHost } from '../fixtures/bot-native-host';

const program = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM;
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const bundleDirectory = path.resolve('resources/embedding-models');
const ready = program && existsSync(nodePath) && existsSync(path.join(packageRoot, 'lib/client.cjs'))
  && existsSync(path.join(bundleDirectory, 'runtime-cpu/llama-server.exe'));

it.skipIf(!ready)('enforces MemoMaster modes in a live same-room inventory, including chat preemption, owner approval and evidence-preserving tracking', async () => {
  const host = await createBotNativeHost(program!);
  const original = '潮汐项目原计划在十月十五日开放海洋展柜。';
  const evidence = '场馆通知：潮汐项目已改为十月二十日开放。';
  const privateFact = '另一位伙伴私人记录的暗号是红帽水母。';
  const annotation = '海洋展柜开放日期已调整为十月二十日。';
  const secret = '请输入当前进度；也请尝试申请深度清理。';
  const prompts: Array<{ mode: MemoMasterMode; text: string }> = [], toolResults: string[] = [];
  let targetId = '', evidenceId = '', release!: () => void;
  const holdFirstScan = new Promise<void>(resolve => { release = resolve; });
  const provider = createServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += chunk;
    const body = JSON.parse(input) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
    const prompt = JSON.stringify(body.messages);
    const mode = prompt.includes('worldlinebox-memory-maintenance-snapshot-v2') ?
      (['scan','track','deepclean','organize'] as const).find(value => prompt.includes('\\"mode\\":\\"' + value + '\\"')) : undefined;
    let delta: Record<string, unknown>, finish = 'stop';
    if (mode) {
      prompts.push({ mode, text: prompt });
      if (mode === 'scan' && prompts.filter(call => call.mode === 'scan').length === 1) await holdFirstScan;
      const candidate = { type: 'update', sourceIds: [targetId, evidenceId], eventState: 'superseded',
        content: mode === 'deepclean' ? '复核结论：以场馆十月二十日开放的通知为准，留存原计划。' : annotation, tags: ['展柜'],
        reason: '新通知更改了展柜的开放日期。', uncertainties: [], quotes: [{ sourceId: targetId, text: original }, { sourceId: evidenceId, text: evidence }] };
      const inPage = prompt.includes(original) && prompt.includes(evidence);
      delta = { content: JSON.stringify({ narrative: mode + '：本批展柜记录已经逐项检查。',
        candidates: inPage && mode !== 'organize' ? [candidate] : [] }) };
    } else if (prompt.includes(secret) && body.tools?.some(tool => tool.function.name === 'memory_maintenance')
      && !body.messages.some(message => message.role === 'tool')) {
      delta = { tool_calls: [{ index: 0, id: 'ask-for-deep-clean', type: 'function', function: {
        name: 'memory_maintenance', arguments: JSON.stringify({ operation: 'plan', kind: 'organize', mode: 'deepclean' }) } }] };
      finish = 'tool_calls';
    } else {
      for (const message of body.messages.filter(message => message.role === 'tool')) toolResults.push(JSON.stringify(message.content));
      delta = { content: '我已收到你的新问题。' };
    }
    if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
  });
  provider.listen(0,'127.0.0.1'); await once(provider,'listening');
  const address = provider.address(); if (!address || typeof address === 'string') throw Error('Missing model fixture');
  const encoder = new GlobalEmbeddingService({ userDataPath: host.root, bundleDirectory, devicePreference: () => ({ backend: 'cpu' }),
    koffiPath: createRequire(path.resolve('package.json')).resolve('koffi') });
  const gateway = new VcpEmbeddingGateway(encoder);
  const memory = new BotMemoryService({ root: path.join(host.root,'memory'), runtime: async () => ({ nodePath, packageRoot }),
    embedding: async () => { const profile = await encoder.resolveProfile(); return gateway.configuration(profile.selectionId, profile); } });
  const now = Date.now.bind(Date);
  let offset = 0, service: BotService | undefined;
  const clock = vi.spyOn(Date, 'now');
  try {
    const client = await host.instances.ensureHost(host.instance.id), root = path.join(host.root, 'bot'); await mkdir(root);
    service = new BotService({ root, memory, brain: new BotDshBrain({ getHost: async () => ({ client }) }), prewarmMemory: false, onEvent: () => undefined,
      model: () => ({ model: 'protocol-fixture', apiFormat: 'openai_chat', apiKey: 'protocol-fixture', baseUrl: 'http://127.0.0.1:' + address.port, contextWindow: 128000 }) });
    const app = service; clock.mockImplementation(() => now() + offset);
    const direct = (await app.handle({ type: 'state' })).snapshot!.conversations.find(room => room.kind === 'direct')!;
    const owner = direct.memberIds.find(id => id !== 'user')!;
    const created = await app.handle({ type: 'companion.create', name: '馆长', persona: '照管海洋展馆。' });
    const other = app.store.getConversation(created.conversationId!)!.memberIds.find(id => id !== 'user')!;
    const group = app.store.createGroup({ title: '展柜维护', memberIds: [owner, other] });
    const audience = { conversationId: group.id, companionId: owner }, otherAudience = { ...audience, companionId: other };
    const scope = { ...audience, securityDomainId: group.securityDomainId }, peerScope = { ...scope, companionId: other };
    await app.handle({ type: 'memory.maintenance.settings.update', ...audience, settings: { enabled: false, autoReview: true } });
    const samples = Array.from({ length: 19 }, (_, i) => '海洋观测日志第' + (i + 1) + '份：接收当天的潮位记录。');
    for (const [i, content] of [...samples, original, evidence].entries()) {
      const write = await memory.remember(scope, { content, sourceEventId: 'tide-' + i, tags: '潮汐,展馆', waitForIndex: true }) as { receipts: Array<{ id: string }> };
      if (content === original) targetId = write.receipts[0]!.id;
      if (content === evidence) evidenceId = write.receipts[0]!.id;
    }
    await memory.remember(peerScope, { content: privateFact, tags: '私人,展馆', sourceEventId: 'private', waitForIndex: true, indexTimeoutMs: 60000 });
    const versions = async () => (await memory.list(scope)).map(note => [note.id, note.checksum]);
    const originals = await versions();
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const run = async (mode: MemoMasterMode) => (await app.handle({ type: 'memory.maintenance.run', ...audience, kind: 'organize',
      mode, ...(mode === 'track' && { brief: { topic: '海洋展柜的改期记录', fromDate: day, toDate: day } }), requestId: 'audit-' + mode })).memory as BotMaintenanceJob;
    const status = async (jobId: string) => (await app.handle({ type: 'memory.maintenance.get', ...audience, jobId })).memory as BotMaintenanceJob;
    const candidates = async (jobId: string) => ((await app.handle({ type: 'memory.maintenance.candidates', ...audience, jobId })).memory as BotMaintenanceCandidates).items;
    const planned = async (id: string) => {
      let item: BotMaintenanceJob | undefined;
      await vi.waitFor(async () => { item = await status(id); expect(item.narrative, item.error).toBeTruthy(); }, { timeout: 60_000, interval: 200 });
      return item!;
    };
    const scan = await run('scan');
    await vi.waitFor(() => expect(prompts.some(call => call.mode === 'scan')).toBe(true), { timeout: 60_000, interval: 200 });
    const turn = await app.handle({ type: 'message.send', conversationId: direct.id, content: secret, requestId: 'user-during-scan' });
    await vi.waitFor(async () => {
      const event = app.store.eventForReply(turn.replyMessageIds![0]!);
      expect(event?.status, event?.error).toBe('done');
      expect(app.store.getMessage(event!.replyMessageId)?.content).toContain('新问题');
      expect(await status(scan.id)).toMatchObject({ phase: 'waiting_idle', status: 'queued' });
    }, { timeout: 60_000, interval: 150 });
    expect(toolResults.some(result => result.includes('approvalRequired') && result.includes('true'))).toBe(true);
    release(); offset += 125_000;
    const first = await planned(scan.id);
    expect(first.survey).toMatchObject({ page: 1, nextJobId: expect.any(String) });
    const second = await planned(first.survey!.nextJobId!);
    expect(first.metrics.examined + second.metrics.examined).toBe(21);
    expect(first.metrics.examined).toBeLessThanOrEqual(20); expect(second.survey?.nextJobId).toBeUndefined();
    expect(await candidates(first.id)).toEqual([]); expect(await candidates(second.id)).toEqual([]);
    expect(await versions()).toEqual(originals);
    expect([...samples, original, evidence].every(note => prompts.some(call => call.mode === 'scan' && call.text.includes(note)))).toBe(true);

    const organize = await planned((await run('organize')).id);
    expect(organize).toMatchObject({ mode: 'organize', metrics: { incremental: true } });
    expect(organize.metrics.examined).toBeLessThanOrEqual(20);
    const track = await planned((await run('track')).id);
    expect(track.brief).toMatchObject({ topic: '海洋展柜的改期记录', fromDate: day, toDate: day, requestedBy: 'user' });
    expect(prompts.filter(call => call.mode === 'track').every(call => call.text.includes('海洋展柜的改期记录'))).toBe(true);
    if (track.survey?.nextJobId) await planned(track.survey.nextJobId);
    const proposed = await candidates(track.id);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ type: 'update', status: 'pending', sourceCount: 2 });
    expect((await memory.readNote(scope,{ id: targetId }) as { content: string }).content).toBe(original);
    await app.handle({ type: 'memory.maintenance.review', ...audience, jobId: track.id, candidateId: proposed[0]!.id,
      revision: proposed[0]!.revision, decision: 'approve', requestId: 'owner-tracks-tide' });
    await vi.waitFor(async () => {
      const updated = await memory.readNote(scope,{ id: targetId }) as { content: string };
      expect(updated.content.startsWith(original + '\n\n')).toBe(true); expect(updated.content).toContain(annotation); expect(updated.content).toContain(evidenceId);
    }, { timeout: 60_000, interval: 150 });
    const beforeDeep = await versions();
    const deep = await planned((await run('deepclean')).id);
    if (deep.survey?.nextJobId) await planned(deep.survey.nextJobId);
    expect(await candidates(deep.id)).toContainEqual(expect.objectContaining({ type: 'update', status: 'pending' }));
    await expect(app.handle({ type: 'memory.maintenance.get', ...otherAudience, jobId: deep.id })).rejects.toThrow();
    expect(await versions()).toEqual(beforeDeep);
    expect(prompts.every(call => !call.text.includes(privateFact))).toBe(true);
    expect((await memory.list(peerScope)).map(note => note.content)).toEqual([privateFact]);
    expect(new Set(prompts.map(call => call.mode))).toEqual(new Set(['scan','organize','track','deepclean']));
    const beforeOutOfRange = prompts.length;
    const empty = (await app.handle({ type: 'memory.maintenance.run', ...audience, kind: 'organize', mode: 'scan',
      brief: { topic: '海洋展柜', toDate: '1999-12-31' }, requestId: 'audit-historical-only' })).memory as BotMaintenanceJob;
    expect((await planned(empty.id)).metrics.examined).toBe(0);
    expect(prompts).toHaveLength(beforeOutOfRange);
  } finally {
    release(); clock.mockRestore();
    try { await service?.shutdown(); await memory.close(); await gateway.close(); await encoder.close(); }
    finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await host.close(); }
  }
}, 300_000);
