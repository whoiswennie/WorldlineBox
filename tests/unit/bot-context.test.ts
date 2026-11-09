import { expect, it } from 'vitest';
import { botClock, botLocalTimestamp, buildNativeBotContext } from '../../src/main/companion-bot/context';
import type { BotCompanion, BotEvent } from '../../src/main/companion-bot/types';
const companion: BotCompanion = { id: 'alice', name: 'Alice', persona: '沉稳，认真。', createdAt: '2026-11-02', updatedAt: '2026-11-02' };
const event: BotEvent = { id: 'e1', eventId: 'e1', companionId: 'alice', conversationId: 'c1', laneId: 'lane1', source: 'user',
  sourceInstanceId: 'desktop', sourceMessageId: 'm1', senderId: 'user', senderType: 'user', senderName: '我', audienceScopeId: 'c1', securityDomainId: 'c1',
  aclRevision: 1, sequence: 1, kind: 'message', content: '当前问题', payload: {}, correlationId: 'root', sourceMessageRecordId: 'trigger', sourceMessageSequence: 5,
  replyMessageId: 'reply', status: 'running', attempts: 1, occurredAt: '2026-11-02', receivedAt: '2026-11-02' };

const conversation = { id: 'c1', title: '聊天', kind: 'direct' as const, memberIds: ['user','alice'], audienceScopeId: 'c1', securityDomainId: 'c1', revision: 1, createdAt: '2026-11-02' };
it('keeps current user input, attribution, persona and recalled evidence in a fresh native envelope', () => {
  const context = buildNativeBotContext({ companion, event, conversation, companions: [companion], files: [], memories: 'VCP证据' });
  expect(context.system).toContain(companion.persona);
  expect(context.system).toContain('原生 DSH Agent');
  const body = JSON.parse(context.prompt);
  expect(body.message).toMatchObject({ content: '当前问题', senderId: 'user' });
  expect(body.memoryEvidence).toBe('VCP证据');
  expect(body).not.toHaveProperty('history'); expect(body).not.toHaveProperty('tasks');
});
it('formats trusted Shanghai time across a UTC date boundary without changing source timestamps', () => {
  expect(botClock(new Date('2026-11-01T16:34:00Z')).localDateTime).toBe('2026-11-02T00:34:00+08:00');
  expect(botLocalTimestamp('2026-11-02T00:34:00Z')).toBe('2026-11-02T08:34:00+08:00');
  expect(botLocalTimestamp('2026-11-02')).toBe('2026-11-02');
});
it('bounds member and character directories without exposing private personas', () => {
  const companions = Array.from({ length: 1000 }, (_, n) => ({ ...companion, id: 'actor-' + n, name: '伙伴' + n }));
  const body = JSON.parse(buildNativeBotContext({ companion, event, conversation: { ...conversation, memberIds: companions.map(a => a.id) }, companions, files: [], memories: '' }).prompt);
  expect(body.room.members).toHaveLength(64); expect(body.room.memberCount).toBe(1000);
  expect(body.companionDirectory).toHaveLength(64); expect(body.companionDirectoryHasMore).toBe(true);
  expect(body.companionDirectory[0]).not.toHaveProperty('persona');
});
