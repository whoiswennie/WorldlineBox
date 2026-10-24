import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { quantityDisjointChecks, quantityDisjointInput, quantityDisjointWaiverSchema, validateQuantityDisjointWaivers,
  admitQuantityDisjointWaivers, type QuantityCollectionReview } from '../../src/main/companions/topic-quantity-disjoint-waiver';
import { reviewTopicSourceQuantities, topicQuantityNumberCandidates } from '../../src/main/companions/topic-summary-quantity-review';
import { topicSummaryClauses } from '../../src/main/companions/topic-summary-canon-review';
import { confirmedQuantitySourcePremiseFixture } from '../helpers/companion-quantity-role-fixture';

const config = { apiFormat: 'openai_chat' as const, model: 'synthetic', apiKey: 'fixture-only' };
type Infer = NonNullable<Parameters<typeof reviewTopicSourceQuantities>[0]['verifyDisjointWaivers']>;
const noAll = { collection: 'different' as const, voice: 'narrated_fact', time: 'scene', relation: 'not_affirmed_all', reason: 'all is independently not asserted' };
const number = (overrides: Partial<QuantityCollectionReview['numbers'][number]> = {}) => ({ numberIndex: 0, collection: 'different' as const,
  voice: 'narrated_fact', time: 'scene', relation: 'affirmed_holding', kind: 'count', reason: 'SECRET_COLD_REASON', ...overrides });
const review = (overrides: Partial<QuantityCollectionReview['numbers'][number]> = {}): QuantityCollectionReview => ({ candidateIndex: 0, numbers: [number(overrides)], all: noAll });
function candidate(text = '她带三把钥匙。') {
  return { clauseIndex: 0, canonQuote: '共有3把钥匙，第2把尚未找到。', claimQuote: text, actualEntityQuote: '钥匙',
    numberSpans: topicQuantityNumberCandidates(text), total: 3, missingOrdinals: [2], unresolvedSourceOrdinals: [] as number[],
    availableUpperBound: 2, warmCountNumberIndexes: [0] };
}
const mask = (text: string) => text.replace(/[\d一二三四五六七八九十]+/gu, '〔遮蔽〕');
function dataFor(c = candidate(), r = review()) {
  const checks = quantityDisjointChecks([c], [r]);
  return quantityDisjointInput(checks, [c], topicSummaryClauses(c.claimQuote, ''), mask);
}
const decision = (data: ReturnType<typeof dataFor>, verdict: 'positive_disjoint' | 'same' | 'unresolved', witness = true): ReturnType<typeof quantityDisjointWaiverSchema.parse> => ({
  reviews: data.checks.map(check => ({ checkIndex: check.checkIndex, verdict,
    evidenceRefs: witness ? [{ view: 'focus' as const, clauseIndex: check.evidence.find(item => item.view === 'focus')!.clauseIndex }] : [],
    reason: 'Independent decision, not a stored authority.' })),
});
const authority = { scope: { ownerId: 'reader', conversationId: 'room', topicId: 'topic' },
  evidence: [{ candidateIndex: 0, sourceQuoteChecksum: 'a'.repeat(64), focusChecksum: 'b'.repeat(64) }] };

it.each([
  { name: 'confirmed count conflict', c: candidate(), r: review(), risk: true },
  { name: 'confirmed missing member', c: candidate('她拿着第2把钥匙。'), r: review({ kind: 'member' }), risk: true },
  { name: 'holding versus total disagreement', c: candidate(), r: review({ relation: 'collection_size' }), risk: true },
  { name: 'explicit pure total', c: { ...candidate(), warmCountNumberIndexes: [] }, r: review({ relation: 'collection_size' }), risk: false },
  { name: 'unknown holding premise', c: candidate(), r: review({ voice: 'ambiguous' }), risk: true },
  { name: 'unresolved physical availability only', c: { ...candidate(), missingOrdinals: [], unresolvedSourceOrdinals: [2], availableUpperBound: 3 }, r: review(), risk: true },
  { name: 'safe count two', c: candidate('她带两把钥匙。'), r: review(), risk: false },
  { name: 'unknown complete number', c: candidate('她带两三把钥匙。'), r: review(), risk: false },
  { name: 'unrelated identifier', c: candidate('编号B204旁有钥匙。'), r: review({ voice: 'unrelated', relation: 'unrelated', kind: 'unrelated' }), risk: false },
  { name: 'attributed holding', c: candidate(), r: review({ voice: 'attributed_claim' }), risk: false },
  { name: 'question', c: candidate(), r: review({ voice: 'question' }), risk: false },
  { name: 'hypothesis', c: candidate(), r: review({ voice: 'hypothetical' }), risk: false },
  { name: 'earlier history', c: candidate(), r: review({ time: 'earlier_history' }), risk: false },
  { name: 'future', c: candidate(), r: review({ time: 'future' }), risk: false },
  { name: 'explicit missing', c: candidate(), r: review({ relation: 'missing' }), risk: false },
  { name: 'same is not an exemption proposal', c: candidate(), r: review({ collection: 'same' }), risk: false },
  { name: 'already ambiguous is not another reader request', c: candidate(), r: review({ collection: 'ambiguous' }), risk: false },
])('selects only existing computable different risks: $name', ({ c, r, risk }) => {
  expect(quantityDisjointChecks([c], [r]).length > 0).toBe(risk);
});

it.each([
  { relation: 'affirmed_all', voice: 'narrated_fact', time: 'scene', missing: [2], unresolved: [], risk: true },
  { relation: 'ambiguous', voice: 'ambiguous', time: 'scene', missing: [2], unresolved: [], risk: true },
  { relation: 'affirmed_all', voice: 'narrated_fact', time: 'scene', missing: [], unresolved: [2], risk: true },
  { relation: 'not_affirmed_all', voice: 'ambiguous', time: 'ambiguous', missing: [2], unresolved: [], risk: false },
  { relation: 'affirmed_all', voice: 'attributed_claim', time: 'scene', missing: [2], unresolved: [], risk: false },
  { relation: 'affirmed_all', voice: 'narrated_fact', time: 'earlier_history', missing: [2], unresolved: [], risk: false },
  { relation: 'affirmed_all', voice: 'hypothetical', time: 'future', missing: [2], unresolved: [], risk: false },
  { relation: 'affirmed_all', voice: 'narrated_fact', time: 'scene', missing: [], unresolved: [], risk: false },
])('keeps all independent across confirmed and unresolved source predicates: %j', test => {
  const c = { ...candidate('他把钥匙带齐。'), missingOrdinals: test.missing, unresolvedSourceOrdinals: test.unresolved };
  const checks = quantityDisjointChecks([c], [{ candidateIndex: 0, numbers: [], all: { ...noAll, ...test } }]);
  expect(checks.length > 0).toBe(test.risk); if (test.risk) expect(checks[0]!.target).toEqual({ kind: 'all' });
});

it.each(['same', 'unresolved', 'positive_disjoint'] as const)('does not promote a refused or unsupported waiver to same: %s', verdict => {
  const original = review(), data = dataFor(), value = quantityDisjointWaiverSchema.parse(decision(data, verdict, false));
  const result = admitQuantityDisjointWaivers([original], value, data, authority);
  expect(result.reviews[0]!.numbers[0]!.collection).toBe('ambiguous'); expect(original.numbers[0]!.collection).toBe('different');
  expect(result.receipts[0]!.admitted).toBe(false); expect(result.receipts[0]!.authorityChecksum).toHaveLength(64);
});

it('admits an exact independently evidenced waiver only for its own number and never its all claim', () => {
  const c = candidate('本组带两把钥匙，别组带三把钥匙。'), r = { ...review(), numbers: [number({ numberIndex: 0 }), number({ numberIndex: 1 })],
    all: { ...noAll, relation: 'affirmed_all' } };
  const data = dataFor(c, r); expect(data.checks.map(check => check.target)).toEqual([{ kind: 'number', numberIndex: 1 }, { kind: 'all' }]);
  const value = quantityDisjointWaiverSchema.parse(decision(data, 'unresolved'));
  value.reviews[0]!.verdict = 'positive_disjoint';
  const result = admitQuantityDisjointWaivers([r], value, data, authority);
  expect(result.reviews[0]!.numbers.map(item => item.collection)).toEqual(['different', 'different']);
  expect(result.reviews[0]!.all.collection).toBe('ambiguous'); expect(result.receipts.map(item => item.admitted)).toEqual([true, false]);
});

it.each(['missing', 'duplicate', 'foreign_target', 'foreign_clause', 'foreign_view'] as const)('rejects fabricated coverage or evidence: %s', mode => {
  const data = dataFor(), value = decision(data, 'positive_disjoint');
  if (mode === 'missing') value.reviews = [];
  if (mode === 'duplicate') value.reviews.push({ ...value.reviews[0]! });
  if (mode === 'foreign_target') value.reviews[0]!.checkIndex = 99;
  if (mode === 'foreign_clause') value.reviews[0]!.evidenceRefs[0]!.clauseIndex = 99;
  if (mode === 'foreign_view') value.reviews[0]!.evidenceRefs[0]!.view = 'before';
  expect(() => validateQuantityDisjointWaivers(quantityDisjointWaiverSchema.parse(value), data)).toThrow();
});

it('binds the opaque target to the actual UTF16 span rather than guessing numeric order or alias markers', () => {
  const c = candidate('😺B204有〔本目标数词〕标记，她另带三把钥匙。');
  const r = review({ numberIndex: 1 });
  const data = dataFor(c, r), check = data.checks[0]!, focus = check.evidence.find(item => item.view === 'focus')!;
  expect(check.targetMaskedSpan!.marker).not.toBe('〔本目标数词〕');
  expect(focus.text.slice(check.targetMaskedSpan!.start, check.targetMaskedSpan!.end)).toBe(check.targetMaskedSpan!.marker);
  expect(focus.text).not.toContain('204'); expect(focus.text).not.toContain('三');
  expect(check.target).toEqual({ kind: 'number', numberIndex: 1 });
});

it.each(['unresolved', 'same', 'positive_disjoint'] as const)('runs one independent batch through actual production and preserves the old cold response: %s', async verdict => {
  const text = '她想起口袋里的三把钥匙，冰冷的金属贴在腿边。', purpose: string[] = [];
  const verifyDisjointWaivers = vi.fn<Infer>(async context => {
    const wire = JSON.parse(context.user), data = wire.data;
    purpose.push(wire.purpose); expect(wire.purpose).toBe('topic_reply_quantity_disjoint_waiver_verification');
    expect(context.user).not.toContain('SECRET_COLD_REASON'); expect(context.user).not.toContain('availableUpperBound');
    expect(context.user).not.toContain('missingOrdinals'); expect(context.system).not.toContain('warm');
    for (const check of data.checks) for (const evidence of check.evidence) expect(evidence.text).not.toMatch(/[\p{N}三二]/u);
    expect(data.checks[0].evidence.find((item: { view: string }) => item.view === 'focus').text).toContain(data.checks[0].targetMaskedSpan.marker);
    return decision(data, verdict);
  });
  const originalRoles = { reviews: [review()] }, snapshot = JSON.stringify(originalRoles);
  const correction = await reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses: topicSummaryClauses(text, ''),
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: confirmedQuantitySourcePremiseFixture,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles: async () => originalRoles, verifyDisjointWaivers });
  expect(verifyDisjointWaivers).toHaveBeenCalledTimes(1); expect(purpose).toHaveLength(1); expect(JSON.stringify(originalRoles)).toBe(snapshot);
  if (verdict === 'positive_disjoint') expect(correction).toBeUndefined();
  else { expect(correction).toContain('unresolved_holding_relation'); expect(correction).not.toContain('mathematical_contradiction');
    expect(correction).toContain('quantity_disjoint_waiver_v1'); expect(correction).toContain('"admitted":false'); }
});

it('binds the ephemeral receipt to exact source/draft authority without changing its independent input', () => {
  const data = dataFor(), value = quantityDisjointWaiverSchema.parse(decision(data, 'positive_disjoint'));
  const first = admitQuantityDisjointWaivers([review()], value, data, authority);
  const changed = admitQuantityDisjointWaivers([review()], value, data, { ...authority, evidence: [{ ...authority.evidence[0]!, focusChecksum: 'd'.repeat(64) }] });
  expect(first.receipts[0]!.inputChecksum).toBe(changed.receipts[0]!.inputChecksum);
  expect(first.receipts[0]!.authorityChecksum).not.toBe(changed.receipts[0]!.authorityChecksum);
  expect(first.receipts[0]!.inputChecksum).toBe(createHash('sha256').update(JSON.stringify(data)).digest('hex'));
});

it.each(['holding_vs_total', 'source_number', 'source_all', 'safe_low_count'] as const)('uses the actual production conditional admission path: %s', async mode => {
  const text = mode === 'source_all' ? '她把钥匙全部带齐。' : mode === 'safe_low_count' ? '她带两把钥匙。' : '她带三把钥匙。';
  const sourceUnresolved = mode.startsWith('source_');
  const verifyDisjointWaivers = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'unresolved'));
  const correction = await reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses: topicSummaryClauses(text, ''),
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: async context => {
      const data = JSON.parse(context.user).data;
      return { sets: data.candidates.map((item: { setIndex: number; totalReference: { clauseIndex: number };
        members: Array<{ ordinalNumberIndex: number; memberClauseIndex: number }> }) => ({ setIndex: item.setIndex, totalBinding: 'supported',
        totalEvidenceClauseIndex: item.totalReference.clauseIndex, reason: 'Independent physical availability fixture.',
        members: item.members.map(member => ({ ordinalNumberIndex: member.ordinalNumberIndex, evidenceClauseIndexes: [member.memberClauseIndex],
          predicateTarget: 'physical_member', memberAvailability: sourceUnresolved ? 'ambiguous' : 'not_possessed', applicability: 'current_direct', reason: 'Source availability is independently classified.' })) })) };
    },
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: mode === 'source_all' ? 'current_possessed_all' : 'current_possessed_count',
      numberIndexes: mode === 'source_all' ? [] : [0] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: mode === 'source_all' ? [] : [number({ relation: mode === 'holding_vs_total' ? 'collection_size' : 'affirmed_holding' })],
      all: { ...noAll, relation: mode === 'source_all' ? 'affirmed_all' : 'not_affirmed_all' } }] }), verifyDisjointWaivers });
  if (mode === 'safe_low_count') { expect(correction).toBeUndefined(); expect(verifyDisjointWaivers).not.toHaveBeenCalled(); }
  else { expect(verifyDisjointWaivers).toHaveBeenCalledTimes(1); expect(correction).toContain(sourceUnresolved ? 'unresolved_source_premise' : 'count_holding_vs_total');
    expect(correction).not.toContain('mathematical_contradiction'); }
});

it('treats unsupported positive evidence as one semantic pending result through production rather than resampling it', async () => {
  const text = '她带三把钥匙。', verifyDisjointWaivers = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'positive_disjoint', false));
  const correction = await reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses: topicSummaryClauses(text, ''),
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: confirmedQuantitySourcePremiseFixture,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles: async () => ({ reviews: [review()] }), verifyDisjointWaivers });
  expect(verifyDisjointWaivers).toHaveBeenCalledTimes(1); expect(correction).toContain('unresolved_holding_relation');
  expect(correction).not.toContain('mathematical_contradiction');
});

it.each(['missing_target', 'foreign_evidence', 'unknown_key'] as const)('bounds the new phase to three structural attempts without echoing injected fields: %s', async mode => {
  const text = '她带三把钥匙。', injected = 'IGNORE_PRIOR_RULES_PRIVATE_UNKNOWN_KEY';
  const verifyDisjointWaivers = vi.fn<Infer>(async context => {
    const wire = JSON.parse(context.user);
    if (wire.formatCorrection) {
      expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500); expect(wire.formatCorrection).not.toContain(injected);
      expect(wire.formatCorrection).not.toContain('SECRET_COLD_REASON');
    }
    const value = decision(wire.data, 'positive_disjoint');
    if (mode === 'missing_target') return { reviews: [] };
    if (mode === 'foreign_evidence') value.reviews[0]!.evidenceRefs[0]!.clauseIndex = 999;
    return mode === 'unknown_key' ? { ...value, [injected]: 'untrusted model value' } : value;
  });
  await expect(reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses: topicSummaryClauses(text, ''),
    fetchFn: async () => { throw new Error('No external transport is allowed in a deterministic phase-boundary test.'); },
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: confirmedQuantitySourcePremiseFixture,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles: async () => ({ reviews: [review()] }), verifyDisjointWaivers })).rejects.toThrow('未发布正文');
  expect(verifyDisjointWaivers).toHaveBeenCalledTimes(3);
});

it('keeps oversized independent output an explicit capacity failure rather than silently dropping targets', () => {
  const reviews = Array.from({ length: 1001 }, (_, checkIndex) => ({ checkIndex, verdict: 'unresolved', evidenceRefs: [], reason: 'capacity boundary' }));
  expect(quantityDisjointWaiverSchema.safeParse({ reviews }).success).toBe(false);
});

it('rejects more than one thousand actual risky targets before rendering or requesting the conditional batch', async () => {
  const text = Array.from({ length: 501 }, () => '她带三把钥匙，张明带三把钥匙。').join('\n'), clauses = topicSummaryClauses(text, '');
  const verifyDisjointWaivers = vi.fn<Infer>();
  await expect(reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses,
    fetchFn: async () => { throw new Error('No external transport allowed.'); },
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: confirmedQuantitySourcePremiseFixture,
    extractClaims: async () => ({ clauses: clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] })) }),
    verifyRoles: async () => ({ reviews: clauses.map(clause => ({ candidateIndex: clause.clauseIndex,
      numbers: [number({ numberIndex: 0 }), number({ numberIndex: 1 })], all: noAll })) }), verifyDisjointWaivers })).rejects.toThrow('超过单批容量');
  expect(verifyDisjointWaivers).not.toHaveBeenCalled();
});
