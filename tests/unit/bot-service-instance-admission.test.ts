import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotService, type BotServiceOptions } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { BotTopics } from '../../src/main/companion-bot/topics';
import type { BotNativeTopicState } from '../../src/shared/companion-native-topics';

class Memory extends BotMemoryService {
  prepared = 0;
  warmed = 0;
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    this.prepared++;
    return { requestId: input.requestId, inputHash: 'fixture', scope: input.scope, messages: input.messages,
      metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async warm() { this.warmed++; }
  override async close() {}
}
class Brain extends BotDshBrain {
  calls: BotDshRun[] = [];
  constructor(private readonly respond: (input: BotDshRun) => Promise<string> = async () => '已收到') {
    super({ getHost: async () => { throw new Error('Unit test has no native Host'); } });
  }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    this.calls.push(input);
    return { text: input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : await this.respond(input),
      sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded' };
  }
  override async close() {}
}
const owned: Array<{ service: BotService; root: string }> = [];
afterEach(async () => { for (const { service, root } of owned.splice(0)) { await service.shutdown(); await rm(root, { recursive: true, force: true }); } });
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Admission fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(options: Partial<BotServiceOptions> = {}, brain = new Brain()) {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-bot-admission-'));
  let configured = false;
  const ensure = vi.fn(async (ids: string[]) => {
    void ids;
    if (!configured) throw Object.assign(new Error('请先配置共享 DSH 执行实例'), { code: 'BOT_EXECUTION_INSTANCE_REQUIRED' });
  });
  const memory = new Memory({ root, runtime: async () => { throw new Error('No native memory'); }, embedding: async () => { throw new Error('No embedding'); } });
  const service = new BotService({ root, brain, memory,
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture' }),
    onEvent: () => undefined, ensureCompanionBindings: ensure, ...options });
  owned.push({ service, root });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, conversationId = snapshot.conversations[0]!.id;
  return { service, root, configure: (value = true) => { configured = value; }, ensure, memory, brain, conversationId,
    send: (content = '你好', requestId = 'admission-message') => service.handle({ type: 'message.send', conversationId, content, requestId }) };
}
async function tool(input: BotDshRun, name: string, args: Record<string, unknown>, callId = name) {
  const response = await fetch(input.callback!.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
  return { status: response.status, body: await response.json() };
}
it('synchronizes one native catalogue read for concurrent pickers and retains confirmed history after a transport failure', async () => {
  const f=await fixture(),topics=new BotTopics(f.service.store),selected=topics.create(f.conversationId,'native');
  const sent=f.service.store.enqueue({conversationId:f.conversationId,senderId:'user',sourceMessageId:'native',content:'真实任务'});topics.bind(sent.events,selected);
  const laneId=topics.lane(sent.events[0]!),state:BotNativeTopicState={laneId,sessionId:BotDshBrain.sessionId(laneId),exists:true,title:'原生名称',updatedAt:'2026-11-11T08:00:00.000Z'};
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const read=vi.spyOn(f.brain,'nativeTopics').mockImplementation(async()=>{await held;return[state];});
  expect(await f.service.handle({type:'topic.list',conversationId:f.conversationId})).toMatchObject({topics:[]});expect(read).not.toHaveBeenCalled();
  f.service.store.setMetadata('native-host:'+laneId,'fixture-host');
  const one=f.service.handle({type:'topic.list',conversationId:f.conversationId}),two=f.service.handle({type:'topic.list',conversationId:f.conversationId});
  release();expect(await one).toMatchObject({ok:true,topicListStale:false,topics:[{id:selected.id,title:'原生名称'}]});await two;expect(read).toHaveBeenCalledTimes(1);
  // A newly bound lane invalidates the short read cache immediately.
  const next=topics.create(f.conversationId,'queued'),queued=f.service.store.enqueue({conversationId:f.conversationId,senderId:'user',sourceMessageId:'queued',content:'尚未执行'});topics.bind(queued.events,next);
  f.service.store.setMetadata('native-host:'+topics.lane(queued.events[0]!),'fixture-host');
  read.mockRejectedValue(new Error('Host temporarily disconnected'));
  expect(await f.service.handle({type:'topic.list',conversationId:f.conversationId})).toMatchObject({ok:true,topicListStale:true,topics:[{id:selected.id,title:'原生名称'}]});
  expect(read).toHaveBeenCalledTimes(2);expect(f.brain.calls).toEqual([]);
});
it('keeps another memory domain moving while one background job waits, retaining exclusion in the busy domain', async () => {
  const f = await fixture(); let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.memory, 'finishTurn').mockImplementation(async () => { if (++calls === 1) await held; return { recorded: true }; });
  const scope = { companionId: DEFAULT_BOT_COMPANION_ID, conversationId: f.conversationId, securityDomainId: f.conversationId };
  const enqueue = (key: string, securityDomainId: string) => f.service.store.enqueueMemoryJob({ kind: 'response', key, payload: { scope: { ...scope, securityDomainId }, prepared: {}, text: '', completed: true } });
  const first = enqueue('held-domain', 'one'), same = enqueue('same-domain', 'one'), other = enqueue('other-domain', 'two');
  const maintain = () => (f.service as unknown as { maintain(): Promise<void> }).maintain();
  const pending = maintain();
  try {
    await until(() => f.service.store.getMemoryJob(first.id)?.status === 'running');
    await maintain(); expect(f.service.store.getMemoryJob(other.id)?.status).toBe('done');
    expect(f.service.store.getMemoryJob(same.id)?.status).toBe('queued');
  } finally { release(); await pending; }
  await maintain(); expect(f.service.store.getMemoryJob(same.id)?.status).toBe('done');
});
it('releases worker slots after immediate legacy-job failures so later healthy work can finish', async () => {
  const f = await fixture(), scope = { companionId: DEFAULT_BOT_COMPANION_ID, conversationId: f.conversationId, securityDomainId: f.conversationId };
  const maintain = () => (f.service as unknown as { maintain(): Promise<void> }).maintain();
  for (let index = 0; index < 5; index++) {
    const job = f.service.store.enqueueMemoryJob({ kind: 'response', key: 'legacy-broken-' + index, payload: { scope } });
    f.service.store.taskTransaction(sql => sql.prepare("UPDATE bot_memory_jobs SET kind='legacy-unknown' WHERE id=?").run(job.id));
    await maintain(); expect(f.service.store.getMemoryJob(job.id)?.status).toBe('queued');
  }
  const job = f.service.store.enqueueMemoryJob({ kind: 'response', key: 'healthy-after-failures', payload: { scope, prepared: {}, text: '', completed: true } });
  await maintain(); expect(f.service.store.getMemoryJob(job.id)?.status).toBe('done');
});

it('allows history but requests one shared setup before new chat, world input or transcription', async () => {
  const transcribe = vi.fn(), f = await fixture({ transcribeAttachments: transcribe, prewarmMemory: true });
  await f.service.handle({ type: 'conversation.open', companionId: DEFAULT_BOT_COMPANION_ID });
  await expect(f.send()).rejects.toMatchObject({ code: 'BOT_EXECUTION_INSTANCE_REQUIRED' });
  await expect(f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '', attachmentIds: ['not-resolved'], requestId: 'audio' }))
    .rejects.toMatchObject({ code: 'BOT_EXECUTION_INSTANCE_REQUIRED' });
  await expect(f.service.handle({ type: 'world.event', conversationId: f.conversationId, content: 'test event', requestId: 'world' }))
    .rejects.toMatchObject({ code: 'BOT_EXECUTION_INSTANCE_REQUIRED' });
  expect(f.service.store.messagesPage(f.conversationId).items).toEqual([]);
  expect(transcribe).not.toHaveBeenCalled(); expect(f.brain.calls).toEqual([]); expect(f.memory.prepared).toBe(0); expect(f.memory.warmed).toBe(0);
});

it('admits chat after the shared selection without requiring a running Host for native admission', async () => {
  const f = await fixture(); f.configure();
  const response = await f.send();
  await until(() => f.service.store.getMessage(response.replyMessageIds![0]!)?.status === 'sent');
  expect(f.ensure).toHaveBeenCalledWith([DEFAULT_BOT_COMPANION_ID]);
  expect(f.service.store.messagesPage(f.conversationId).items.map(value => value.content)).toEqual(['你好', '已收到']);
});

it('admits all group native agents after one shared setup, including a newly created companion', async () => {
  const f = await fixture();
  const second = await f.service.handle({ type: 'companion.create', name: 'Beta', persona: 'Beta' });
  const beta = f.service.store.getConversation(second.conversationId!)!.memberIds.find(id => id !== 'user')!;
  const group = await f.service.handle({ type: 'conversation.create', title: 'Binding group', kind: 'group', memberIds: [DEFAULT_BOT_COMPANION_ID, beta], participationMode: 'all' });
  const request = { type: 'message.send' as const, conversationId: group.conversationId!, content: '请各自回答', requestId: 'group-draft' };
  await expect(f.service.handle(request)).rejects.toMatchObject({ code: 'BOT_EXECUTION_INSTANCE_REQUIRED' });
  expect(f.service.store.messagesPage(group.conversationId!).items).toHaveLength(0); expect(f.brain.calls).toHaveLength(0);
  expect(f.ensure.mock.calls.at(-1)![0]).toEqual(expect.arrayContaining([DEFAULT_BOT_COMPANION_ID, beta]));
  f.configure(); const sent = await f.service.handle(request);
  await until(() => sent.replyMessageIds!.every(id => f.service.store.getMessage(id)?.status === 'sent'));
  expect(f.service.store.messagesPage(group.conversationId!).items.filter(value => value.senderId === 'user')).toHaveLength(1);
  expect(new Set(f.brain.calls.filter(call => !call.laneId.startsWith('memory-encoder-')).map(call => f.service.store.getEvent(call.eventId)?.companionId)))
    .toEqual(new Set([DEFAULT_BOT_COMPANION_ID, beta]));
});

it('settles an old inbox once when shared setup is missing without repeatedly retrying the model', async () => {
  const f = await fixture();
  const ingress = f.service.store.enqueue({ conversationId: f.conversationId, senderId: 'user', source: 'user', sourceMessageId: 'legacy-event', content: '旧版排队消息' });
  await until(() => f.service.store.getEvent(ingress.events[0]!.id)?.status === 'failed');
  expect(f.service.store.getEvent(ingress.events[0]!.id)?.attempts).toBe(1);
  expect(f.service.store.getMessage(ingress.events[0]!.replyMessageId)?.error).toContain('共享 DSH');
  expect(f.brain.calls).toHaveLength(0); expect(f.memory.prepared).toBe(0);
  f.configure(); const next = await f.send('配置后的新消息', 'new-after-setup');
  await until(() => f.service.store.getMessage(next.replyMessageIds![0]!)?.status === 'sent');
  expect(f.service.store.getEvent(ingress.events[0]!.id)?.attempts).toBe(1);
});

it('contacts a new peer without a separate instance or credential setup', async () => {
  const outcomes: Awaited<ReturnType<typeof tool>>[] = []; let target = '', dispatched = false;
  const brain = new Brain(async input => {
    if (dispatched) return '协作已收到';
    dispatched = true;
    outcomes.push(await tool(input, 'companion_contact', { companionId: target, destination: 'peer', message: '请协作' }));
    outcomes.push(await tool(input, 'message_peer', { companionId: target, content: '请参与' }));
    return '已交接';
  });
  const f = await fixture({}, brain); f.configure();
  const second = await f.service.handle({ type: 'companion.create', name: 'New peer', persona: 'Beta' });
  target = f.service.store.getConversation(second.conversationId!)!.memberIds.find(id => id !== 'user')!;
  const previousRooms = f.service.store.conversations().length;
  const sent = await f.send('开始协作测试'); await until(() => f.service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'sent');
  expect(outcomes).toHaveLength(2);
  for (const result of outcomes.slice(0, 1)) expect(result, JSON.stringify(outcomes)).toMatchObject({ status: 200, body: { ok: true } });
  // The lower-level room message tool still cannot address a non-member of
  // this direct chat; shared execution does not bypass room authorization.
  expect(outcomes[1]).toMatchObject({ status: 400, body: { ok: false, error: '事件目标不是合法会话伙伴。' } });
  expect(f.service.store.conversations().length).toBeGreaterThan(previousRooms);
  await until(() => f.brain.calls.some(call => f.service.store.getEvent(call.eventId)?.companionId === target));
  expect(f.service.store.messagesPage(second.conversationId!).items).toHaveLength(0);
});

it('does not start group attention while the one shared execution selection is missing', async () => {
  const f = await fixture();
  const second = await f.service.handle({ type: 'companion.create', name: 'Beta', persona: 'Beta' });
  const beta = f.service.store.getConversation(second.conversationId!)!.memberIds.find(id => id !== 'user')!;
  const group = await f.service.handle({ type: 'conversation.create', kind: 'group', title: 'Legacy group', memberIds: [DEFAULT_BOT_COMPANION_ID, beta], participationMode: 'automatic' });
  const ingress = f.service.store.enqueue({ conversationId: group.conversationId!, senderId: 'user', source: 'user', sourceMessageId: 'legacy-group-event', content: '请大家协作' });
  await until(() => ingress.events.every(event => f.service.store.getEvent(event.id)?.status === 'failed'));
  expect(f.brain.calls).toHaveLength(0); expect(f.memory.prepared).toBe(0);
  for (const event of ingress.events) expect(f.service.store.getEvent(event.id)?.attempts).toBe(1);
});

it('does not enable a disabled character when the shared setup is unavailable', async () => {
  const start = vi.fn(), f = await fixture({ companionRuntime: start });
  f.service.store.setCompanionEnabled(DEFAULT_BOT_COMPANION_ID, false);
  await expect(f.service.handle({ type: 'companion.runtime', companionId: DEFAULT_BOT_COMPANION_ID, operation: 'start' }))
    .rejects.toMatchObject({ code: 'BOT_EXECUTION_INSTANCE_REQUIRED' });
  expect(f.service.store.getCompanion(DEFAULT_BOT_COMPANION_ID)?.enabled).toBe(false); expect(start).not.toHaveBeenCalled();
});
