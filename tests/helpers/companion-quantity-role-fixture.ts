import type { TopicSourceQuantityReviewOptions } from '../../src/main/companions/topic-summary-quantity-review';

type Infer = NonNullable<TopicSourceQuantityReviewOptions['verifyRoles']>;
/** Explicit legacy test declaration only. Each old declared result is now a
 * declared IR premise; this adapter never classifies or certifies real text. */
export function declaredAllProjectionFixture(check: { evidence: Array<{ view: string; clauseIndex: number; text: string }> },
  statement: 'affirmative_whole_set' | 'explicit_not_all' | 'no_whole_set_assertion' | 'ambiguous' = 'no_whole_set_assertion') {
  const focus = check.evidence.find(item => item.view === 'focus')!;
  const evidenceRef = { view: 'focus' as const, clauseIndex: focus.clauseIndex };
  return { coverage: 'whole_focus' as const, reviewedFocusRef: evidenceRef,
    domainScope: statement === 'affirmative_whole_set' || statement === 'explicit_not_all' ? 'whole_collection_candidate' as const : 'ambiguous' as const,
    exhaustivity: statement === 'affirmative_whole_set' ? 'exhaustive' as const : statement === 'explicit_not_all' ? 'explicit_not_exhaustive' as const
      : statement === 'no_whole_set_assertion' ? 'not_asserted' as const : 'ambiguous' as const,
    holding: statement === 'affirmative_whole_set' ? 'affirmed' as const : statement === 'explicit_not_all' ? 'denied' as const : 'ambiguous' as const,
    opposition: 'none_in_reviewed_scope' as const,
    witnesses: statement === 'ambiguous' ? [] : (statement === 'affirmative_whole_set'
      ? ['domain_reference', 'exhaustive_coverage_operator', 'scoped_possession_predicate'] as const
      : statement === 'explicit_not_all' ? ['negative_or_limited_scope'] as const : ['target_scope'] as const)
      .map(role => ({ role, evidenceRef, quote: focus.text.slice(0, 600) })) };
}
/** The caller explicitly declares this legacy semantic fixture disjoint.
 * Production never receives this test receipt, and uncertain/new tests must
 * supply their own independent decision instead of using this declaration. */
export const declaredDisjointQuantityFixture: NonNullable<TopicSourceQuantityReviewOptions['verifyDisjointWaivers']> = async context => {
  const { checks } = JSON.parse(context.user).data as { checks: Array<{ checkIndex: number;
    target: { kind: string }; evidence: Array<{ view: string; clauseIndex: number; text: string }> }> };
  return { reviews: checks.map(check => { const focus = check.evidence.find(item => item.view === 'focus')!;
    return { checkIndex: check.checkIndex, verdict: 'positive_exemption', basis: 'different_inventory',
      evidenceRefs: [{ view: focus.view, clauseIndex: focus.clauseIndex }], reason: '仅此test声明的原异组语义，独立fixture准入。' }; }) };
};

/** Explicit protocol adaptation for old declarative mocks, not a text classifier.
 * New projection tests return their own complete sidecar and bypass this helper. */
export function declaredWarmAllFixture(context: { user: string }, value: unknown,
  declaredStatement?: Parameters<typeof declaredAllProjectionFixture>[1], declaredNumbers?: Record<string, Parameters<typeof declaredNumberProjectionFixture>[2]>) {
  if (!record(value) || !Array.isArray(value.clauses)) return value;
  const data = JSON.parse(context.user).data as { requiredPairs: Array<{ clauseIndex: number; setIndex: number }>;
    actualClauses: Array<{ clauseIndex: number; text: string; numberCandidates: Array<{ numberIndex: number; numberQuote: string; occurrence: number }> }> };
  return { ...value, ...('allProjections' in value ? {} : { allProjections: data.requiredPairs.map(pair => {
    const row = (value.clauses as Array<{ clauseIndex: number; quantities: Array<{ setIndex: number; usage: string }> }>).find(c => c.clauseIndex === pair.clauseIndex);
    const statement = declaredStatement ?? (row?.quantities.some(q => q.setIndex === pair.setIndex && q.usage === 'current_possessed_all')
      ? 'affirmative_whole_set' as const : 'no_whole_set_assertion' as const);
    return { ...pair, projection: declaredAllProjectionFixture({ evidence: [{ view: 'focus', ...data.actualClauses[pair.clauseIndex]! }] }, statement) };
  }) }), ...('numberProjections' in value ? {} : { numberProjections: data.requiredPairs.flatMap(pair => {
    return data.actualClauses[pair.clauseIndex]!.numberCandidates.map(number => {
      // The legacy mock tests raw mechanics. No usage enum gains an author
      // proposition by default; individual cases declare their new premise.
      const statement = declaredNumbers?.[pair.clauseIndex + ':' + pair.setIndex + ':' + number.numberIndex] ?? 'ambiguous';
      return { ...pair, numberIndex: number.numberIndex, projection: declaredNumberProjectionFixture(data.actualClauses[pair.clauseIndex]!, number.numberIndex, statement) };
    });
  }) }) };
}

/** Explicit declarative mock, never a production text classifier. */
export function declaredNumberProjectionFixture(clause: { clauseIndex: number; text: string;
  numberCandidates: Array<{ numberIndex: number; numberQuote: string; occurrence: number }> }, numberIndex: number,
  statement: 'affirmative_possession' | 'explicit_nonpossession' | 'no_possession_assertion' | 'ambiguous' = 'ambiguous') {
  const number = clause.numberCandidates[numberIndex]!, evidenceRef = { view: 'focus' as const, clauseIndex: clause.clauseIndex };
  return { statement, coverage: 'whole_focus' as const, reviewedFocusRef: evidenceRef, targetNumberQuote: number.numberQuote, targetOccurrence: number.occurrence,
    witnesses: statement === 'ambiguous' ? [] : (statement === 'affirmative_possession' ? ['target_scope', 'scoped_possession_predicate'] as const
      : statement === 'explicit_nonpossession' ? ['target_scope', 'negative_scope'] as const : ['target_scope'] as const)
      .map(role => ({ role, evidenceRef, quote: clause.text.slice(0, 300) })) };
}

/** Legacy mechanism tests already declare semantic roles rather than measure
 * model accuracy. This explicit test adapter supplies the new independent
 * phase from those declarations; new admission tests inject a separate reader.
 * No production path obtains this fixture or defaults a missing model field. */
export function withDeclaredQuantitySemanticFixture<T extends TopicSourceQuantityReviewOptions>(options: T & {
  declaredAuthorAllStatement?: Parameters<typeof declaredAllProjectionFixture>[1];
  declaredAuthorNumberStatements?: Record<string, Parameters<typeof declaredNumberProjectionFixture>[2]> }): T {
  const originalClaims = options.extractClaims;
  options = { ...options, ...(originalClaims ? { extractClaims: async (context, signal) => declaredWarmAllFixture(context, await originalClaims(context, signal), options.declaredAuthorAllStatement, options.declaredAuthorNumberStatements) } : {}) };
  if (!options.verifyRoles || options.verifyDisjointWaivers && options.verifyDisjointWaivers !== declaredDisjointQuantityFixture) return options;
  let declared: Array<{ candidateIndex: number; numbers: Array<{ numberIndex: number; collection: string; voice: string; time: string; relation: string; kind: string }>;
    all: { collection: string; voice: string; time: string; relation: string } }> = [];
  return { ...options, verifyRoles: async (context, signal) => {
    const response = await options.verifyRoles!(context, signal);
    if (record(response) && Array.isArray(response.reviews)) declared = response.reviews as typeof declared;
    return response;
  }, verifyDisjointWaivers: async context => {
    const { checks } = JSON.parse(context.user).data as { checks: Array<{ checkIndex: number; candidateIndex: number;
      target: { kind: string; numberIndex?: number }; evidence: Array<{ view: string; clauseIndex: number; text: string }> }> };
    return { reviews: checks.map(check => {
      const candidate = declared.find(item => item.candidateIndex === check.candidateIndex)!;
      const axes = check.target.kind === 'all' ? candidate.all : candidate.numbers.find(item => item.numberIndex === check.target.numberIndex)!;
      const basis = axes.collection === 'different' ? 'different_inventory'
        : ['attributed_claim', 'question', 'hypothetical'].includes(axes.voice) ? axes.voice
          : ['earlier_history', 'future'].includes(axes.time) ? axes.time
            : axes.relation === 'missing' ? 'negative_or_missing'
              : check.target.kind === 'all' ? axes.relation === 'not_affirmed_all' ? 'no_all_assertion' : 'none'
                : axes.relation === 'collection_size' ? 'pure_collection_total'
                  : 'kind' in axes && axes.kind === 'member' ? 'member_role'
                    : 'kind' in axes && axes.kind === 'count' ? 'count_role'
                      : axes.relation === 'unrelated' ? 'unrelated_target' : 'none';
      const focus = check.evidence.find(item => item.view === 'focus')!;
      return { checkIndex: check.checkIndex, verdict: basis === 'none' ? 'unresolved' : 'positive_exemption', basis,
        evidenceRefs: [{ view: focus.view, clauseIndex: focus.clauseIndex }], reason: '仅原机制test已声明的语义前提；不证明真实模型准确率。' };
    }) };
  } };
}
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
