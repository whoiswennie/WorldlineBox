import { expect, it, vi } from 'vitest';
import { reviewTopicSummaryQuantities as actualQuantityReview } from '../../src/main/companions/topic-summary-quantity-review';
import type { TopicUserCanon } from '../../src/main/companions/topic-user-canon';
import { confirmedQuantitySourcePremiseFixture, quantityRoleFixture } from '../helpers/companion-quantity-role-fixture';

const reviewTopicSummaryQuantities = (options: Parameters<typeof actualQuantityReview>[0]) => actualQuantityReview({ ...options,
  verifySourcePremises: options.verifySourcePremises ?? confirmedQuantitySourcePremiseFixture,
  verifyRoles: options.verifyRoles ? quantityRoleFixture(options.verifyRoles) : undefined });

const canon: TopicUserCanon = { version: 1, throughSequence: 1, entries: [{ id: 'count', sourceMessageId: 'source', sourceChecksum: 'c'.repeat(64),
  quote: '共有5张卡，第4张仍未得到。', rule: '不发给模型的自由解释' }] };
const config = { apiFormat: 'openai_chat' as const, model: 'synthetic', apiKey: 'fixture' };
const extractSets = async () => ({ sets: [{ canonIndex: 0, entityQuote: '卡', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] });
function fixture(summary: string) { return { canon, config, summary, stage: '', clauses: [{ clauseIndex: 0, text: summary }], extractSets,
  verifyRoles: async (context: { user: string }) => ({ reviews: JSON.parse(context.user).data.candidates.map((candidate: { candidateIndex: number; numberCandidates: unknown[] }) => ({
    candidateIndex: candidate.candidateIndex, assertion: 'scene_possession', sameCollection: 'yes', kind: summary.includes('第') ? 'members' : 'count',
    currentNumberIndexes: candidate.numberCandidates.map((_number, index) => index), reason: '独立语法确认本例实际持有' })) }) }; }
it('computes actual possession above a source-bound total minus distinct missing ordinals in host arithmetic', async () => {
  const correction = await reviewTopicSummaryQuantities({ ...fixture('他带5张卡。'), extractClaims: async () => ({ clauses: [{ clauseIndex: 0,
    quantities: [{ setIndex: 0, entityQuote: '卡', usage: 'current_possessed_count', numberIndexes: [0] }] }] }) });
  expect(correction).toContain('"availableUpperBound":4'); expect(correction).toContain('他带5张卡');
});
it.each(['total', 'planned', 'attributed', 'ambiguous'] as const)('allows quantity modality %s after independent grammar without relabeling it as actual possession', async usage => {
  expect(await reviewTopicSummaryQuantities({ ...fixture('他说要带5张卡。'),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, assertion: 'attributed', kind: 'not_current', currentNumberIndexes: [], reason: '人物未来声称，不是当前实际持有。' }] }), extractClaims: async () => ({ clauses: [{ clauseIndex: 0,
    quantities: [{ setIndex: 0, entityQuote: '卡', usage, numberIndexes: [0] }] }] }) })).toBeUndefined();
});
it('allows a legal ordinal subset but rejects holding a specifically missing member even below the count limit', async () => {
  for (const [summary, numbers, reject] of [['持有第1、3张卡。', ['1', '3'], false], ['持有第1、4张卡。', ['1', '4'], true]] as const) {
    const correction = await reviewTopicSummaryQuantities({ ...fixture(summary), extractClaims: async () => ({ clauses: [{ clauseIndex: 0,
      quantities: [{ setIndex: 0, entityQuote: '卡', usage: 'current_possessed_members', numberIndexes: numbers.map((_number, index) => index) }] }] }) });
    expect(!!correction).toBe(reject);
  }
});
it('does not turn no identified set into a quantity authority and rejects forged number provenance', async () => {
  const extractClaims = vi.fn();
  expect(await reviewTopicSummaryQuantities({ ...fixture('新的数值9。'), extractSets: async () => ({ sets: [] }), extractClaims })).toBeUndefined();
  expect(extractClaims).not.toHaveBeenCalled();
  const wrong = vi.fn(async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, entityQuote: '卡', usage: 'current_possessed_count', numberIndexes: [99] }] }] }));
  await expect(reviewTopicSummaryQuantities({ ...fixture('他带3张卡。'), extractClaims: wrong })).rejects.toThrow('未推进水位'); expect(wrong).toHaveBeenCalledTimes(3);
});

it('checks number grammar without source rules and excludes a parenthetical missing member before arithmetic', async () => {
  const input = fixture('带第1、3张卡（第4张未得到）。');
  expect(await reviewTopicSummaryQuantities({ ...input,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_members',
      numberIndexes: [0, 1, 2] }] }] }),
    verifyRoles: async context => {
      const data = JSON.parse(context.user).data;
      expect(data.proposed).toBeUndefined(); expect(context.user).not.toContain(canon.entries[0]!.quote);
      expect(data.candidates[0].sourceCollectionQuote).toBeUndefined();
      return { reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind: 'members', currentNumberIndexes: [0, 1], reason: '4明确未得，仅1和3属持有列表' }] };
    } })).toBeUndefined();
});

it('rejects an affirmative members role without any actual member indexes instead of silently treating it as zero held', async () => {
  const verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind: 'members', currentNumberIndexes: [], reason: '肯定成员但缺索引的无效审稿' }] }));
  await expect(reviewTopicSummaryQuantities({ ...fixture('持有第1、4张卡。'),
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_members',
      numberIndexes: [0, 1] }] }] }), verifyRoles })).rejects.toThrow('未推进水位');
  expect(verifyRoles).toHaveBeenCalledTimes(3);
});
