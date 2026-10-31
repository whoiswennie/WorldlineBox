import { expect, it } from 'vitest';
import type { CompanionMessage, CompanionReplyStreamEvent, CompanionState } from '../../src/shared/companions';
import { companionProgressMessage, preserveCompanionProgressMessages } from '../../src/renderer/companions/message-progress-projection';

const at = '2026-10-26T01:00:00.000Z';
const source: CompanionMessage = { id: 'source', conversationId: 'room', sequence: 2, authorId: 'user', kind: 'text', content: '打开浏览器', attachments: [], createdAt: at, status: 'sent' };
const state = { companions: [{ id: 'role' }], conversations: [{ id: 'room', memberIds: ['role'] }] } as unknown as CompanionState;
const event: CompanionReplyStreamEvent = { conversationId: 'room', companionId: 'role', sourceMessageId: source.id, messageId: 'reply', step: 0, attemptId: 'progress', phase: 'progress', text: '', messageIdentity: { sequence: 3, createdAt: at }, progress: { workId: 'work', sourceMessageId: source.id, revision: 3, phase: 'memory', detail: '正在回忆', startedAt: at, updatedAt: at } };

it('projects only an empty host identity after matching the visible source and owner', () => {
  expect(companionProgressMessage(event, state, 'room', [source], null)).toMatchObject({ id: 'reply', sequence: 3, authorId: 'role', replyToId: 'source', content: '', attachments: [], isReplyDraft: true, replyProgress: { revision: 3, phase: 'memory' } });
});

it('does not turn agenda-only source receipts or rows into live conversation replies', () => {
  expect(companionProgressMessage(event, state, 'room', [{ ...source, audience: 'agenda' }], null)).toBeUndefined();
  const current = companionProgressMessage(event, state, 'room', [source], null)!;
  expect(companionProgressMessage({ ...event, progress: { ...event.progress!, revision: 4 } }, state, 'room', [source, { ...current, audience: 'agenda' }], null)).toBeUndefined();
});

it.each(['room', 'owner', 'source', 'topic', 'progress-source', 'sequence', 'reset'] as const)('rejects a mismatched %s without publishing a synthetic bubble', mismatch => {
  const changed = { ...event, messageIdentity: { ...event.messageIdentity! }, progress: { ...event.progress! } };
  let currentState = state;
  if (mismatch === 'room') changed.conversationId = 'elsewhere';
  if (mismatch === 'owner') changed.companionId = 'other';
  if (mismatch === 'source') changed.sourceMessageId = 'missing';
  if (mismatch === 'topic') changed.messageIdentity.topicId = 'other-topic';
  if (mismatch === 'progress-source') changed.progress.sourceMessageId = 'missing';
  if (mismatch === 'sequence') changed.messageIdentity.sequence = 1;
  if (mismatch === 'reset') currentState = { ...state, resetJobs: [{ companionId: 'role', status: 'running' }] } as unknown as CompanionState;
  expect(companionProgressMessage(changed, currentState, 'room', [source], null)).toBeUndefined();
});

it('keeps a live draft and its acknowledged source when an older page finishes later', () => {
  const draft = companionProgressMessage(event, state, 'room', [source], null)!;
  const old = { ...source, id: 'older', sequence: 1 };
  const result = preserveCompanionProgressMessages([old], [source, draft], [event], state, 'room', null);
  expect(result.map(item => item.id)).toEqual(['older', 'source', 'reply']);
  const stale = { ...draft, replyProgress: { ...event.progress!, revision: 1, phase: 'queued' as const } };
  expect(preserveCompanionProgressMessages([source, stale], [source, draft], [event], state, 'room', null).at(-1)?.replyProgress?.revision).toBe(3);
});

it('lets a formal published page win and does not revive a removed older draft', () => {
  const draft = companionProgressMessage(event, state, 'room', [source], null)!;
  const published = { ...draft, isReplyDraft: false, content: '已打开', segments: [{ text: '已打开', actionIds: [] }] };
  expect(preserveCompanionProgressMessages([source, published], [source, draft], [event], state, 'room', null).at(-1)).toBe(published);
  const newer = { ...source, id: 'newer', sequence: 4 };
  expect(preserveCompanionProgressMessages([newer], [source, draft], [event], state, 'room', null)).toEqual([newer]);
});

it('keeps the newest visible draft phase when its IPC identity has left the bounded buffer', () => {
  const draft = companionProgressMessage(event, state, 'room', [source], null)!;
  const old = { ...draft, replyProgress: { ...event.progress!, revision: 1, phase: 'context' as const, memory: undefined } };
  expect(preserveCompanionProgressMessages([source, old], [source, draft], [], state, 'room', null).at(-1)?.replyProgress).toBe(draft.replyProgress);
  const published = { ...old, isReplyDraft: false, segments: [{ text: '正式发布的回复', actionIds: [] }] };
  expect(preserveCompanionProgressMessages([source, published], [source, draft], [], state, 'room', null).at(-1)).toBe(published);
  for (const mismatch of [{ ...old, authorId: 'another' }, { ...old, sequence: 99 }, { ...old, replyToId: 'elsewhere' }]) {
    expect(preserveCompanionProgressMessages([source, mismatch], [source, draft], [], state, 'room', null).at(-1)).toBe(mismatch);
  }
  expect(preserveCompanionProgressMessages([source], [source, draft], [], state, 'room', null)).toEqual([source]);
  expect(preserveCompanionProgressMessages([source, old], [source, draft], [], { ...state, resetJobs: [{ companionId: 'role', status: 'running' }] } as unknown as CompanionState, 'room', null).at(-1)).toBe(old);
});
