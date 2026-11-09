import { afterEach, expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { GROUP_CANDIDATE_LIMIT, GROUP_REPLY_LIMIT } from '../../src/main/companion-bot/group-attention';
import { buildNativeBotContext } from '../../src/main/companion-bot/context';

const stores: BotStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture(count = 3) {
  const store = new BotStore(':memory:'); stores.push(store);
  const ids = Array.from({ length: count }, (_, index) => `actor-${String(index).padStart(4, '0')}`);
  for (const id of ids) store.createCompanion({ id, name: id, persona: '公开伙伴' });
  const room = store.createGroup({ title: '讨论', memberIds: ids });
  return { store, room, ids };
}
it('bounds a thousand-member automatic group before starting any brain or memory worker, and rotates candidates fairly', () => {
  const { store, room } = fixture(1000);
  const first = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'one', content: '大家聊聊今天的安排' });
  const second = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'two', content: '再谈谈明天的安排' });
  expect(first.events).toHaveLength(GROUP_CANDIDATE_LIMIT); expect(second.events).toHaveLength(GROUP_CANDIDATE_LIMIT);
  expect(second.events.some(event => first.events.some(prior => prior.companionId === event.companionId))).toBe(false);
  expect(store.messagesPage(room.id).items.filter(message => message.senderId !== 'user')).toEqual([]);
  const actor = store.getCompanion(first.events[0]!.companionId)!;
  const context = JSON.parse(buildNativeBotContext({ companion: actor, event: first.events[0]!, conversation: room,
    companions: store.listCompanions(), memories: '', files: [] }).prompt);
  expect(context.room.members.length).toBeLessThanOrEqual(64); expect(context.room.memberCount).toBe(1001);
  expect(context.room.members.includes(actor.id)).toBe(true);
  expect(context.companionDirectory.length).toBeLessThanOrEqual(64);
});
it('allows distinct native group lanes to run concurrently and retains replies for explicit history lookup', () => {
  const { store, room } = fixture(2);
  const source = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'each', content: '你们一人一篇作文' });
  expect(source.events.every(event => !event.payload.groupAttention)).toBe(true);
  const first = store.claim({ workerId: 'first' })!;
  const second = store.claim({ workerId: 'second' })!;expect(second.event.companionId).not.toBe(first.event.companionId);
  store.settle({ eventId: first.event.id, leaseToken: first.leaseToken, status: 'done', content: '第一位已经交付的作文' });
  const context = buildNativeBotContext({ companion: store.getCompanion(second.event.companionId)!, conversation: room, event: second.event,
    companions: store.listCompanions(), memories: '', files: [] });
  expect(context.prompt).not.toContain('第一位已经交付的作文');
  expect(store.recentPublishedMessages(room.id, { throughSourceSequence: store.publishedWatermark(room.id) }).some(message => message.id === first.event.replyMessageId && message.content === '第一位已经交付的作文')).toBe(true);
  expect(store.observeGroupReply(first.event.id)).toEqual([]);
});
it('ends automatic discussion on a new user message or explicit stop, preserving prior published messages', () => {
  const { store, room } = fixture(2);
  const source = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'talk', content: '随便聊' });
  store.setMetadata(`group-discussion:${room.id}:${source.events[0]!.correlationId}`, '1');
  store.resolveGroupCandidates(source.message.id, [source.events[0]!.companionId]);
  const claim = store.claim({ workerId: 'speaker' })!;
  store.promoteGroupReply(claim.event.id, claim.leaseToken);
  store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '已发布的一句话' });
  const observers = store.observeGroupReply(claim.event.id); expect(observers).toHaveLength(1);
  const stop = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'stop', content: '别聊了' });
  expect(stop.events).toEqual([]); expect(store.getEvent(observers[0]!.id)?.status).toBe('cancelled');
  expect(store.observeGroupReply(claim.event.id)).toEqual([]);
  expect(store.getMessage(claim.event.replyMessageId)?.content).toBe('已发布的一句话');
});
it('cannot exceed the shared reply budget even when every judge always wants more discussion', () => {
  const { store, room } = fixture(3);
  const source = store.enqueue({ conversationId: room.id, senderId: 'user', content: '随便聊' });
  store.setMetadata(`group-discussion:${room.id}:${source.events[0]!.correlationId}`, '1');
  let count = 0;
  for (let claim = store.claim({ workerId: 'speaker' }); claim; claim = store.claim({ workerId: 'speaker' })) {
    expect(++count).toBeLessThanOrEqual(12);
    store.promoteGroupReply(claim.event.id, claim.leaseToken);
    store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: `新的公开信息${count}` });
    store.observeGroupReply(claim.event.id);
  }
  expect(count).toBeLessThanOrEqual(GROUP_REPLY_LIMIT);
});
