import { expect, it, vi } from 'vitest';
vi.mock('../../src/main/companions/topic-summary-quantity-review', () => ({ reviewTopicSummaryQuantities: async () => undefined }));
import { reviewTopicSummaryCanon, topicSummaryClauses } from '../../src/main/companions/topic-summary-canon-review';
import type { TopicUserCanon } from '../../src/main/companions/topic-user-canon';

const canon: TopicUserCanon = { version: 1, throughSequence: 1, entries: [{ id: 'rule', sourceMessageId: 'source', sourceChecksum: 'a'.repeat(64),
  quote: '共有5张卡，其中第4张还没拿到。', rule: '自由解释不应进入审核' }] };
const config = { model: 'synthetic', apiKey: 'fixture', apiFormat: 'openai_chat' as const };
const clauses = (summary: string, stage = '') => topicSummaryClauses(summary, stage).map(clause => ({ clauseIndex: clause.clauseIndex,
  status: 'compatible', canonIndexes: [0] }));
it('binds a contradiction to the actual full summary and exact source canon before a separate narrow decision', async () => {
  const summary = '共5张卡，第4未拿到。随后他带齐5张卡进门。', claimQuote = '他带齐5张卡进门';
  const audit = vi.fn(async context => {
    expect(context.user).not.toContain(canon.entries[0]!.rule);
    return { checks: [{ canonIndex: 0, status: 'contradiction', contradictions: [{ claimQuote, reason: '总数被升为全部持有' }] }], clauses: clauses(summary) };
  });
  const adjudicate = vi.fn(async context => {
    const data = JSON.parse(context.user); expect(data.issues[0].canonQuote).toBe(canon.entries[0]!.quote);
    expect(data.proposed.summary).toBe(summary);
    return { decisions: [{ issueIndex: 0, decision: 'upheld', reason: '第4缺失与带齐互斥' }] };
  });
  expect(await reviewTopicSummaryCanon({ canon, summary, stage: '', config, audit, adjudicate })).toContain(claimQuote);
  expect(audit).toHaveBeenCalledOnce(); expect(adjudicate).toHaveBeenCalledOnce();
});
it('allows attributed speech, unknowns and legal non-repetition without another review call', async () => {
  const adjudicate = vi.fn();
  expect(await reviewTopicSummaryCanon({ canon, summary: '旁人说“你有5张卡”，他仍缺第4张。', stage: '', config,
    audit: async context => ({ checks: [{ canonIndex: 0, status: 'consistent', contradictions: [] }], clauses: clauses(JSON.parse(context.user).proposed.summary) }), adjudicate })).toBeUndefined();
  expect(adjudicate).not.toHaveBeenCalled();
});
it('requires unique complete canon coverage and actual quotes within its original bounded format retries', async () => {
  const audit = vi.fn().mockResolvedValueOnce({ checks: [] }).mockResolvedValueOnce({ checks: [{ canonIndex: 0, status: 'contradiction',
    contradictions: [{ claimQuote: '不存在的断言', reason: '不能核' }] }], clauses: [] }).mockResolvedValueOnce({ checks: [{ canonIndex: 0, status: 'not_asserted', contradictions: [] }], clauses: clauses('停在门外。') });
  expect(await reviewTopicSummaryCanon({ canon, summary: '停在门外。', stage: '', config, audit })).toBeUndefined();
  expect(audit).toHaveBeenCalledTimes(3);
  const malformed = vi.fn(async () => ({ checks: [] }));
  await expect(reviewTopicSummaryCanon({ canon, summary: '当前状态', stage: '', config, audit: malformed })).rejects.toThrow('未推进水位');
  expect(malformed).toHaveBeenCalledTimes(3);
});
it('does not uphold a validly quoted but speculative allegation and never invents replacement prose', async () => {
  expect(await reviewTopicSummaryCanon({ canon, summary: '他看着一叠卡。', stage: '', config,
    audit: async () => ({ checks: [{ canonIndex: 0, status: 'contradiction', contradictions: [{ claimQuote: '一叠卡', reason: '猜测卡已齐' }] }], clauses: clauses('他看着一叠卡。') }),
    adjudicate: async () => ({ decisions: [{ issueIndex: 0, decision: 'ambiguous', reason: '一叠未指全5张，不能猜数量' }] }) })).toBeUndefined();
});

it('requires every actual later clause and detects a contradiction even when the top-level canon check says consistent', async () => {
  const summary = '共5张卡，第4未得。随后他带齐5张卡。', chunks = clauses(summary);
  await expect(reviewTopicSummaryCanon({ canon, summary, stage: '', config, audit: async () => ({
    checks: [{ canonIndex: 0, status: 'consistent', contradictions: [] }], clauses: chunks.slice(0, 1) }) })).rejects.toThrow('未推进水位');
  const correction = await reviewTopicSummaryCanon({ canon, summary, stage: '', config, audit: async () => ({
    checks: [{ canonIndex: 0, status: 'consistent', contradictions: [] }], clauses: chunks.map((check, index) => ({ ...check, status: index === 1 ? 'contradiction' : 'compatible' })) }),
    adjudicate: async () => ({ decisions: [{ issueIndex: 0, decision: 'upheld', reason: '后句实际携带总数，与仍缺第4互斥' }] }) });
  expect(correction).toContain('随后他带齐5张卡');
});
