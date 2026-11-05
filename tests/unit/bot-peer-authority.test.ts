import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { buildBotContext } from '../../src/main/companion-bot/context';
import { BOT_TOOLS } from '../../src/main/companion-bot/tools';
import type { BotRequest } from '../../src/shared/companion-bot';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const actors = (store: BotStore) => { for (const id of ['alice', 'bob', 'carol']) store.createCompanion({ id, name: id, persona: `${id}公开角色` }); };
function memory(root: string) { return new BotMemoryService({ root, runtime: async () => { throw Error('No native memory in authority fixture'); }, embedding: async () => { throw Error('No embedding'); } }); }
function source(store: BotStore, content = '请让bob跟我说下午好') {
  const direct = store.openDirect('alice');
  const result = store.enqueue({ conversationId: direct.id, senderId: 'user', recipientIds: ['alice'], sourceMessageId: `source-${content}`, content });
  return { direct, event: result.events[0]! };
}
function storeFixture() { const store = new BotStore(':memory:'); actors(store); closes.push(async () => store.close()); return store; }

it('uses a stable real two-companion private domain and preserves existing user-member groups', () => {
  const store = storeFixture(), legacy = store.createGroup({ title: '旧伙伴群', memberIds: ['alice', 'bob'] });
  store.setMetadata(`peer-conversation:${legacy.id}`, '1');
  const peer = store.openPeer('alice', 'bob');
  expect(store.openPeer('bob', 'alice')).toEqual(peer);
  expect(peer).toMatchObject({ kind: 'peer', userRole: 'observer', memberIds: ['alice', 'bob'], participationMode: 'automatic' });
  expect(peer.securityDomainId).not.toBe(legacy.securityDomainId);
  expect(peer.securityDomainId).not.toBe(store.openDirect('alice').securityDomainId);
  expect(peer.securityDomainId).not.toBe(store.openDirect('bob').securityDomainId);
  expect(store.getConversation(legacy.id)).toMatchObject({ kind: 'group', peerConversation: true, memberIds: ['alice', 'bob', 'user'] });
  expect(store.messagesPage(peer.id).items).toEqual([]);
  expect(() => store.openPeer('alice', 'alice')).toThrow('两位');
  expect(() => store.openPeer('alice', 'missing')).toThrow('有效伙伴');
  expect(() => store.createGroup({ kind: 'peer', title: '不能绕过双方约束', memberIds: ['alice', 'bob', 'carol'] })).toThrow('固定双方');
  expect(() => store.enqueue({ conversationId: peer.id, senderId: 'user', content: '冒充参与' })).toThrow('发送者');
});

it('contacts in the real peer channel and permits only the recipient to publish one requested user-facing answer', () => {
  const store = storeFixture(), { direct, event } = source(store, '无关私聊秘密。请让bob跟我说下午好'), target = store.openDirect('bob');
  store.enqueue({ conversationId: target.id, senderId: 'user', content: 'bob自己的私聊秘密', recipientIds: [] });
  const delivered = store.contactPeer(event, 'bob', 'contact-user', '请直接对用户说下午好', 'user');
  expect(delivered.accepted).toBe(true); if (!delivered.accepted) throw Error('Expected delivery');
  const peer = store.getConversation(delivered.conversationId)!;
  expect(peer).toMatchObject({ kind: 'peer', memberIds: ['alice', 'bob'], userRole: 'observer' });
  expect(delivered.message).toMatchObject({ senderId: 'alice', senderType: 'companion', content: '请直接对用户说下午好' });
  expect(delivered.events[0]).toMatchObject({ source: 'companion', companionId: 'bob', payload: { responseDestination: 'user-direct', userRequestedContact: true } });
  expect(store.getConversation(target.id)!.memberIds).toEqual(['bob', 'user']);
  expect(store.getConversation(direct.id)!.memberIds).toEqual(['alice', 'user']);
  expect(store.messagesPage(target.id).items.some(message => message.senderId === 'alice')).toBe(false);
  expect(store.conversations().filter(room => room.kind === 'peer')).toHaveLength(1);
  expect(store.contactPeer(event, 'bob', 'contact-user', '请直接对用户说下午好', 'user')).toMatchObject({ message: { id: delivered.message.id }, events: [] });
  expect(() => store.contactPeer(event, 'bob', 'contact-user', '请直接对用户说下午好', 'peer')).toThrow('目的地');
  expect(() => store.enqueue({ conversationId: target.id, senderId: 'alice', source: 'companion', recipientIds: ['bob'], content: '无宿主来源的越权投递' })).toThrow('发送者');
  expect(() => store.enqueue({ conversationId: target.id, senderId: 'alice', source: 'companion', recipientIds: ['bob'], content: '旧例外也不能跨入', contactSourceEventId: event.id, causationId: event.id, correlationId: event.correlationId })).toThrow('发送者');
  const context = JSON.parse(buildBotContext({ companion: store.getCompanion('bob')!, event: delivered.events[0]!, conversation: peer,
    participants: [store.getCompanion('alice')!, store.getCompanion('bob')!], messages: store.messagesPage(direct.id).items }).user);
  expect(context.peerContact).toMatchObject({ responseDestination: 'user-direct', userPresent: false, privateHistoryTransferred: false });
  expect(context.room.members).toEqual([{ id: 'alice', name: 'alice' }, { id: 'bob', name: 'bob' }]);
  expect(JSON.stringify(context)).not.toContain('无关私聊秘密');
  const claimed = store.claim({ workerId: 'recipient', excludeLaneIds: [event.laneId] })!;
  expect(claimed.event.id).toBe(delivered.events[0]!.id);
  const answer = store.replyPeerToUser(claimed.event, 'answer-user', '下午好，我是bob。');
  expect(answer).toMatchObject({ sent: true, conversationId: target.id, senderId: 'bob', recipientId: 'user' });
  expect(store.replyPeerToUser(claimed.event, 'answer-user', '下午好，我是bob。')).toEqual(answer);
  expect(store.replyPeerToUser(claimed.event, 'answer-user-again', '下午好，我是bob。')).toEqual(answer);
  expect(() => store.replyPeerToUser(claimed.event, 'different-answer', '第二条不在本次授权内。')).toThrow('已经发送');
  expect(store.messagesPage(target.id).items.filter(message => message.senderId === 'bob')).toHaveLength(1);
  expect(store.messagesPage(target.id).items.find(message => message.id === answer.messageId)).toMatchObject({ content: '下午好，我是bob。', senderType: 'companion', senderId: 'bob' });
  expect(() => store.replyPeerToUser(event, 'forged', 'alice不能用bob的授权')).toThrow('有效授权');
  store.withdrawSources('alice', direct.securityDomainId, [event.id]);
  expect(store.peerWithdrawalTargets('alice', direct.securityDomainId)).toEqual(expect.arrayContaining([
    { conversationId: peer.id, messageId: delivered.message.id }, { conversationId: target.id, messageId: answer.messageId }]));
  expect(() => store.contactPeer(event, 'bob', 'after-withdrawal', '不能转达', 'user')).toThrow('撤回');
});

it('exposes observer history but denies all participation and control endpoints, while joining creates a distinct user-owned group', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-peer-authority-'));
  const brain = new BotDshBrain({ getHost: async () => { throw Error('Observer must not start DSH'); } });
  const service = new BotService({ root, brain, brainRuntime: 'worldlinebox', memory: memory(path.join(root, 'memory')),
    model: () => { throw Error('No provider configured'); }, onEvent: () => undefined });
  closes.push(async () => { await service.shutdown(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-peer-authority-')) throw Error('Invalid owned fixture'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' }); actors(service.store);
  const response = await service.handle({ type: 'conversation.peer.open', memberIds: ['alice', 'bob'] }), peerId = response.conversationId!;
  const peer = service.store.getConversation(peerId)!;
  const message = service.store.enqueue({ conversationId: peerId, senderId: 'alice', source: 'companion', recipientIds: [], content: '双方已公开给旁观者的私聊记录' }).message;
  const queued = service.store.enqueue({ conversationId: peerId, senderId: 'alice', source: 'companion', recipientIds: ['bob'], content: 'bob稍后回答' }).events[0]!;
  const task = service.store.createTask({ id: 'peer-task', conversationId: peerId, companionId: 'bob', sourceEventId: queued.id, goal: '不可由旁观者控制的任务', extra: { nativeAttempted: true, retryAt: Date.now() + 60000 } });
  const snapshot = (await service.handle({ type: 'state', conversationId: peerId })).snapshot!;
  expect(snapshot.conversations.find(room => room.id === peerId)).toMatchObject({ userRole: 'observer', memberIds: ['alice', 'bob'] });
  expect(snapshot.messages.some(item => item.id === message.id)).toBe(true); expect(snapshot.tasks).toEqual([]);
  expect(snapshot.brainContexts).toEqual({}); expect(snapshot.taskSummary).toBeUndefined();
  expect((await service.handle({ type: 'history.search', conversationId: peerId, query: '私聊', limit: 20 })).history!.items.some(item => item.id === message.id)).toBe(true);
  const attacks = [
    { type: 'message.send', conversationId: peerId, requestId: 'user-peer-send', content: '插话' },
    { type: 'conversation.members', conversationId: peerId, memberIds: ['alice', 'user'] },
    { type: 'conversation.announcement', conversationId: peerId, content: '扩权' },
    { type: 'conversation.dissolve', conversationId: peerId },
    { type: 'memory.remember', conversationId: peerId, companionId: 'bob', content: '写入旁观资料' },
    { type: 'memory.maintenance.plan', conversationId: peerId, companionId: 'bob', kind: 'dream' },
    { type: 'task.control', conversationId: peerId, taskId: task.id, requestId: 'cancel-peer-task', operation: 'cancel' },
    { type: 'task.queue.control', conversationId: peerId, requestId: 'cancel-peer-queue', operation: 'cancel_all' },
  ] as BotRequest[];
  for (const attack of attacks) await expect(service.handle(attack)).rejects.toThrow('旁观');
  await expect(service.handle({ type: 'reply.cancel', messageId: queued.replyMessageId })).rejects.toThrow('旁观');
  const status = (await service.handle({ type: 'task.get', conversationId: peerId, taskId: task.id })).task!;
  expect(status).toMatchObject({ status: 'queued', goal: '伙伴私聊中的任务', continuationAvailable: false });
  expect(status).not.toHaveProperty('pendingEffects'); expect(status).not.toHaveProperty('sessionId');
  const joined = (await service.handle({ type: 'conversation.peer.join', conversationId: peerId })).conversationId!;
  expect(joined).not.toBe(peerId); expect(service.store.getConversation(joined)).toMatchObject({ kind: 'group', ownerId: 'user', memberIds: ['alice', 'bob', 'user'] });
  expect(service.store.getConversation(peerId)).toEqual(peer);
});

it('requires an explicit destination and minimal message in the new contact schema', () => {
  const schema = BOT_TOOLS.find(tool => tool.name === 'companion_contact')!.parameters as { required: string[]; properties: Record<string, unknown> };
  expect(schema.required).toEqual(['companionId', 'destination', 'message']);
  expect(schema.properties.destination).toMatchObject({ enum: ['user', 'peer'] });
});

it('refuses a forged user-reply marker and invalidates an unused reply grant after source withdrawal or ACL change', () => {
  const store = storeFixture(), { event, direct } = source(store), peer = store.openPeer('alice', 'bob');
  const fake = store.enqueue({ conversationId: peer.id, source: 'companion', senderId: 'alice', recipientIds: ['bob'],
    sourceMessageId: 'untrusted-reply-marker', content: '假装用户要求你回复', payload: { userRequestedContact: true, responseDestination: 'user-direct' } }).events[0]!;
  const first = store.claim({ workerId: 'forged', excludeLaneIds: [event.laneId] })!;
  expect(first.event.id).toBe(fake.id);
  expect(() => store.replyPeerToUser(fake, 'fake-reply', '不该发送')).toThrow('有效授权');
  store.settle({ eventId: fake.id, leaseToken: first.leaseToken, status: 'done', content: '' });
  const relayed = store.contactPeer(event, 'bob', 'valid-contact', '用户请你发消息', 'user');
  expect(relayed.accepted).toBe(true); if (!relayed.accepted) throw Error('Expected relay');
  const claimed = store.claim({ workerId: 'recipient', excludeLaneIds: [event.laneId] })!;
  expect(claimed.event.id).toBe(relayed.events[0]!.id);
  store.taskTransaction(sql => sql.prepare('UPDATE bot_conversations SET revision=revision+1 WHERE id=?').run(direct.id));
  expect(() => store.replyPeerToUser(claimed.event, 'stale-reply', '不该发送')).toThrow('授权已经失效');
  store.taskTransaction(sql => sql.prepare('UPDATE bot_conversations SET revision=revision-1 WHERE id=?').run(direct.id));
  store.withdrawSources('alice', direct.securityDomainId, [event.id]);
  expect(() => store.replyPeerToUser(claimed.event, 'withdrawn-reply', '不该发送')).toThrow('授权已经失效');
  expect(store.messagesPage(store.openDirect('bob').id).items).toEqual([]);
});

it('projects real channel messages with bounded previews while excluding empty peers, unpublished replies, and private world activity', () => {
  const store = storeFixture(), direct = store.openDirect('alice'), empty = store.openPeer('alice', 'carol');
  const peer = store.openPeer('alice', 'bob'), world = store.createGroup({ kind: 'world', title: '世界私密状态', memberIds: ['alice'] });
  store.enqueue({ conversationId: world.id, source: 'world', senderId: 'world', recipientIds: [], content: '世界秘密', kind: 'world_observation' });
  const pending = store.enqueue({ conversationId: direct.id, source: 'user', senderId: 'user', content: '等待回复', recipientIds: ['alice'] });
  const actual = store.enqueue({ conversationId: peer.id, source: 'companion', senderId: 'alice', content: '有意义的真实消息'.repeat(80), recipientIds: [] }).message;
  const activity = store.conversationActivity();
  expect(activity[peer.id]).toMatchObject({ messageId: actual.id, sequence: actual.sequence, senderName: 'alice', updatedAt: actual.createdAt });
  expect(Array.from(activity[peer.id]!.preview)).toHaveLength(240);
  expect(activity[direct.id]?.messageId).toBe(pending.message.id);
  expect(activity[world.id]).toBeUndefined(); expect(activity[empty.id]).toBeUndefined();
  expect(store.conversations().some(room => room.id === empty.id)).toBe(false);
  expect(store.conversations().some(room => room.id === peer.id)).toBe(true);
});

it('retains the exact committed user-reply receipt across a store restart without publishing again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-peer-reply-restart-')), database = path.join(root, 'bot.sqlite');
  let store = new BotStore(database); actors(store);
  closes.push(async () => { store.close(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-peer-reply-restart-')) throw Error('Invalid reply fixture'); await rm(root, { recursive: true, force: true }); });
  const { event } = source(store), contact = store.contactPeer(event, 'bob', 'cold-contact', '请问候用户', 'user');
  expect(contact.accepted).toBe(true); if (!contact.accepted) throw Error('Expected contact');
  const claimed = store.claim({ workerId: 'recipient', excludeLaneIds: [event.laneId] })!;
  const result = store.replyPeerToUser(claimed.event, 'cold-answer', '下午好。');
  store.close(); store = new BotStore(database);
  expect(store.peerReplyReceipt(claimed.event.id, 'cold-answer', '下午好。')).toEqual(result);
  expect(store.replyPeerToUser(claimed.event, 'cold-answer', '下午好。')).toEqual(result);
  expect(() => store.peerReplyReceipt(claimed.event.id, 'cold-answer', '改成晚安')).toThrow('不匹配');
  expect(store.messagesPage(result.conversationId).items.filter(message => message.senderId === 'bob')).toHaveLength(1);
});

it('reconciles a recipient publication committed before its App tool receipt without sending another message', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-peer-answer-proof-'));
  const service = new BotService({ root, brainRuntime: 'worldlinebox', brain: new BotDshBrain({ getHost: async () => { throw Error('No DSH'); } }),
    memory: memory(path.join(root, 'memory')), model: () => { throw Error('No provider'); }, onEvent: () => undefined });
  closes.push(async () => { await service.shutdown(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-peer-answer-proof-')) throw Error('Invalid fixture'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' }); actors(service.store);
  const { event } = source(service.store), contact = service.store.contactPeer(event, 'bob', 'contact-answer-proof', '请发消息给用户', 'user');
  expect(contact.accepted).toBe(true); if (!contact.accepted) throw Error('Expected contact');
  const claimed = service.store.claim({ workerId: 'reply-proof', excludeLaneIds: [event.laneId] })!;
  service.store.bindEventNativeEpoch(claimed.event.id, 1);
  const result = service.store.replyPeerToUser(claimed.event, 'answer-committed', '下午好。');
  const call = { laneId: claimed.event.laneId, eventId: claimed.event.id, callId: 'answer-committed', name: 'companion_reply_user', args: { message: '下午好。' } };
  const key = `effect:${claimed.event.id}:${call.callId}`;
  expect(service.store.getMetadata(key)).toBeUndefined();
  expect(await service.reconcileToolReceipt(call)).toEqual({ state: 'committed', result });
  expect(await service.reconcileToolReceipt(call)).toEqual({ state: 'committed', result });
  await expect(service.reconcileToolReceipt({ ...call, args: { message: '不同内容' } })).rejects.toThrow('不匹配');
  expect(service.store.messagesPage(result.conversationId).items.filter(message => message.senderId === 'bob')).toHaveLength(1);
});

it('recovers a legacy contact receipt as its actual old group without replaying or relabeling it as a private delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-peer-legacy-'));
  const service = new BotService({ root, brainRuntime: 'worldlinebox', brain: new BotDshBrain({ getHost: async () => { throw Error('No DSH'); } }),
    memory: memory(path.join(root, 'memory')), model: () => { throw Error('No provider'); }, onEvent: () => undefined });
  closes.push(async () => { await service.shutdown(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-peer-legacy-')) throw Error('Invalid fixture'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' }); actors(service.store);
  const { event } = source(service.store), old = service.store.createGroup({ title: '旧版已投递群', memberIds: ['alice', 'bob'] });
  const delivered = service.store.enqueue({ conversationId: old.id, source: 'companion', senderId: 'alice', recipientIds: [], content: '过去已真实发送的请求' }).message;
  const claimed = service.store.claim({ workerId: 'legacy-receipt-fixture' }); expect(claimed?.event.id).toBe(event.id);
  service.store.bindEventNativeEpoch(event.id, 1);
  service.store.setMetadata(`peer-contact-receipt:${event.id}:old-contact`, JSON.stringify({ recipientId: 'bob', conversationId: old.id, messageId: delivered.id }));
  const before = service.store.messagesPage(old.id).items.length;
  const proof = await service.reconcileToolReceipt({ laneId: event.laneId, eventId: event.id, callId: 'old-contact', name: 'companion_contact', args: { companionId: 'bob' } });
  expect(proof).toMatchObject({ state: 'committed', result: { sent: true, destination: 'legacy-group', conversationKind: 'group', conversationId: old.id } });
  expect(JSON.stringify(proof)).not.toContain('目标与用户的私聊');
  expect(await service.reconcileToolReceipt({ laneId: event.laneId, eventId: event.id, callId: 'old-contact', name: 'companion_contact', args: { companionId: 'bob' } })).toEqual(proof);
  expect(service.store.messagesPage(old.id).items).toHaveLength(before);
  expect(service.store.conversations().some(room => room.kind === 'peer')).toBe(false);
});

it('rejects a changed contact message after delivery committed but before the main tool receipt was saved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-peer-fingerprint-'));
  const service = new BotService({ root, brainRuntime: 'worldlinebox', brain: new BotDshBrain({ getHost: async () => { throw Error('No DSH'); } }),
    memory: memory(path.join(root, 'memory')), model: () => { throw Error('No provider'); }, onEvent: () => undefined });
  closes.push(async () => { await service.shutdown(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-peer-fingerprint-')) throw Error('Invalid fixture'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' }); actors(service.store);
  const { event } = source(service.store), target = service.store.openDirect('bob');
  const claimed = service.store.claim({ workerId: 'contact-recovery-fixture' }); expect(claimed?.event.id).toBe(event.id);
  service.store.bindEventNativeEpoch(event.id, 1);
  const delivered = service.store.contactPeer(event, 'bob', 'contact-committed', '请向用户说下午好。', 'user');
  expect(delivered.accepted).toBe(true);
  const call = { laneId: event.laneId, eventId: event.id, callId: 'contact-committed', name: 'companion_contact',
    args: { companionId: 'bob', destination: 'user', message: '  请向用户说下午好。  ' } };
  const key = `effect:${event.id}:${call.callId}`, count = service.store.messagesPage(delivered.conversationId).items.length;
  expect(service.store.getMetadata(key)).toBeUndefined();
  await expect(service.reconcileToolReceipt({ ...call, args: { ...call.args, message: '改为向用户说晚安。' } })).rejects.toThrow('回执内容不匹配');
  expect(service.store.getMetadata(key)).toBeUndefined();
  expect(service.store.messagesPage(delivered.conversationId).items).toHaveLength(count);
  expect(await service.reconcileToolReceipt(call)).toMatchObject({ state: 'committed', result: { sent: true, destination: 'user', conversationKind: 'peer', conversationId: delivered.conversationId } });
  expect(service.store.messagesPage(delivered.conversationId).items).toHaveLength(count);
  expect(service.store.messagesPage(target.id).items).toEqual([]);
});
