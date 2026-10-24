import { buildQuantityAuthorEvidenceLane, type QuantityAuthorEvidenceLane, type QuantityAuthorAllProjection } from '../../src/main/companions/topic-quantity-disjoint-waiver';
import type { TopicSourceQuantityReviewOptions } from '../../src/main/companions/topic-summary-quantity-review';

type Infer = NonNullable<TopicSourceQuantityReviewOptions['verifyRoles']>;
/** Explicit legacy test declaration only. Each old declared result is now a
 * declared IR premise; this adapter never classifies or certifies real text. */
export function declaredAllProjectionFixture(check: { evidence: Array<{ view: string; clauseIndex: number; text: string }> },
  statement: 'affirmative_whole_set' | 'explicit_not_all' | 'no_whole_set_assertion' | 'ambiguous' = 'no_whole_set_assertion', suppliedLane?: QuantityAuthorEvidenceLane): QuantityAuthorAllProjection {
  const focus = check.evidence.find(item => item.view === 'focus')!;
  const clauses = Array.from({ length: focus.clauseIndex + 1 }, (_, clauseIndex) => ({ clauseIndex, text: clauseIndex === focus.clauseIndex ? focus.text : '' }));
  const lane = suppliedLane ?? buildQuantityAuthorEvidenceLane({ clauseIndex: focus.clauseIndex, setIndex: 0 }, clauses);
  const id = lane.evidence.find(e => e.view === 'focus' && e.kind === 'text_segment')!.id;
  const common = { laneId: lane.id, reviewedFocusId: lane.focusId };
  // Explicit declared semantics only; the full-text address is provenance,
  // never an automatic classifier or a claim of real model accuracy.
  if (statement === 'ambiguous') return { ...common, kind: 'unresolved_author_scope', semanticRoles: [], concernEvidenceIds: [], reason: 'insufficient_evidence' };
  if (statement === 'no_whole_set_assertion') return { ...common, kind: 'no_whole_assertion_in_complete_focus',
    semanticRoles: [{ role: 'non_holding_scope', evidenceId: id }], bases: [{ kind: 'non_holding', scopeRole: 0 }] };
  return { ...common, kind: 'recorded_whole_assertions', semanticRoles: [
    { role: 'domain_reference', evidenceId: id }, { role: 'coverage_operator', evidenceId: id },
    { role: 'possession_predicate', evidenceId: id }, ...(statement === 'explicit_not_all' ? [{ role: 'whole_negative_scope' as const, evidenceId: id }] : [])],
    propositions: [{ kind: 'whole_possession', polarity: statement === 'affirmative_whole_set' ? 'affirmed' : 'denied',
      domainRole: 0, coverageRole: 1, predicateRole: 2, negativeRole: statement === 'explicit_not_all' ? 3 : null, scopeEvidenceIds: [id] }], scopeLinks: [] };
}
/** The caller explicitly declares this legacy semantic fixture disjoint.
 * Production never receives this test receipt, and uncertain/new tests must
 * supply their own independent decision instead of using this declaration. */
export const declaredDisjointQuantityFixture: NonNullable<TopicSourceQuantityReviewOptions['verifyDisjointWaivers']> = async context => {
  const { checks } = JSON.parse(context.user).data as { checks: Array<{ checkIndex: number;
    target: { kind: string }; scopeObligation?: { assertionEvidenceIds: string[] }; evidence: Array<{ view: string; clauseIndex: number; text: string }> }> };
  return { reviews: checks.map(check => { const focus = check.evidence.find(item => item.view === 'focus')!;
    return { checkIndex: check.checkIndex, verdict: 'positive_exemption', basis: 'different_inventory',
      evidenceRefs: [{ view: focus.view, clauseIndex: focus.clauseIndex }], targetScopeComplete: true, assertionEvidenceIds: check.scopeObligation?.assertionEvidenceIds ?? [], reason: '仅此test声明的原异组语义，独立fixture准入。' }; }) };
};

/** Explicit protocol adaptation for old declarative mocks, not a text classifier.
 * New projection tests return their own complete sidecar and bypass this helper. */
export function declaredWarmAllFixture(context: { user: string }, value: unknown,
  declaredStatement?: Parameters<typeof declaredAllProjectionFixture>[1], declaredNumbers?: Record<string, Parameters<typeof declaredNumberProjectionFixture>[2]>) {
  if (!record(value) || !Array.isArray(value.clauses)) return value;
  const data = JSON.parse(context.user).data as { requiredPairs: Array<{ clauseIndex: number; setIndex: number }>; authorLanes: Array<{
    logicalPair: { clauseIndex: number; setIndex: number }; window: Array<{ clauseIndex: number; text: string; numberCandidates: Array<{ start: number; end: number; value: number | null; ordinal: boolean }> }> }> };
  const lanes = data.authorLanes.map(input => {
    const last = Math.max(...input.window.map(c => c.clauseIndex));
    const clauses = Array.from({ length: last + 1 }, (_, clauseIndex) => input.window.find(c => c.clauseIndex === clauseIndex) ?? { clauseIndex, text: '', numberCandidates: [] });
    return buildQuantityAuthorEvidenceLane(input.logicalPair, clauses);
  });
  return { ...value, ...('allProjections' in value ? {} : { allProjections: data.requiredPairs.map(pair => {
    const row = (value.clauses as Array<{ clauseIndex: number; quantities: Array<{ setIndex: number; usage: string }> }>).find(c => c.clauseIndex === pair.clauseIndex);
    const statement = declaredStatement ?? (row?.quantities.some(q => q.setIndex === pair.setIndex && q.usage === 'current_possessed_all')
      ? 'affirmative_whole_set' as const : 'no_whole_set_assertion' as const);
    const lane = lanes.find(l => l.logicalPair.clauseIndex === pair.clauseIndex && l.logicalPair.setIndex === pair.setIndex)!;
    const focus = lane.evidence.find(e => e.id === lane.focusId)!;
    return { ...pair, projection: declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: pair.clauseIndex, text: focus.quote }] }, statement, lane) };
  }) }), ...('numberProjections' in value ? {} : { numberProjections: data.requiredPairs.flatMap(pair => {
    const lane = lanes.find(l => l.logicalPair.clauseIndex === pair.clauseIndex && l.logicalPair.setIndex === pair.setIndex)!;
    return lane.numberTargets.map(number => {
      const statement = declaredNumbers?.[pair.clauseIndex + ':' + pair.setIndex + ':' + number.numberIndex] ?? 'ambiguous';
      return { ...pair, numberIndex: number.numberIndex, projection: declaredNumberProjectionFixture(lane, number.numberIndex, statement) };
    });
  }) }) };
}

/** Explicit declarative mock, never a production text classifier. */
export function declaredNumberProjectionFixture(clause: { clauseIndex: number; text: string;
  numberCandidates: Array<{ numberIndex: number; numberQuote: string; occurrence: number; start: number; end: number; value: number | null; ordinal: boolean }> } | QuantityAuthorEvidenceLane,
  numberIndex: number, statement: 'affirmative_possession' | 'explicit_nonpossession' | 'no_possession_assertion' | 'ambiguous' = 'ambiguous') {
  const lane = 'logicalPair' in clause ? clause : buildQuantityAuthorEvidenceLane({ clauseIndex: clause.clauseIndex, setIndex: 0 },
    Array.from({ length: clause.clauseIndex + 1 }, (_, clauseIndex) => clauseIndex === clause.clauseIndex ? clause : { clauseIndex, text: '', numberCandidates: [] }));
  const id = lane.evidence.find(e => e.view === 'focus' && e.kind === 'text_segment')!.id;
  return { statement, laneId: lane.id, reviewedFocusId: lane.focusId, targetId: lane.numberTargets.find(t => t.numberIndex === numberIndex)!.targetId,
    semanticRoles: (statement === 'affirmative_possession' ? ['possession_predicate'] as const : statement === 'explicit_nonpossession' ? ['negative_scope'] as const : [])
      .map(role => ({ role, evidenceId: id })) };
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
      target: { kind: string; numberIndex?: number }; scopeObligation?: { assertionEvidenceIds: string[] }; evidence: Array<{ view: string; clauseIndex: number; text: string }> }> };
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
        evidenceRefs: [{ view: focus.view, clauseIndex: focus.clauseIndex }], targetScopeComplete: true, assertionEvidenceIds: check.scopeObligation?.assertionEvidenceIds ?? [], reason: '仅原机制test已声明的语义前提；不证明真实模型准确率。' };
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
