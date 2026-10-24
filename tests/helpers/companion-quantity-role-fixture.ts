import type { TopicSourceQuantityReviewOptions } from '../../src/main/companions/topic-summary-quantity-review';

type Infer = NonNullable<TopicSourceQuantityReviewOptions['verifyRoles']>;
/** The caller explicitly declares this legacy semantic fixture disjoint.
 * Production never receives this test receipt, and uncertain/new tests must
 * supply their own independent decision instead of using this declaration. */
export const declaredDisjointQuantityFixture: NonNullable<TopicSourceQuantityReviewOptions['verifyDisjointWaivers']> = async context => {
  const { checks } = JSON.parse(context.user).data as { checks: Array<{ checkIndex: number;
    evidence: Array<{ view: string; clauseIndex: number }> }> };
  return { reviews: checks.map(check => { const focus = check.evidence.find(item => item.view === 'focus')!;
    return { checkIndex: check.checkIndex, verdict: 'positive_disjoint',
      evidenceRefs: [{ view: focus.view, clauseIndex: focus.clauseIndex }], reason: '仅此test声明的原异组语义，独立fixture准入。' }; }) };
};
/** Existing semantic mocks describe already-confirmed missing inventories.
 * This is test-only; production always obtains its own source-only receipt. */
export const confirmedQuantitySourcePremiseFixture: NonNullable<TopicSourceQuantityReviewOptions['verifySourcePremises']> = async context => {
  const data = JSON.parse(context.user).data as { candidates: Array<{ setIndex: number; totalReference: { clauseIndex: number };
    members: Array<{ ordinalNumberIndex: number; memberClauseIndex: number }> }> };
  return { sets: data.candidates.map(candidate => ({ setIndex: candidate.setIndex, totalBinding: 'supported',
    totalEvidenceClauseIndex: candidate.totalReference.clauseIndex, reason: '本legacy机制fixture声明了已确认的物理缺失。',
    members: candidate.members.map(member => ({ ordinalNumberIndex: member.ordinalNumberIndex, evidenceClauseIndexes: [member.memberClauseIndex],
      predicateTarget: 'physical_member', memberAvailability: 'not_possessed', applicability: 'current_direct', reason: '仅test fixture确认本体未得。' })) })) };
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
function axes(assertion: unknown) {
  const values: Record<string, { voice: string; relation: string; time: string }> = {
    scene_possession: { voice: 'narrated_fact', relation: 'affirmed_holding', time: 'scene' },
    collection_total: { voice: 'narrated_fact', relation: 'collection_size', time: 'scene' },
    not_possessed: { voice: 'narrated_fact', relation: 'missing', time: 'scene' },
    earlier_history: { voice: 'narrated_fact', relation: 'affirmed_holding', time: 'earlier_history' },
    planned: { voice: 'hypothetical', relation: 'affirmed_holding', time: 'future' },
    attributed: { voice: 'attributed_claim', relation: 'affirmed_holding', time: 'scene' },
    unrelated: { voice: 'narrated_fact', relation: 'unrelated', time: 'scene' },
    ambiguous: { voice: 'ambiguous', relation: 'ambiguous', time: 'ambiguous' },
  };
  return values[String(assertion)] ?? { voice: undefined, relation: undefined, time: undefined };
}
function numberRole(value: unknown) {
  if (!record(value) || 'voice' in value) return value;
  return { numberIndex: value.numberIndex, collection: 'same', ...axes(value.assertion), kind: value.kind, reason: value.reason };
}
function allRole(assertion: unknown, reason: unknown) {
  return assertion === 'scene_all' ? { collection: 'same', voice: 'narrated_fact', relation: 'affirmed_all', time: 'scene', reason }
    : assertion === 'not_scene_all' ? { collection: 'same', voice: 'narrated_fact', relation: 'not_affirmed_all', time: 'scene', reason }
    : assertion === 'ambiguous' ? { collection: 'same', voice: 'ambiguous', relation: 'ambiguous', time: 'ambiguous', reason } : undefined;
}

/** Expands existing declarative semantic mocks into the current complete
 * per-number model contract. This adapter is test-only; production accepts
 * only the new schema. New-schema and intentionally malformed fixtures pass
 * through, so coverage/format tests exercise the actual validator unchanged. */
export function quantityRoleFixture(infer: Infer): Infer {
  return async (context, signal) => {
    const value = await infer(context, signal);
    if (!record(value) || !Array.isArray(value.reviews)) return value;
    const data = JSON.parse(context.user).data as { candidates: Array<{ numberCandidates: Array<{ numberIndex: number }> }> };
    return { ...value, reviews: value.reviews.map((review: unknown) => {
      if (!record(review)) return review;
      if (Array.isArray(review.numbers)) {
        if ('all' in review && review.numbers.every(number => record(number) && 'voice' in number)) return review;
        return { candidateIndex: review.candidateIndex,
          numbers: review.numbers.map(numberRole), all: review.all ?? allRole(review.allAssertion, review.allReason) };
      }
      if (!Array.isArray(review.currentNumberIndexes)) return review;
      const candidate = data.candidates[Number(review.candidateIndex)], selected = review.currentNumberIndexes as number[];
      if (!candidate || review.assertion === 'scene_possession'
        && (review.kind === 'count' && selected.length !== 1 || review.kind === 'members' && !selected.length)) return review;
      const numberIndexes = [...candidate.numberCandidates.map(number => number.numberIndex),
        ...selected.filter(index => !candidate.numberCandidates.some(number => number.numberIndex === index))];
      return { candidateIndex: review.candidateIndex,
        numbers: numberIndexes.map(numberIndex => {
          const applies = selected.includes(numberIndex) || !selected.length && review.assertion !== 'scene_possession';
          return { numberIndex, collection: 'same', ...axes(applies ? review.assertion : 'ambiguous'),
            kind: applies ? review.kind === 'members' ? 'member' : review.kind === 'count' ? 'count' : review.kind === 'ambiguous' ? 'ambiguous' : 'unrelated' : 'unrelated',
            reason: review.reason };
        }),
        all: allRole(review.assertion === 'scene_possession' && review.kind === 'all' ? 'scene_all' : 'not_scene_all', review.reason) };
    }) };
  };
}
