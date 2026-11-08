import { afterEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotContactStatus } from '../../src/main/companion-bot/contact-status';
import type { BotEvent } from '../../src/main/companion-bot/types';

const stores: BotStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new BotStore(':memory:'); stores.push(store);
  for (const id of ['alice', 'bob', 'carol']) store.createCompanion({ id, name: id, persona: '自然交流的伙伴' });
  const direct = store.openDirect('alice');
  const original = store.enqueue({ conversationId: direct.id, senderId: 'user', recipientIds: ['alice'], content: 'ALICE_PRIVATE_SOURCE_7182。请让Bob向我问好。' }).events[0]!;
  const claimed = store.claim({ workerId: 'source' })!;
  expect(claimed.event.id).toBe(original.id);
  const helper = new BotContactStatus(store);
  const contact = (callId = 'contact-one', target = 'bob', destination: 'peer' | 'user' = 'user', source = original) => {
    const sent = store.contactPeer(source, target, callId, '请向指定受众问好。', destination);
    expect(sent.accepted).toBe(true); if (!sent.accepted) throw new Error('Expected contact fixture delivery'); return sent;
  };
  const recipient = () => {
    const value = store.claim({ workerId: 'recipient', excludeLaneIds: [original.laneId] }); expect(value).toBeDefined(); return value!;
  };
  return { store, helper, direct, original, contact, recipient };
}
const first = (f: ReturnType<typeof fixture>, event = f.original) => f.helper.list(event).items[0]!;

it('distinguishes queued/running/done reception from an actual reply and ignores unrelated later peer or private messages', () => {
  const f = fixture(), sent = f.contact();
  expect(first(f)).toMatchObject({ available: true, contactId: sent.message.id, sourceMessageId: sent.message.id, requesterId: 'alice', recipientId: 'bob',
    destination: 'user-direct', relay: { state: 'published', messageId: sent.message.id }, recipientEvent: { id: sent.events[0]!.id, status: 'queued' },
    peerReply: { state: 'not-observed' }, userDirectDelivery: { state: 'not-observed', userRead: 'unknown' } });
  const recipient = f.recipient(); f.store.updateDraft(recipient.event.id, recipient.leaseToken, '未发布的草稿不能算回复。');
  expect(first(f)).toMatchObject({ recipientEvent: { status: 'running' }, peerReply: { state: 'not-observed' } });
  f.store.settle({ eventId: recipient.event.id, leaseToken: recipient.leaseToken, status: 'done', content: '' });
  f.store.enqueue({ conversationId: sent.conversationId, senderId: 'bob', recipientIds: [], content: '这是另外一条毫无关系的新消息。' });
  const privateRoom = f.store.openDirect('bob');
  f.store.enqueue({ conversationId: privateRoom.id, senderId: 'bob', recipientIds: [], content: 'BOB_PRIVATE_UNRELATED_93271' });
  expect(first(f)).toMatchObject({ recipientEvent: { status: 'done' }, peerReply: { state: 'not-observed' }, userDirectDelivery: { state: 'not-observed' } });
  expect(JSON.stringify(first(f))).not.toMatch(/7182|93271|另外一条/);
});

it('reports the exact peer reply and real user publication separately, never reads private text, and distinguishes outbox delivery acknowledgement from user read', () => {
  const f = fixture(), sent = f.contact(), recipient = f.recipient();
  const delivered = f.store.replyPeerToUser(recipient.event, 'user-answer', 'BOB_USER_PRIVATE_72631 下午好。');
  f.store.settle({ eventId: recipient.event.id, leaseToken: recipient.leaseToken, status: 'done', content: 'Alice，我已经向用户问好了。' });
  const getMessage = f.store.getMessage.bind(f.store);
  vi.spyOn(f.store, 'getMessage').mockImplementation(messageId => {
    if (messageId === delivered.messageId) throw new Error('Contact status must never read recipient-private message content');
    return getMessage(messageId);
  });
  const result = first(f);
  expect(result).toMatchObject({ available: true, recipientEvent: { id: sent.events[0]!.id, status: 'done' },
    peerReply: { state: 'published', messageId: recipient.event.replyMessageId },
    userDirectDelivery: { state: 'published', conversationId: delivered.conversationId, messageId: delivered.messageId, userRead: 'unknown' } });
  expect(JSON.stringify(result)).not.toMatch(/72631|7182|下午好|我已经/);
  f.store.acknowledgeOutbox(delivered.messageId);
  expect(first(f).userDirectDelivery).toMatchObject({ state: 'delivered', messageId: delivered.messageId, deliveredAt: expect.any(String), userRead: 'unknown' });
});

it('keeps legacy missing-grant and missing-recipient evidence unknown instead of inferring a user reply', () => {
  const f = fixture(), contact = f.contact(), recipient = f.recipient();
  f.store.replyPeerToUser(recipient.event, 'before-legacy-loss', '已真实发送但旧版没有授权账本');
  f.store.taskTransaction(sql => sql.prepare('DELETE FROM bot_metadata WHERE key=?').run(`peer-user-reply-grant:${recipient.event.id}`));
  expect(first(f).userDirectDelivery).toMatchObject({ state: 'unknown', userRead: 'unknown' });
  f.store.settle({ eventId: recipient.event.id, leaseToken: recipient.leaseToken, status: 'done', content: '' });
  const old = f.store.createGroup({ title: '旧版伙伴群', memberIds: ['alice', 'bob'] });
  const message = f.store.enqueue({ conversationId: old.id, senderId: 'alice', recipientIds: [], content: '旧版仅有实际投递回执。' }).message;
  f.store.setMetadata(`peer-contact-receipt:${f.original.id}:legacy`, JSON.stringify({ recipientId: 'bob', conversationId: old.id, messageId: message.id }));
  expect(first(f)).toMatchObject({ available: true, destination: 'unknown', contactId: message.id, peerReply: { state: 'unknown' }, userDirectDelivery: { state: 'unknown' } });
  expect(f.helper.list(f.original).items.find(item => item.contactId === contact.message.id)?.userDirectDelivery?.state).toBe('unknown');
});

it('paginates by each contact relay sequence and matches each original contact rather than the latest recipient response', () => {
  const f = fixture(), old = f.contact('old'), oldRecipient = f.recipient();
  const actual = f.store.replyPeerToUser(oldRecipient.event, 'old-answer', '原联系的问候');
  f.store.settle({ eventId: oldRecipient.event.id, leaseToken: oldRecipient.leaseToken, status: 'done', content: '旧联系的回复。' });
  const newer = f.contact('new'), newRecipient = f.recipient();
  f.store.settle({ eventId: newRecipient.event.id, leaseToken: newRecipient.leaseToken, status: 'done', content: '' });
  f.contact('carol-contact', 'carol', 'peer');
  const page = f.helper.list(f.original, { companionId: 'bob', limit: 1 });
  expect(page).toMatchObject({ available: true, hasMore: true, items: [{ contactId: newer.message.id, userDirectDelivery: { state: 'not-observed' } }] });
  expect(page.nextBefore).toBe(newer.message.sequence);
  const previous = f.helper.list(f.original, { companionId: 'bob', limit: 1, before: page.nextBefore });
  expect(previous).toMatchObject({ hasMore: false, items: [{ contactId: old.message.id, userDirectDelivery: { messageId: actual.messageId, state: 'published' } }] });
  expect(f.helper.list(f.original, { companionId: 'carol' }).items).toHaveLength(1);
});

it.each(['withdraw', 'revision', 'disabled-source', 'disabled-recipient'] as const)('marks %s contact authority unavailable without recreating grants or delivery', operation => {
  const f = fixture(), sent = f.contact();
  if (operation === 'withdraw') f.store.withdrawSources('alice', f.direct.securityDomainId, [f.original.id]);
  if (operation === 'revision') f.store.taskTransaction(sql => sql.prepare('UPDATE bot_conversations SET revision=revision+1 WHERE id=?').run(f.direct.id));
  if (operation === 'disabled-source') f.store.setCompanionEnabled('alice', false);
  if (operation === 'disabled-recipient') f.store.setCompanionEnabled('bob', false);
  const fresh = f.store.enqueue({ conversationId: f.direct.id, senderId: 'user', recipientIds: ['alice'], content: '只查询原联系状态。' }).events[0]!;
  const before = f.store.taskTransaction(sql => sql.prepare('SELECT total_changes() AS changes').get()) as { changes: number };
  const status = f.helper.list(fresh);
  if (operation === 'disabled-source') expect(status).toMatchObject({ available: false, reason: 'requester-disabled', items: [] });
  else expect(status.items.find(item => item.contactId === sent.message.id)).toMatchObject({ available: false, reason: expect.any(String) });
  const after = f.store.taskTransaction(sql => sql.prepare('SELECT total_changes() AS changes').get()) as { changes: number };
  expect(after).toEqual(before);
});

it('allows only relay-local metadata in the actual peer, omits private-source IDs and excludes another peer contact', () => {
  const f = fixture(), visible = f.contact('to-bob'), hidden = f.contact('to-carol', 'carol');
  const current = f.store.enqueue({ conversationId: visible.conversationId, senderId: 'bob', recipientIds: ['alice'], content: 'Alice，刚才的联系呢？' }).events[0]!;
  const result = f.helper.list(current);
  expect(result.items).toHaveLength(1); expect(result.items[0]).toMatchObject({ available: true, contactId: visible.message.id, sourceAccess: 'relay-local' });
  expect(result.items[0]?.source).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(f.direct.id); expect(JSON.stringify(result)).not.toContain(f.original.id);
  expect(JSON.stringify(result)).not.toContain(hidden.message.id);
  const bob = f.store.enqueue({ conversationId: visible.conversationId, senderId: 'alice', recipientIds: ['bob'], content: 'Bob只可看自己发起的联系。' }).events[0]!;
  expect(f.helper.list(bob).items).toEqual([]);
});

it('returns stale origin or malformed recipient lineage as unavailable and never matches a forged private delivery', () => {
  const f = fixture(), sent = f.contact(), recipient = f.recipient(), raw = f.store.getMetadata(`peer-user-reply-grant:${recipient.event.id}`)!;
  const other = f.store.openDirect('bob'), message = f.store.enqueue({ conversationId: other.id, senderId: 'bob', recipientIds: [], content: '无关私聊不属于这次联系。' }).message;
  f.store.setMetadata(`peer-user-reply-grant:${recipient.event.id}`, JSON.stringify({ ...JSON.parse(raw), reply: { result: { sent: true, senderId: 'bob', recipientId: 'user', messageId: message.id, conversationId: other.id } } }));
  expect(first(f).userDirectDelivery?.state).toBe('unknown');
  f.store.taskTransaction(sql => sql.prepare('UPDATE bot_inbox SET causation_id=? WHERE id=?').run('different-cause', sent.events[0]!.id));
  expect(first(f)).toMatchObject({ available: false, reason: 'contact-lineage-unavailable' });
  expect(f.helper.list({ ...f.original, securityDomainId: 'forged-domain' } as BotEvent)).toMatchObject({ available: false, items: [] });
});

it('is idempotent and rejects unsafe pagination without writing the shared store', () => {
  const f = fixture(); f.contact();
  const changes = () => f.store.taskTransaction(sql => sql.prepare('SELECT total_changes() AS n').get());
  const before = changes(); expect(f.helper.list(f.original)).toEqual(f.helper.list(f.original)); expect(changes()).toEqual(before);
  expect(() => f.helper.list(f.original, { limit: 31 })).toThrow(); expect(() => f.helper.list(f.original, { before: -1 })).toThrow();
});
