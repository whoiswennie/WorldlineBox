import { afterEach, expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';

const stores: BotStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture(mode?: 'automatic' | 'all' | 'mentions') {
  const store = new BotStore(':memory:'); stores.push(store);
  for (const [id, name] of [['id-ann', 'Ann'], ['id-annabelle', 'Annabelle'], ['id-ming', '阿明'], ['id-mingming', '阿明明']]) store.createCompanion({ id: id!, name: name!, persona: '伙伴' });
  const conversation = store.createGroup({ title: '群聊', memberIds: ['id-ann', 'id-annabelle', 'id-ming', 'id-mingming'], participationMode: mode });
  const send = (sourceMessageId: string, content: string, recipientIds?: string[]) => store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId, content, recipientIds });
  return { store, conversation, send };
}

it('offers ordinary public messages as hidden assessment candidates instead of randomly choosing a speaker', () => {
  const f = fixture(); expect(f.conversation.participationMode).toBe('automatic');
  const result = f.send('public', '大家好'); expect(result.events).toHaveLength(4);
  expect(result.events.every(event => event.payload.groupAttention === true)).toBe(true);
  expect(f.store.messagesPage(f.conversation.id).items.map(message => message.content)).toEqual(['大家好']);
  expect(f.send('noise', '……！').events).toEqual([]);
  const named = f.send('natural', '阿明在吗'); expect(named.events.map(event => event.companionId)).toEqual(['id-ming']);
  expect(named.events[0]!.payload.groupAttention).toBeUndefined();
});

it('matches complete names and unique IDs, not similar-name prefixes or email addresses', () => {
  const f = fixture('mentions');
  expect(f.send('specific', '@Annabelle @阿明明，请回答。').events.map(event => event.companionId).sort()).toEqual(['id-annabelle', 'id-mingming']);
  expect(f.send('email', '邮件地址 ann@Ann.com 和 user@阿明明.cn 不是点名。').events).toEqual([]);
  expect(f.send('unique-id', '@id-ann 请看').events.map(event => event.companionId)).toEqual(['id-ann']);
  expect(f.send('similar-id', '@id-annabelle 请看').events.map(event => event.companionId)).toEqual(['id-annabelle']);
});

it('honors explicit broadcasts and trusted targets while preserving the all-discussion mode', () => {
  const f = fixture('mentions');
  expect(f.send('broadcast', '@所有人 请回答').events).toHaveLength(4);
  expect(f.send('broadcast-english', '@all hello').events).toHaveLength(4);
  expect(f.send('trusted', '@all hello', ['id-ann']).events.map(event => event.companionId)).toEqual(['id-ann']);
  f.store.setConversationPolicy(f.conversation.id, 'all');
  expect(f.send('discussion', '公开讨论').events).toHaveLength(4);
  expect(f.send('directed-in-all', '@阿明 请先回答').events.map(event => event.companionId)).toEqual(['id-ming']);
  const lifecycle = f.store.enqueue({ conversationId: f.conversation.id, source: 'companion', senderId: 'id-ann', content: '原生伙伴真实回执', sourceMessageId: 'native-notice', recipientIds: ['id-annabelle'] });
  expect(lifecycle.events.map(event => event.companionId)).toEqual(['id-annabelle']);
});

it('replays original routing across policy changes, rejects changed explicit targets and does not rotate ACL or native epoch', () => {
  const f = fixture(), first = f.send('stable-source', '普通消息'), original = first.events[0]!;
  const before = f.store.getConversation(f.conversation.id), lane = f.store.getLane(original.laneId);
  f.store.setConversationPolicy(f.conversation.id, 'all');
  expect(f.send('stable-source', '普通消息')).toEqual(first);
  expect(f.store.getConversation(f.conversation.id)?.revision).toBe(before!.revision);
  expect(f.store.getLane(original.laneId)?.epoch).toBe(lane!.epoch);
  const other = f.conversation.memberIds.find(id => id !== 'user' && id !== original.companionId)!;
  expect(() => f.send('stable-source', '普通消息', [other])).toThrow('不同内容');
  expect(f.send('stable-source', '普通消息', first.events.map(event => event.companionId))).toEqual(first);
});

it('preserves an empty mentions routing on retry and treats absent legacy policy as all', () => {
  const f = fixture('mentions'), first = f.send('unmentioned', '没有点名'); expect(first.events).toEqual([]);
  f.store.setConversationPolicy(f.conversation.id, 'all'); expect(f.send('unmentioned', '没有点名')).toEqual(first);
  f.store.setMetadata(`conversation-participation:${f.conversation.id}`, '');
  expect(f.store.getConversation(f.conversation.id)?.participationMode).toBe('all');
  expect(f.send('legacy', '原群默认全体讨论').events).toHaveLength(4);
});

it('promotes a selected candidate idempotently across a retry while fencing stale or cancelled workers', () => {
  const f = fixture(), source = f.send('retry-selected', '请谈谈这个话题');
  const first = f.store.claim({ workerId: 'first' })!;
  expect(f.store.promoteGroupReply(first.event.id, first.leaseToken)).toBe(true);
  expect(f.store.promoteGroupReply(first.event.id, first.leaseToken)).toBe(true);
  f.store.requeue(first.event.id, first.leaseToken);
  const next = f.store.claim({ workerId: 'retry', excludeLaneIds: source.events.filter(event => event.id !== first.event.id).map(event => event.laneId) });
  expect(next?.event.id).toBe(first.event.id);
  expect(f.store.promoteGroupReply(first.event.id, first.leaseToken)).toBe(false);
  expect(f.store.promoteGroupReply(next!.event.id, next!.leaseToken)).toBe(true);
  f.store.cancelEvent(next!.event.id);
  expect(f.store.promoteGroupReply(next!.event.id, next!.leaseToken)).toBe(false);
});
