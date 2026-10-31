import { expect, it } from 'vitest';
import type { CompanionAction, CompanionMessage } from '../../src/shared/companions';
import { companionChatActionIds, companionReplyParts, companionTimelineActionEntries } from '../../src/renderer/companions/companion-reply-presentation';

const message: CompanionMessage = { id: 'reply', sequence: 1, conversationId: 'room', authorId: 'fish', kind: 'text', content: '我来看看。',
  createdAt: '2026-10-29T12:00:00Z', status: 'sent', attachments: [], segments: [{ text: '我来看看。', actionIds: ['call-1'] }] };
const receipt: CompanionMessage = { ...message, id: 'receipt', sequence: 2, kind: 'action', actionId: 'call-1', segments: undefined };

it('keeps the inline entry and suppresses only its exact duplicate standalone receipt', () => {
  const autonomous = { ...receipt, id: 'autonomous', actionId: 'actual-independent-call' };
  expect(companionTimelineActionEntries([message, receipt, autonomous])).toEqual([message, autonomous]);
});

it('keeps an autonomous receipt when its parent is off page, unavailable or a different author, topic or conversation', () => {
  expect(companionTimelineActionEntries([receipt])).toEqual([receipt]);
  for (const extra of [{ sourceUnavailable: 'execution_source_changed' as const }, { authorId: 'other-fish' }, { topicId: 'other-topic' }, { conversationId: 'other-room' }]) {
    const parent = { ...message, ...extra };
    expect(companionTimelineActionEntries([parent, receipt])).toEqual([parent, receipt]);
  }
});

it('retains one real standalone entry when multiple receipts refer to the same action', () => {
  const next = { ...receipt, id: 'receipt-later', sequence: 3 };
  expect(companionTimelineActionEntries([receipt, next])).toEqual([next]);
});

it('keeps conversation-related memory calls but routes autonomous memory calls out of the chat stream by host audience', () => {
  const action: CompanionAction = { id: 'call-1', companionId: 'fish', conversationId: 'room', title: '回忆与整理记忆', status: 'succeeded', createdAt: message.createdAt, updatedAt: message.createdAt,
    capability: { name: 'memory', callId: 'native-call', invocationId: 'run', inputHash: 'a'.repeat(64), audience: 'agenda' } };
  const background = { ...receipt, audience: 'agenda' as const };
  expect(companionTimelineActionEntries([background])).toEqual([]);
  expect(companionTimelineActionEntries([receipt], [action])).toEqual([]);
  const related = { ...action, sourceMessageId: 'outside-this-page', capability: { ...action.capability!, audience: 'conversation' as const } };
  expect(companionTimelineActionEntries([receipt], [related])).toEqual([receipt]);
  expect(companionChatActionIds(message, ['call-1', 'unknown-detail'], [action])).toEqual(['unknown-detail']);
  expect(companionChatActionIds(message, ['call-1'], [related])).toEqual(['call-1']);
  expect(companionTimelineActionEntries([receipt], [{ ...action, companionId: 'someone-else' }])).toEqual([receipt]);
});

it('groups consecutive tool-only steps without merging speech or replaying repeated call IDs', () => {
  const segments = [{ text: '我先看看。', actionIds: ['a'] }, { text: '', actionIds: ['b'] }, { text: ' \n', actionIds: [] },
    { text: '', actionIds: ['b', 'c'] }, { text: '看到了字幕。', actionIds: ['d'] }, { text: '', actionIds: ['e'] }];
  expect(companionReplyParts(segments)).toEqual([
    { step: 0, text: '我先看看。', actionIds: ['a'], streaming: false },
    { step: 1, text: '', actionIds: ['b', 'c'], streaming: false },
    { step: 4, text: '看到了字幕。', actionIds: ['d'], streaming: false },
    { step: 5, text: '', actionIds: ['e'], streaming: false },
  ]);
});

it('does not swallow a current streaming cursor into the tool-only group', () => {
  expect(companionReplyParts([{ text: '', actionIds: ['a'] }, { text: '', actionIds: ['b'] }, { text: '', actionIds: [] }], 2)
    .map(part => ({ step: part.step, ids: part.actionIds, streaming: part.streaming }))).toEqual([
    { step: 0, ids: ['a', 'b'], streaming: false }, { step: 2, ids: [], streaming: true },
  ]);
});
