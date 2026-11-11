import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshResult, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryForget, type BotMemoryPrepared, type BotMemoryScope } from '../../src/main/companion-bot/memory-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function owned(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith(prefix)) throw Error('Invalid peer test profile');
  return root;
}
async function storeFixture() {
  const root = await owned('bot-peer-store-'), store = new BotStore(path.join(root, 'bot.sqlite'));
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  for (const [id, name] of [['origin', 'GPT'], ['target', '大肥鱼'], ['third', '第三位']]) store.createCompanion({ id: id!, name: name!, persona: name! });
  const direct = store.openDirect('origin'), targetPrivate = store.openDirect('target');
  const source = store.enqueue({ conversationId: direct.id, senderId: 'user', source: 'user', content: '请让大肥鱼给我发晚安', sourceMessageId: 'user-request' }).events[0]!;
  return { store, direct, targetPrivate, source };
}
it('creates an observer-visible real pair private room without expanding either user-private audience and deduplicates a contact call', async () => {
  const { store, direct, targetPrivate, source } = await storeFixture();
  const first = store.contactPeer(source, 'target', 'contact-1', '用户请你说晚安');
  const repeated = store.contactPeer(source, 'target', 'contact-1', '用户请你说晚安');
  expect(first.accepted).toBe(true); expect(repeated.accepted).toBe(true); expect(repeated.conversationId).toBe(first.conversationId);
  expect(repeated.accepted && first.accepted && repeated.message.id === first.message.id).toBe(true);
  const room = store.getConversation(first.conversationId)!;
  expect(room).toMatchObject({ kind: 'peer', userRole: 'observer', title: 'GPT × 大肥鱼' });
  expect(room.memberIds).toEqual(['origin', 'target']);
  expect(room.securityDomainId).not.toBe(direct.securityDomainId); expect(room.securityDomainId).not.toBe(targetPrivate.securityDomainId);
  expect(store.getConversation(direct.id)!.memberIds).toEqual(['origin', 'user']);
  expect(store.getConversation(targetPrivate.id)!.memberIds).toEqual(['target', 'user']);
  expect(store.messagesPage(room.id).items.filter(item => item.senderId === 'origin' && item.status === 'sent')).toHaveLength(1);
  const targets = store.peerWithdrawalTargets('origin', direct.securityDomainId); expect(targets).toEqual([]);
  store.withdrawSources('origin', direct.securityDomainId, [source.id]);
  expect(store.peerWithdrawalTargets('origin', direct.securityDomainId)).toEqual([{ conversationId: room.id, messageId: first.accepted ? first.message.id : '' }]);
});
it('allows participant-initiated contact while rejecting system notices, withdrawn requests, and changed audiences', async () => {
  const { store, direct, source } = await storeFixture();
  expect(() => store.enqueue({ conversationId: direct.id, senderId: 'task-service', source: 'task', content: '旧任务入站' })).toThrow('旧任务中心消息入口已停用');
  const group = store.createGroup({ title: '普通群', memberIds: ['origin', 'third'] });
  const peer = store.enqueue({ conversationId: group.id, senderId: 'third', source: 'companion', content: '联系其他域', recipientIds: ['origin'] }).events[0]!;
  expect(store.contactPeer(peer, 'target', 'peer-contact', '请帮忙完成本次任务')).toMatchObject({accepted:true});
  const contact = store.contactPeer(source, 'target', 'first-contact', '用户请你说晚安');
  store.taskTransaction(sql => sql.prepare('INSERT INTO bot_members VALUES(?,?)').run(contact.conversationId, 'third'));
  expect(() => store.contactPeer(source, 'target', 'new-contact', '不向已加入第三人的空间转发')).toThrow('固定双方发生变化');
  store.withdrawSources('origin', direct.securityDomainId, [source.id]);
  expect(() => store.contactPeer(source, 'target', 'withdrawn-contact', '来源已撤回')).toThrow('来源已撤回');
});

class MemoryBoundary extends BotMemoryService {
  preparations: Array<Parameters<BotMemoryService['prepareTurn']>[0]> = [];
  withdrawals: Array<{ scope: BotMemoryScope; sourceEventIds: string[]; sourceMessageIds: string[]; mode?: 'isolated-task-notices' }> = [];
  forgotten?: BotMemoryForget;
  private prepared = new Map<string, BotMemoryPrepared>();
  constructor(root: string) { super({ root, runtime: async () => { throw Error('Unexpected real memory runtime in a control-plane test'); }, embedding: async () => { throw Error('Unexpected embedding provider'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]) {
    this.preparations.push(input);
    const result: BotMemoryPrepared = { requestId: input.requestId, inputHash: 'test-boundary', scope: input.scope,
      messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
    this.prepared.set(input.requestId, result); return result;
  }
  override async resumePrepared(input: Parameters<BotMemoryService['resumePrepared']>[0]) { return this.prepared.get(input.requestId)!; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { appended: [] }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async withdrawSources(scope: BotMemoryScope, sources: { sourceEventIds: string[]; sourceMessageIds: string[]; mode?: 'isolated-task-notices' }) {
    this.withdrawals.push({ scope, ...sources }); return { withdrawn: true as const, revision: '1', ...sources };
  }
  override async forget() { if (!this.forgotten) throw Error('Missing explicit fixture withdrawal'); return this.forgotten; }
}
class BrainBoundary extends BotDshBrain {
  calls: BotDshRun[] = [];
  constructor(private handler: (input: BotDshRun) => Promise<string>) { super({ getHost: async () => { throw Error('Peer messaging must not start DSH'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    if (input.laneId.startsWith('memory-encoder-')) return { text: '{"notes":[]}', sessionId: input.laneId, eventId: input.eventId, status: 'succeeded' };
    if (input.laneId.startsWith('group-attention-')) return { text: '{"recipients":[],"reason":"已有充分回应"}', sessionId: input.laneId, eventId: input.eventId, status: 'succeeded' };
    this.calls.push(input); const text = await this.handler(input);
    return { text, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded' };
  }
  override async cancelDurable() { return { accepted: true, absent: true }; }
  override async close() {}
}
async function invoke(input: BotDshRun, companionId: string) {
  const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId: 'contact-once', name: 'companion_contact', args: { companionId, destination: 'peer', message: '本次明确请求：请在双方伙伴私聊里交流晚安。' } }) });
  const body = await response.json() as { ok: boolean; error?: string; result?: { sent: boolean; conversationId: string } };
  expect(response.status, body.error).toBe(200); expect(body.ok, body.error).toBe(true); return body.result!;
}
async function serviceFixture(handler: (input: BotDshRun) => Promise<string>) {
  const root = await owned('bot-peer-service-'), brain = new BrainBoundary(handler), memory = new MemoryBoundary(root);
  const service = new BotService({ root, brain, memory,
    model: () => ({ model: 'local-control-plane-fixture', apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:9', apiKey: 'not-a-provider-key' }), onEvent: () => undefined });
  cleanup.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  const state = (await service.handle({ type: 'state' })).snapshot!;
  const sourceCompanion = service.store.createCompanion({ id: 'native-peer-source', name: 'GPT', persona: 'GPT的独立角色' });
  const direct = (await service.handle({ type: 'conversation.open', companionId: sourceCompanion.id })).conversationId!;
  const targetDirect = state.conversations.find(item => item.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!.id;
  return { service, brain, memory, direct, targetDirect, sourceId: sourceCompanion.id, targetId: DEFAULT_BOT_COMPANION_ID };
}
async function message(service: BotService, conversationId: string, content: string, requestId: string) {
  return service.handle({ type: 'message.send', conversationId, content, requestId });
}
it('runs the destination independently in a real peer private room, without either user-private history, and requires a new group for user participation', async () => {
  let roomId = '', originLane = '', sourceId = '', targetId = '';
  const f = await serviceFixture(async input => {
    const context = JSON.parse(input.prompt);
    if (context.message.content === '请让大肥鱼给我发晚安') {
      expect(context.room.members).toContain('user');
      expect(context.peerContact).toBeUndefined();
      originLane = input.laneId;
      const sent = await invoke(input, targetId); expect(await invoke(input, targetId)).toEqual(sent); roomId = sent.conversationId;
      return '我去喊她了。';
    }
    if (context.message.senderId !== 'user') {
      expect(context.identity.id).toBe(targetId); expect(input.system).toContain('大肥鱼');
      expect(context.room.members).toEqual(expect.arrayContaining([sourceId, targetId]));
      expect(context.room.members.includes('user')).toBe(false);
      expect(context.room).toMatchObject({ kind: 'peer' });
      expect(context.peerContact).toBeDefined();
      expect(context.message.senderId).toBe(sourceId);
      expect(context.message.content).toBe('本次明确请求：请在双方伙伴私聊里交流晚安。');
      expect(input.prompt).not.toContain('GPT私聊秘密'); expect(input.prompt).not.toContain('大肥鱼私聊秘密');
      return '晚安，明天见。';
    }
    if (context.message.content === '@所有人 谢谢你们') {
      expect(context.message.senderId).toBe('user');
      expect(context.room.members).toContain('user'); expect(context.peerContact).toBeUndefined();
    }
    return context.room.kind === 'group' ? '大家都听见啦。' : '这是我们私聊里的回应。';
  });
  sourceId = f.sourceId; targetId = f.targetId;
  await message(f.service, f.direct, 'GPT私聊秘密', 'private-source');
  await message(f.service, f.targetDirect, '大肥鱼私聊秘密', 'private-target');
  await vi.waitFor(() => expect(f.brain.calls).toHaveLength(2));
  await message(f.service, f.direct, '请让大肥鱼给我发晚安', 'contact');
  await vi.waitFor(() => expect(roomId).not.toBe(''));
  await vi.waitFor(() => expect(f.service.store.messagesPage(roomId).items.some(item => item.content === '晚安，明天见。' && item.senderId === targetId)).toBe(true));
  const room = f.service.store.getConversation(roomId)!;
  expect(room.kind).toBe('peer'); expect(room.userRole).toBe('observer'); expect(room.memberIds).toEqual([sourceId, targetId].sort());
  const target = f.brain.calls.find(input => JSON.parse(input.prompt).message.senderId !== 'user')!;
  expect(target.laneId).not.toBe(originLane); expect(JSON.parse(target.prompt).room.id).toBe(room.id);
  expect(f.service.store.messagesPage(f.direct).items.some(item => item.senderId === targetId)).toBe(false);
  expect(f.service.store.messagesPage(roomId).items.filter(item => item.senderId === sourceId && item.content.includes('明确请求'))).toHaveLength(1);
  await expect(message(f.service, roomId, '谢谢你们', 'observer-cannot-speak')).rejects.toThrow('旁观');
  expect(await f.service.handle({ type: 'conversation.pin', conversationId: roomId, pinned: true })).toEqual({ ok: true });
  expect((await f.service.handle({ type: 'state' })).snapshot!.conversations[0]).toMatchObject({ id: roomId, pinned: true });
  expect(f.service.store.getConversation(roomId)!.memberIds).toEqual([sourceId, targetId].sort());
  const joined = (await f.service.handle({ type: 'conversation.peer.join', conversationId: roomId })).conversationId!;
  expect(f.service.store.getConversation(joined)!.memberIds).toEqual(['user', sourceId, targetId].sort());
  expect(f.service.store.getConversation(roomId)!.memberIds).toEqual([sourceId, targetId].sort());
  await message(f.service, joined, '@所有人 谢谢你们', 'user-joins');
  await vi.waitFor(() => expect(f.brain.calls.some(input => JSON.parse(input.prompt).message.content === '@所有人 谢谢你们')).toBe(true));
  expect(f.memory.preparations.filter(item => item.scope.conversationId === roomId).every(item => !JSON.stringify(item.messages).includes('私聊秘密'))).toBe(true);
});
it('propagates source withdrawal to both room actors, durable outboxes and an already-running target', async () => {
  let roomId = '', targetId = '', targetStarted = false, targetAborted = false;
  const f = await serviceFixture(async input => {
    const context = JSON.parse(input.prompt);
    if (context.message.senderId === 'user') { roomId = (await invoke(input, targetId)).conversationId; return '已经联系。'; }
    targetStarted = true;
    await new Promise<void>((resolve, reject) => {
      if (input.signal?.aborted) { targetAborted = true; reject(input.signal.reason); return; }
      input.signal?.addEventListener('abort', () => { targetAborted = true; reject(input.signal!.reason); }, { once: true });
    });
    return '撤回后不应发布的回应';
  });
  targetId = f.targetId;
  const sent = await message(f.service, f.direct, '请联系大肥鱼', 'withdraw-contact');
  await vi.waitFor(() => expect(targetStarted).toBe(true));
  const source = f.service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').get(sent.messageId!)) as { id: string };
  const original = f.service.store.getEvent(source.id)!;
  const room = f.service.store.getConversation(roomId)!;
  const introduced = f.service.store.messagesPage(roomId).items.find(item => item.senderId === f.sourceId && item.status === 'sent')!;
  f.memory.forgotten = { forgotten: true, id: 'a'.repeat(64), revision: '1', sourceEventIds: [original.id], sourceMessageIds: [original.sourceMessageRecordId], relatedIds: [], physicalSourceErasure: false };
  await f.service.handle({ type: 'memory.forget', conversationId: f.direct, companionId: f.sourceId, id: 'a'.repeat(64) });
  await vi.waitFor(() => expect(targetAborted).toBe(true));
  for (const companionId of [f.sourceId, f.targetId]) {
    expect(f.service.store.withdrawnIn(companionId, room.securityDomainId, [introduced.id]).has(introduced.id)).toBe(true);
    expect(f.service.store.withdrawnMessagesPage({ companionId, conversationId: room.id, securityDomainId: room.securityDomainId }).items.some(item => item.messageId === introduced.id)).toBe(true);
    await vi.waitFor(() => expect(f.memory.withdrawals.some(item => item.scope.companionId === companionId && item.scope.securityDomainId === room.securityDomainId && item.sourceMessageIds.includes(introduced.id))).toBe(true));
  }
  expect(f.service.store.messagesPage(roomId).items.some(item => item.content === '撤回后不应发布的回应' && item.status === 'sent')).toBe(false);
});
