import { expect, it } from 'vitest';
import type { BotConversation } from '../../src/shared/companion-bot';
import { botCanImportConversationMedia, botCanInspectConversation } from '../../src/shared/companion-bot-access';

const room: BotConversation = { id: 'peer', kind: 'peer', title: 'GPT × 大肥鱼', memberIds: ['gpt', 'fish'], userRole: 'observer', createdAt: '2026-11-04T00:00:00.000Z' };
it('allows the owner to read a real two-companion private transcript but never publish attachments into it', () => {
  expect(botCanInspectConversation(room)).toBe(true); expect(botCanImportConversationMedia(room)).toBe(false);
});
it('does not turn another group or an invalid peer room into an observable private conversation', () => {
  for (const invalid of [{ ...room, userRole: undefined }, { ...room, kind: 'group' as const }, { ...room, memberIds: ['gpt'] }, { ...room, memberIds: ['gpt', 'gpt'] }, { ...room, dissolvedAt: room.createdAt }]) {
    expect(botCanInspectConversation(invalid)).toBe(false); expect(botCanImportConversationMedia(invalid)).toBe(false);
  }
  expect(botCanInspectConversation(undefined)).toBe(false);
});
it('preserves normal user chat media access and revokes a dissolved group', () => {
  const group = { ...room, kind: 'group' as const, memberIds: ['user', 'gpt', 'fish'] };
  expect(botCanInspectConversation(group)).toBe(true); expect(botCanImportConversationMedia(group)).toBe(true);
  expect(botCanImportConversationMedia({ ...group, dissolvedAt: room.createdAt })).toBe(false);
});
