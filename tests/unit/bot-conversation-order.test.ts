import { expect, it } from 'vitest';
import { orderBotConversations } from '../../src/shared/bot-conversation-order';
import type { BotConversationActivity } from '../../src/shared/companion-bot';

it('sorts multiple pins by latest chat time, followed by unpinned chats by latest chat time', () => {
  const rooms = [
    { id: 'a', createdAt: '2026-01-01T00:00:00Z', pinned: true },
    { id: 'b', createdAt: '2026-01-02T00:00:00Z', pinned: true },
    { id: 'c', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'd', createdAt: '2026-01-04T00:00:00Z' },
  ];
  const activity = (sequence: number, updatedAt: string): BotConversationActivity => ({ messageId: String(sequence), sequence, senderName: '我', preview: '消息', updatedAt });
  const recent = { a: activity(100, '2026-11-10T00:00:00Z'), b: activity(2, '2026-11-11T00:00:00Z'),
    c: activity(300, '2026-11-11T01:00:00Z'), d: activity(400, '2026-11-10T01:00:00Z') };
  expect(orderBotConversations(rooms, recent).map(item => item.id)).toEqual(['b', 'a', 'c', 'd']);
  recent.a = activity(500, '2026-11-11T02:00:00Z');
  expect(orderBotConversations(rooms, recent).map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(orderBotConversations(rooms.map(item => ({ ...item, pinned: false })), recent).map(item => item.id)).toEqual(['a', 'c', 'b', 'd']);
  expect(rooms.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
});

it('uses creation time for empty chats and keeps equal-time chats stable without sorting by name', () => {
  const rooms = [{ id: 'z', createdAt: '2026-11-10T00:00:00Z' }, { id: 'a', createdAt: '2026-11-10T00:00:00Z' }, { id: 'new', createdAt: '2026-11-11T00:00:00Z' }];
  expect(orderBotConversations(rooms).map(item => item.id)).toEqual(['new', 'z', 'a']);
});
