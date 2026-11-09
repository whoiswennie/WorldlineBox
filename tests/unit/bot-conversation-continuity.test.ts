import { afterEach, expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotConversationContinuity, botConversationReadSchema } from '../../src/main/companion-bot/conversation-continuity';

const stores: BotStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new BotStore(':memory:'); stores.push(store);
  for (const id of ['claude', 'fish', 'other']) store.createCompanion({ id, name: id, persona: id });
  const direct = store.openDirect('claude'), fishDirect = store.openDirect('fish'), peer = store.openPeer('claude', 'fish');
  const say = (sender: string, content: string) => store.enqueue({ conversationId: peer.id, senderId: sender,
    source: 'companion', recipientIds: [sender === 'claude' ? 'fish' : 'claude'], content });
  const question = () => store.enqueue({ conversationId: direct.id, senderId: 'user', content: '大肥鱼刚才跟你聊什么？' }).events[0]!;
  return { store, direct, fishDirect, peer, say, question, reader: new BotConversationContinuity(store) };
}
it('reads an actual peer response immediately even while the recipient event is still queued and no VCP exists', () => {
  const f = fixture(); f.say('claude', '最近忙什么？'); const fish = f.say('fish', '在烤海盐曲奇，等会儿分你一份。'), event = f.question();
  expect(f.store.getEvent(fish.events[0]!.id)?.status).toBe('queued');
  const result = f.reader.read(event, { operation: 'read', conversationId: f.peer.id });
  expect(result).toMatchObject({ sourceConversation: { id: f.peer.id, kind: 'peer' }, source: 'published-chat-journal' });
  expect(JSON.stringify(result)).toContain('海盐曲奇');
  const hint = f.reader.activity(event)!;
  expect(hint.conversations).toContainEqual(expect.objectContaining({ conversationId: f.peer.id, lastMessageId: fish.message.id, senderId: 'fish' }));
  expect(JSON.stringify(hint)).not.toContain('海盐曲奇');
});
it('reads both incoming and outgoing peer speech but not another companion user chat or internal Worker receipts', () => {
  const f = fixture(), request = f.say('claude', '请先把天气查好。'); f.say('fish', '已经收到你的话，正在查。');
  // A historical internal receipt remains in the journal but is not public peer speech.
  f.store.taskTransaction(sql => sql.prepare('INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    'legacy-private-receipt', 'legacy-task-event', f.peer.id, 'task-service', 'task-service', 'service', 'PRIVATE_WEATHER_16.6', 'sent', 'task_done', request.message.correlationId, request.message.createdAt));
  f.store.enqueue({ conversationId: f.fishDirect.id, senderId: 'user', recipientIds: [], content: 'FISH_USER_PRIVATE_SECRET' });
  const event = f.question(), value = JSON.stringify(f.reader.read(event, { operation: 'read', conversationId: f.peer.id }));
  expect(value).toContain('请先把天气查好'); expect(value).toContain('已经收到你的话');
  expect(value).not.toMatch(/PRIVATE_WORKER|PRIVATE_WEATHER|FISH_USER_PRIVATE/u);
  expect(() => f.reader.read(event, { operation: 'read', conversationId: f.fishDirect.id })).toThrow('获准');
  const notice = f.store.messagesPage(f.peer.id).items.find(message => message.kind === 'task_done')!;
  expect(() => f.reader.read(event, { operation: 'message', conversationId: f.peer.id, messageId: notice.id })).toThrow('可回查');
  expect(f.store.messagesPage(f.peer.id).items.some(message => message.content === 'PRIVATE_WEATHER_16.6')).toBe(true);
});
it('paginates real publication order and reads long Unicode messages in full without replaying tasks', () => {
  const f = fixture(), text = '海盐🍪曲奇，今天已经回复。'.repeat(130), first = f.say('fish', text);
  f.say('claude', '听起来很好吃。'); const event = f.question();
  const latest = f.reader.read(event, { operation: 'read', conversationId: f.peer.id, limit: 1 });
  expect(latest).toMatchObject({ hasMore: true, messages: [expect.objectContaining({ senderId: 'claude' })] });
  const older = f.reader.read(event, { operation: 'read', conversationId: f.peer.id, before: 'nextBefore' in latest ? Number(latest.nextBefore) : 0, limit: 1 });
  expect(older).toMatchObject({ hasMore: false, messages: [expect.objectContaining({ id: first.message.id, contentIsPreview: true })] });
  let offset = 0, complete = '';
  while (true) {
    const part = f.reader.read(event, { operation: 'message', conversationId: f.peer.id, messageId: first.message.id, offset, limit: 300 });
    if (!('text' in part)) throw new Error('Expected a full-message page');
    complete += part.text;
    if (part.nextOffset === undefined) break;
    offset = part.nextOffset;
  }
  expect(complete).toBe(text);
});
it('retains cross-conversation source dependencies and refuses withdrawn public data while preserving the UI journal', () => {
  const f = fixture(), sent = f.say('fish', '要撤回的公开原话。'), event = f.question();
  f.reader.read(event, { operation: 'read', conversationId: f.peer.id });
  expect(f.reader.read(event, { operation: 'list' })).toMatchObject({ source: 'published-chat-journal' });
  f.store.withdrawSources('claude', f.peer.securityDomainId, [sent.message.id]);
  expect(f.store.peerWithdrawalTargets('claude', f.peer.securityDomainId)).toContainEqual({ conversationId: f.direct.id, messageId: event.replyMessageId });
  expect(f.reader.activity(event)?.conversations.some(room => room.lastMessageId === sent.message.id)).toBe(false);
  expect(JSON.stringify(f.reader.read(event, { operation: 'read', conversationId: f.peer.id }))).not.toContain('要撤回的公开原话');
  expect(() => f.reader.read(event, { operation: 'message', conversationId: f.peer.id, messageId: sent.message.id })).toThrow('可回查');
  expect(f.store.getMessage(sent.message.id)?.content).toBe('要撤回的公开原话。');
});
it('keeps peer audiences local and preserves the current-event future-message fence', () => {
  const f = fixture(), peerEvent = f.say('fish', '你好Claude').events[0]!;
  expect(f.reader.activity(peerEvent)).toBeUndefined();
  expect(() => f.reader.read(peerEvent, { operation: 'read', conversationId: f.direct.id })).toThrow('获准');
  const event = f.question(), future = f.store.enqueue({ conversationId: f.direct.id, senderId: 'user', content: 'FUTURE_NEW_REQUEST' }).message;
  expect(JSON.stringify(f.reader.read(event, { operation: 'read', conversationId: f.direct.id }))).not.toContain('FUTURE_NEW_REQUEST');
  expect(() => f.reader.read(event, { operation: 'message', conversationId: f.direct.id, messageId: future.id })).toThrow('可回查');
  expect(botConversationReadSchema.safeParse({ operation: 'read', conversationId: f.peer.id, owner: 'fish' }).success).toBe(false);
});
