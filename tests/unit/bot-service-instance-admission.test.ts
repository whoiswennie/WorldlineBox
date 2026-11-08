import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotService, type BotServiceOptions } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

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
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-bot-admission-')), bound = new Set<string>();
  const ensure = vi.fn(async (ids: string[]) => {
    const missing = ids.filter(id => !bound.has(id));
    if (missing.length) throw Object.assign(new Error(`请先为伙伴绑定专属 DSH 实例：${missing.join('、')}`), { code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  });
  const memory = new Memory({ root, runtime: async () => { throw new Error('No native memory'); }, embedding: async () => { throw new Error('No embedding'); } });
  const service = new BotService({ root, brain, memory, brainRuntime: 'worldlinebox',
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture' }),
    onEvent: () => undefined, ensureCompanionBindings: ensure, ...options });
  owned.push({ service, root });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, conversationId = snapshot.conversations[0]!.id;
  return { service, root, bound, ensure, memory, brain, conversationId,
    send: (content = '你好', requestId = 'admission-message') => service.handle({ type: 'message.send', conversationId, content, requestId }) };
}
async function tool(input: BotDshRun, name: string, args: Record<string, unknown>, callId = name) {
  const response = await fetch(input.callback!.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
  return { status: response.status, body: await response.json() };
}

it('allows opening history but blocks unbound private chat, world input and audio transcription before persistence', async () => {
  const transcribe = vi.fn(), f = await fixture({ transcribeAttachments: transcribe, prewarmMemory: true });
  await f.service.handle({ type: 'conversation.open', companionId: DEFAULT_BOT_COMPANION_ID });
  await expect(f.send()).rejects.toMatchObject({ code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  await expect(f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '', attachmentIds: ['not-resolved'], requestId: 'audio' }))
    .rejects.toMatchObject({ code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  await expect(f.service.handle({ type: 'world.event', conversationId: f.conversationId, content: 'test event', requestId: 'world' }))
    .rejects.toMatchObject({ code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  expect(f.service.store.messagesPage(f.conversationId).items).toEqual([]);
  expect(transcribe).not.toHaveBeenCalled(); expect(f.brain.calls).toEqual([]); expect(f.memory.prepared).toBe(0); expect(f.memory.warmed).toBe(0);
});

it('admits a new private chat after explicit binding without requiring a running Host for the Router', async () => {
  const f = await fixture(); f.bound.add(DEFAULT_BOT_COMPANION_ID);
  const response = await f.send();
  await until(() => f.service.store.getMessage(response.replyMessageIds![0]!)?.status === 'sent');
  expect(f.ensure).toHaveBeenCalledWith([DEFAULT_BOT_COMPANION_ID]);
  expect(f.service.store.messagesPage(f.conversationId).items.map(value => value.content)).toEqual(['你好', '已收到']);
});

it('requires every group member binding before creating any user message, then admits the same retained draft', async () => {
  const f = await fixture();
  const second = await f.service.handle({ type: 'companion.create', name: 'Beta', persona: 'Beta' });
  const beta = f.service.store.getConversation(second.conversationId!)!.memberIds.find(id => id !== 'user')!;
  const group = await f.service.handle({ type: 'conversation.create', title: 'Binding group', kind: 'group', memberIds: [DEFAULT_BOT_COMPANION_ID, beta], participationMode: 'all' });
  f.bound.add(DEFAULT_BOT_COMPANION_ID);
  const request = { type: 'message.send' as const, conversationId: group.conversationId!, content: '请各自回答', requestId: 'group-draft' };
  await expect(f.service.handle(request)).rejects.toMatchObject({ code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  expect(f.service.store.messagesPage(group.conversationId!).items).toHaveLength(0); expect(f.brain.calls).toHaveLength(0);
  expect(f.ensure.mock.calls.at(-1)![0]).toEqual(expect.arrayContaining([DEFAULT_BOT_COMPANION_ID, beta]));
  f.bound.add(beta); const sent = await f.service.handle(request);
  await until(() => sent.replyMessageIds!.every(id => f.service.store.getMessage(id)?.status === 'sent'));
  expect(f.service.store.messagesPage(group.conversationId!).items.filter(value => value.senderId === 'user')).toHaveLength(1);
  expect(new Set(f.brain.calls.filter(call => !call.laneId.startsWith('memory-encoder-')).map(call => f.service.store.getEvent(call.eventId)?.companionId)))
    .toEqual(new Set([DEFAULT_BOT_COMPANION_ID, beta]));
});

it('settles a persisted legacy inbox event once without memory or model work when its binding is missing', async () => {
  const f = await fixture();
  const ingress = f.service.store.enqueue({ conversationId: f.conversationId, senderId: 'user', source: 'user', sourceMessageId: 'legacy-event', content: '旧版排队消息' });
  await until(() => f.service.store.getEvent(ingress.events[0]!.id)?.status === 'failed');
  expect(f.service.store.getEvent(ingress.events[0]!.id)?.attempts).toBe(1);
  expect(f.service.store.getMessage(ingress.events[0]!.replyMessageId)?.error).toContain('绑定专属');
  expect(f.brain.calls).toHaveLength(0); expect(f.memory.prepared).toBe(0);
  f.bound.add(DEFAULT_BOT_COMPANION_ID); const next = await f.send('绑定后的新消息', 'new-after-bind');
  await until(() => f.service.store.getMessage(next.replyMessageIds![0]!)?.status === 'sent');
  expect(f.service.store.getEvent(ingress.events[0]!.id)?.attempts).toBe(1);
});

it('rejects contact and formal delegation to an unbound peer without creating its room, files or tasks', async () => {
  const outcomes: Awaited<ReturnType<typeof tool>>[] = []; let target = '';
  const brain = new Brain(async input => {
    outcomes.push(await tool(input, 'companion_contact', { companionId: target, destination: 'peer', message: '请协作' }));
    outcomes.push(await tool(input, 'companion_delegate', { companionId: target, title: '协作', goal: '仅分析当前目标' }));
    outcomes.push(await tool(input, 'message_peer', { companionId: target, content: '请参与' }));
    return '对方尚未配置';
  });
  const f = await fixture({}, brain); f.bound.add(DEFAULT_BOT_COMPANION_ID);
  const second = await f.service.handle({ type: 'companion.create', name: 'Unbound peer', persona: 'Beta' });
  target = f.service.store.getConversation(second.conversationId!)!.memberIds.find(id => id !== 'user')!;
  const previousRooms = f.service.store.conversations().length;
  const sent = await f.send(); await until(() => f.service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'sent');
  expect(outcomes).toHaveLength(3);
  for (const result of outcomes) expect(result).toMatchObject({ status: 400, body: { ok: false, error: expect.stringContaining('绑定专属') } });
  expect(f.service.store.conversations()).toHaveLength(previousRooms); expect(f.service.store.listTasks()).toHaveLength(0);
  expect(f.service.store.messagesPage(second.conversationId!).items).toHaveLength(0);
});

it('does not run group attention or a bound member Router while another persisted group member is unbound', async () => {
  const f = await fixture(); f.bound.add(DEFAULT_BOT_COMPANION_ID);
  const second = await f.service.handle({ type: 'companion.create', name: 'Beta', persona: 'Beta' });
  const beta = f.service.store.getConversation(second.conversationId!)!.memberIds.find(id => id !== 'user')!;
  const group = await f.service.handle({ type: 'conversation.create', kind: 'group', title: 'Legacy group', memberIds: [DEFAULT_BOT_COMPANION_ID, beta], participationMode: 'automatic' });
  const ingress = f.service.store.enqueue({ conversationId: group.conversationId!, senderId: 'user', source: 'user', sourceMessageId: 'legacy-group-event', content: '请大家协作' });
  await until(() => ingress.events.every(event => f.service.store.getEvent(event.id)?.status === 'failed'));
  expect(f.brain.calls).toHaveLength(0); expect(f.memory.prepared).toBe(0);
  for (const event of ingress.events) expect(f.service.store.getEvent(event.id)?.attempts).toBe(1);
});

it('pauses a persisted worker task with its progress intact and permits cancellation without a binding', async () => {
  const f = await fixture();
  const ingress = f.service.store.enqueue({ conversationId: f.conversationId, senderId: 'user', source: 'user', sourceMessageId: 'legacy-worker', content: '继续原任务' });
  const task = f.service.store.createTask({ conversationId: f.conversationId, companionId: DEFAULT_BOT_COMPANION_ID,
    sourceEventId: ingress.events[0]!.id, goal: '保留旧进展', extra: { nativeAttempted: true, checkpoint: 'retained' } });
  f.service.store.updateTask(task.id, { summary: '已保存的成果', sessionId: 'original-native-session' });
  await until(() => f.service.store.getTask(task.id)?.status === 'paused');
  expect(f.service.store.getTask(task.id)).toMatchObject({ summary: '已保存的成果', sessionId: 'original-native-session', extra: { checkpoint: 'retained', executorInterruptionCount: 1 } });
  expect(f.brain.calls).toHaveLength(0);
  await expect(f.service.handle({ type: 'task.control', conversationId: f.conversationId, taskId: task.id, operation: 'resume_paused', requestId: 'resume-blocked' }))
    .rejects.toMatchObject({ code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  const stopped = await f.service.handle({ type: 'task.control', conversationId: f.conversationId, taskId: task.id, operation: 'cancel', requestId: 'cancel-allowed' });
  expect(stopped.ok).toBe(true); expect(f.service.store.getTask(task.id)?.status).toBe('cancelled'); expect(f.brain.calls).toHaveLength(0);
});

it('does not enable an unbound disabled character when its explicit start is rejected', async () => {
  const start = vi.fn(), f = await fixture({ companionRuntime: start });
  f.service.store.setCompanionEnabled(DEFAULT_BOT_COMPANION_ID, false);
  await expect(f.service.handle({ type: 'companion.runtime', companionId: DEFAULT_BOT_COMPANION_ID, operation: 'start' }))
    .rejects.toMatchObject({ code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  expect(f.service.store.getCompanion(DEFAULT_BOT_COMPANION_ID)?.enabled).toBe(false); expect(start).not.toHaveBeenCalled();
});
