import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { prepareTopicUserCanon, type TopicUserCanon } from '../../src/main/companions/topic-user-canon';
import { prepareTopicNarrativeReferences } from '../../src/main/companions/topic-narrative-references';
import { reviewTopicContinuity } from '../../src/main/companions/topic-continuity-review';
import { reviewTopicSummaryCanon } from '../../src/main/companions/topic-summary-canon-review';
import { reviewTopicSourceQuantities } from '../../src/main/companions/topic-summary-quantity-review';

const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'synthetic' };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
function fixture() {
  const at = '2026-10-28T00:00:00Z', id = randomUUID();
  const frame: CompanionReplyInput = { companion: { id: 'alice', name: '林澄', description: '', persona: '有来源的独立伙伴', model: '', avatar: 'sister', builtin: false, proactive: false, createdAt: at },
    conversation: { id: 'room', kind: 'private', title: '故事', memberIds: ['alice'], muted: false, pinned: false, unread: 0, lastMessage: '', updatedAt: at },
    topic: { id, conversationId: 'room', kind: 'story', title: '故事', status: 'active', moderatorId: 'user', revision: 1, participantIds: ['alice', 'user'], invitedIds: [], tags: [], createdAt: at, updatedAt: at },
    messages: [{ id: 'source_' + id, authorId: 'user', conversationId: 'room', topicId: id, sequence: 1, kind: 'text', status: 'sent', attachments: [], createdAt: at, content: '信件尚未打开，不要揭晓收件人的身份。' }], memories: [] };
  return { frame, config };
}
const data = (init?: RequestInit) => JSON.parse(JSON.parse(String(init?.body)).messages[1].content);

it('keeps a proposed exact user rule rather than repairing the extraction into empty canon and advancing its source watermark', async () => {
  const f = fixture(), source = f.frame.messages[0]!, original = { additions: [{ sourceMessageId: source.id, quote: source.content, rule: source.content }] };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(original)).mockImplementation(async () => response({ additions: [], revisions: [] }));
  await expect(prepareTopicUserCanon({ ...f, fetchFn })).rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
  expect(fetchFn).toHaveBeenCalledTimes(3); expect(data(fetchFn.mock.calls[2]?.[1]).originalOutput).toBe(JSON.stringify(original));
  const fixed = vi.fn<typeof fetch>().mockResolvedValue(response({ ...original, revisions: [] }));
  const actual = await prepareTopicUserCanon({ ...f, fetchFn: fixed });
  expect(actual.entries[0]?.quote).toBe(source.content); expect(fixed).toHaveBeenCalledOnce();
});

it('permits a genuine empty rule extraction while repairing only the missing structural array', async () => {
  const f = fixture(); f.frame.messages = [{ ...f.frame.messages[0]!, content: '继续。' }];
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ additions: [] })).mockResolvedValueOnce(response({ additions: [], revisions: [] }));
  expect((await prepareTopicUserCanon({ ...f, fetchFn })).entries).toEqual([]); expect(fetchFn).toHaveBeenCalledTimes(2);
});

it.each(['extract', 'review'] as const)('never deletes proposed narrative %s records to satisfy the output schema', async stage => {
  const f = fixture(), source = { ...f.frame.messages[0]!, authorId: 'alice', content: '林澄停在窗边。她收好地图。' }; f.frame.messages = [source];
  const candidate = { sourceMessageId: source.id, subjectName: '林澄', quote: source.content, referencePronoun: '她', decision: 'accept' };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(stage === 'extract' ? { references: [candidate] } : { decisions: [{ index: 0, decision: 'accept' }] }))
    .mockImplementation(async () => response(stage === 'extract' ? { references: [] } : { decisions: [] }));
  await expect(prepareTopicNarrativeReferences({ ...f, fetchFn,
    ...(stage === 'review' ? { extract: async () => ({ references: [{ ...candidate, referenceOccurrence: 0 }] }) } : {}) }))
    .rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
  expect(fetchFn).toHaveBeenCalledTimes(3);
});

it('cannot turn an original continuity refusal into supported=true with an empty issue list', async () => {
  const f = fixture(), approved = vi.fn(), original = { supported: false, issues: [{ basis: '当前原文禁止打开', claimQuote: '信件已经打开',
    basisQuote: '信件尚未打开', correction: '保留未打开的实际边界' }] };
  f.frame.topicState = { topicId: f.frame.topic!.id, readerId: 'alice', trust: 'topic_state_not_real_world_facts',
    workingState: { authorId: 'alice', revision: 1, sourceEventId: 'checkpoint', sourceMessageIds: [f.frame.messages[0]!.id],
      summary: '信件尚未打开。', updatedAt: '2026-10-28T00:00:00Z' } };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(original)).mockImplementation(async () => response({ supported: true, issues: [] }));
  await expect(reviewTopicContinuity({ ...f, proposed: { kind: 'reply', text: '信件已经打开。' }, fetchFn,
    extractCanon: async () => ({ additions: [], revisions: [] }), onPublicationApproved: approved }))
    .rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
  expect(fetchFn).toHaveBeenCalledTimes(3); expect(approved).not.toHaveBeenCalled();
});

it('cannot clear a proposed summary canon contradiction and re-enter its semantic retry slots', async () => {
  const canon: TopicUserCanon = { version: 1, throughSequence: 1, entries: [{ id: 'rule', sourceMessageId: 'source', sourceChecksum: 'a'.repeat(64), quote: '信件尚未打开。', rule: '信件尚未打开。' }] };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const payload = data(init);
    if (payload.purpose === 'topic_summary_quantity_source_sets') return response({ sets: [] });
    if (payload.purpose === 'topic_summary_canon_audit') return response({ checks: [{ canonIndex: 0, status: 'contradiction', contradictions: [{ claimQuote: '信件已经打开', reason: '原文仍未打开' }] }] });
    expect(payload.purpose).toBe('companion_structured_repair'); return response({ checks: [], clauses: [] });
  });
  await expect(reviewTopicSummaryCanon({ canon, summary: '信件已经打开。', stage: '', config, fetchFn }))
    .rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
  expect(fetchFn).toHaveBeenCalledTimes(4);
});

it('never repairs a supplied quantity set into no inventory facts to bypass arithmetic review', async () => {
  const canon: TopicUserCanon = { version: 1, throughSequence: 1, entries: [{ id: 'rule', sourceMessageId: 'source', sourceChecksum: 'a'.repeat(64), quote: '共有3把钥匙，第2把尚未找到。', rule: '保留原始缺失条件。' }] };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ sets: [{ canonIndex: 0, entityQuote: '钥匙', missingOrdinalNumberIndexes: [1] }] }))
    .mockImplementation(async () => response({ sets: [] }));
  await expect(reviewTopicSourceQuantities({ canon, summary: '带齐3把钥匙。', stage: '', clauses: [{ clauseIndex: 0, start: 0, end: 8, text: '带齐3把钥匙。' }], config, fetchFn }))
    .rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
  expect(fetchFn).toHaveBeenCalledTimes(3);
});
