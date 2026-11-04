import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { botRequestSchema } from '../../src/shared/companion-bot';

let store: BotStore, root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wlb-history-search-')); store = new BotStore(path.join(root, 'bot.sqlite'));
  store.createCompanion({ id: 'alice', name: 'Alice', persona: '认真' }); store.createCompanion({ id: 'bob', name: 'Bob', persona: '可靠' });
});
afterEach(() => {
  store.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-history-search-')) throw Error('Invalid history fixture cleanup');
  rmSync(root, { recursive: true, force: true });
});
it('searches only user-accessible current-chat original records and retains terminal states and literal wildcard characters', () => {
  const conversation = store.openDirect('alice'), other = store.openDirect('bob');
  const literal = String.raw`路径 C:\data\100%_done`, input = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: literal, sourceMessageId: 'literal' });
  const claim = store.claim({ workerId: 'test' })!; store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'failed', content: '编译 100%_done 失败', error: 'exit code 1' });
  const stopped = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '停止这轮', sourceMessageId: 'stop' });
  const stopping = store.claim({ workerId: 'stop-test' })!; store.updateDraft(stopping.event.id, stopping.leaseToken, '取消前已经收到的正文');
  store.cancelEvent(stopped.events[0]!.id);
  store.enqueue({ conversationId: other.id, senderId: 'user', content: literal + ' 另一私聊', sourceMessageId: 'other' });
  store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '路径 C:data100anythingXdone', sourceMessageId: 'wildcard-decoy' });
  expect(store.searchMessages(conversation.id, { query: String.raw`C:\data\100%_` }).items.map(message => message.id)).toEqual([input.message.id]);
  expect(store.searchMessages(conversation.id, { query: '100%_done' }).items).toMatchObject([{ status: 'failed', error: 'exit code 1' }, { id: input.message.id, status: 'sent' }]);
  expect(store.searchMessages(conversation.id, { query: '' }).items.find(message => message.id === stopped.events[0]!.replyMessageId)?.status).toBe('cancelled');
  const internal = store.createGroup({ title: '内部世界观察域', kind: 'world', memberIds: ['alice'], includeUser: false });
  expect(() => store.searchMessages(internal.id, { query: '' })).toThrow('不能查询');
  expect(() => store.searchMessages('missing', { query: '' })).toThrow('不能查询');
  expect(() => store.searchMessages(conversation.id, { query: 'x'.repeat(201) })).toThrow('200字符');
});
it('paginates matching records by a stable before cursor without duplicates or admitting newer cross-chat records', () => {
  const conversation = store.openDirect('alice'), other = store.openDirect('bob');
  for (let index = 0; index < 205; index++) {
    store.enqueue({ conversationId: conversation.id, senderId: 'user', recipientIds: [], content: `查找原文 ${index}`, sourceMessageId: `message-${index}` });
    if (index % 9 === 0) store.enqueue({ conversationId: other.id, senderId: 'user', recipientIds: [], content: `查找原文他域 ${index}`, sourceMessageId: `other-${index}` });
  }
  const first = store.searchMessages(conversation.id, { query: '查找原文', limit: 200 });
  expect(first.items).toHaveLength(80); expect(first.hasMore).toBe(true);
  store.enqueue({ conversationId: conversation.id, senderId: 'user', recipientIds: [], content: '查找原文 新到记录', sourceMessageId: 'new' });
  const second = store.searchMessages(conversation.id, { query: '查找原文', before: first.nextBefore }), third = store.searchMessages(conversation.id, { query: '查找原文', before: second.nextBefore });
  expect(second.items).toHaveLength(80); expect(third.items).toHaveLength(45); expect(third.hasMore).toBe(false);
  const all = [...first.items, ...second.items, ...third.items];
  expect(new Set(all.map(message => message.id)).size).toBe(205); expect(all.every(message => message.conversationId === conversation.id)).toBe(true);
  expect(all.some(message => message.content.includes('新到') || message.content.includes('他域'))).toBe(false);
  expect(all.map(message => message.sequence)).toEqual(all.map(message => message.sequence).sort((a, b) => b - a));
  expect(botRequestSchema.safeParse({ type: 'history.search', conversationId: conversation.id, query: 'a'.repeat(201) }).success).toBe(false);
  expect(botRequestSchema.safeParse({ type: 'history.search', conversationId: conversation.id, query: '', limit: 81 }).success).toBe(false);
});
