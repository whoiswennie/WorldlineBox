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

it('delivers to the target user-direct as the real origin companion, without granting membership or private-history access', () => {
  const store = storeFixture(), { direct, event } = source(store, '无关私聊秘密。请让bob跟我说下午好'), target = store.openDirect('bob');
  store.enqueue({ conversationId: target.id, senderId: 'user', content: 'bob自己的私聊秘密', recipientIds: [] });
  const delivered = store.contactPeer(event, 'bob', 'contact-user', '请直接对用户说下午好', 'user');
  expect(delivered.accepted).toBe(true); if (!delivered.accepted) throw Error('Expected delivery');
  expect(delivered.conversationId).toBe(target.id);
  expect(delivered.message).toMatchObject({ senderId: 'alice', senderType: 'companion', content: '请直接对用户说下午好' });
  expect(delivered.events[0]).toMatchObject({ source: 'companion', companionId: 'bob', payload: { responseDestination: 'user-direct', userRequestedContact: true } });
  expect(store.getConversation(target.id)!.memberIds).toEqual(['bob', 'user']);
  expect(store.getConversation(direct.id)!.memberIds).toEqual(['alice', 'user']);
  expect(store.conversations().filter(room => room.kind === 'peer')).toHaveLength(0);
  expect(store.contactPeer(event, 'bob', 'contact-user', '请直接对用户说下午好', 'user')).toMatchObject({ message: { id: delivered.message.id }, events: [] });
  expect(() => store.contactPeer(event, 'bob', 'contact-user', '请直接对用户说下午好', 'peer')).toThrow('目的地');
  expect(() => store.enqueue({ conversationId: target.id, senderId: 'alice', source: 'companion', recipientIds: ['bob'], content: '无宿主来源的越权投递' })).toThrow('发送者');
  const context = JSON.parse(buildBotContext({ companion: store.getCompanion('bob')!, event: delivered.events[0]!, conversation: target,
    participants: [store.getCompanion('bob')!], messages: store.messagesPage(direct.id).items }).user);
  expect(context.peerContact).toMatchObject({ responseDestination: 'user-direct', userPresent: true, privateHistoryTransferred: false });
  expect(context.room.members).toEqual([{ id: 'user', name: '用户' }, { id: 'bob', name: 'bob' }]);
  expect(JSON.stringify(context)).not.toContain('无关私聊秘密');
  store.withdrawSources('alice', direct.securityDomainId, [event.id]);
  expect(store.peerWithdrawalTargets('alice', direct.securityDomainId)).toEqual([{ conversationId: target.id, messageId: delivered.message.id }]);
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
  const key = `effect:${event.id}:${call.callId}`, count = service.store.messagesPage(target.id).items.length;
  expect(service.store.getMetadata(key)).toBeUndefined();
  await expect(service.reconcileToolReceipt({ ...call, args: { ...call.args, message: '改为向用户说晚安。' } })).rejects.toThrow('回执内容不匹配');
  expect(service.store.getMetadata(key)).toBeUndefined();
  expect(service.store.messagesPage(target.id).items).toHaveLength(count);
  expect(await service.reconcileToolReceipt(call)).toMatchObject({ state: 'committed', result: { sent: true, destination: 'user', conversationId: target.id } });
  expect(service.store.messagesPage(target.id).items).toHaveLength(count);
});
