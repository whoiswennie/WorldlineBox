import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { quantityDisjointChecks, quantityDisjointInput, quantityDisjointWaiverSchema, validateQuantityDisjointWaivers,
  admitQuantityDisjointWaivers, type QuantityCollectionReview } from '../../src/main/companions/topic-quantity-disjoint-waiver';
import { reviewTopicSourceQuantities, topicQuantityNumberCandidates } from '../../src/main/companions/topic-summary-quantity-review';
import { topicSummaryClauses } from '../../src/main/companions/topic-summary-canon-review';
import { confirmedQuantitySourcePremiseFixture, declaredAllProjectionFixture } from '../helpers/companion-quantity-role-fixture';

const config = { apiFormat: 'openai_chat' as const, model: 'synthetic', apiKey: 'fixture-only' };
type Infer = NonNullable<Parameters<typeof reviewTopicSourceQuantities>[0]['verifyDisjointWaivers']>;
type Value = ReturnType<typeof quantityDisjointWaiverSchema.parse>;
type Basis = Value['reviews'][number]['basis'];
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
  return quantityDisjointInput(quantityDisjointChecks([c], [r]), [c], topicSummaryClauses(c.claimQuote, ''), mask);
}
const decision = (data: ReturnType<typeof dataFor>, verdict: Value['reviews'][number]['verdict'], witness = true, basis: Basis = 'different_inventory'): Value => ({
  reviews: data.checks.map(check => ({ checkIndex: check.checkIndex, verdict, basis: verdict === 'positive_exemption'
    ? check.target.kind === 'all' ? 'no_all_assertion' : basis : 'none',
  evidenceRefs: witness ? [{ view: 'focus', clauseIndex: check.evidence.find(item => item.view === 'focus')!.clauseIndex }] : [],
  reason: 'Independent decision, not a stored authority.',
  ...(check.target.kind === 'all' ? { allProjection: declaredAllProjectionFixture(check) } : {}) })),
});
const authority = { scope: { ownerId: 'reader', conversationId: 'room', topicId: 'topic' },
  evidence: [{ candidateIndex: 0, sourceQuoteChecksum: 'a'.repeat(64), focusChecksum: 'b'.repeat(64) }] };
const admit = (r: QuantityCollectionReview, value: Value, data: ReturnType<typeof dataFor>, c = candidate()) =>
  admitQuantityDisjointWaivers([r], quantityDisjointWaiverSchema.parse(value), data, authority, [c]);

it.each([
  { name: 'confirmed count conflict', c: candidate(), r: review(), risk: true },
  { name: 'confirmed missing member', c: candidate('她拿着第2把钥匙。'), r: review({ kind: 'member' }), risk: true },
  { name: 'holding versus total disagreement', c: candidate(), r: review({ relation: 'collection_size' }), risk: true },
  { name: 'explicit pure total', c: { ...candidate(), warmCountNumberIndexes: [] }, r: review({ relation: 'collection_size' }), risk: true },
  { name: 'unknown holding premise', c: candidate(), r: review({ voice: 'ambiguous' }), risk: true },
  { name: 'unresolved physical availability only', c: { ...candidate(), missingOrdinals: [], unresolvedSourceOrdinals: [2], availableUpperBound: 3 }, r: review(), risk: true },
  { name: 'safe count two but missing member two', c: candidate('她带两把钥匙。'), r: review(), risk: true },
  { name: 'safe count and member one', c: candidate('她带一把钥匙。'), r: review(), risk: false },
  { name: 'unknown complete number', c: candidate('她带两三把钥匙。'), r: review(), risk: false },
  { name: 'unrelated identifier', c: candidate('编号B204旁有钥匙。'), r: review({ voice: 'unrelated', relation: 'unrelated', kind: 'unrelated' }), risk: true },
  { name: 'attributed holding', c: candidate(), r: review({ voice: 'attributed_claim' }), risk: true },
  { name: 'question', c: candidate(), r: review({ voice: 'question' }), risk: true },
  { name: 'hypothesis', c: candidate(), r: review({ voice: 'hypothetical' }), risk: true },
  { name: 'earlier history', c: candidate(), r: review({ time: 'earlier_history' }), risk: true },
  { name: 'future', c: candidate(), r: review({ time: 'future' }), risk: true },
  { name: 'explicit missing', c: candidate(), r: review({ relation: 'missing' }), risk: true },
  { name: 'same collection', c: candidate(), r: review({ collection: 'same' }), risk: true },
  { name: 'unknown collection', c: candidate(), r: review({ collection: 'ambiguous' }), risk: true },
])('selects count/member counterfactuals independently of raw exemptions: $name', ({ c, r, risk }) => {
  const checks = quantityDisjointChecks([c], [r]);
  expect(checks.some(check => check.target.kind === 'number')).toBe(risk);
  expect(checks.some(check => check.target.kind === 'all')).toBe(true);
});

it.each([
  { relation: 'affirmed_all', voice: 'narrated_fact', time: 'scene', missing: [2], unresolved: [] },
  { relation: 'ambiguous', voice: 'ambiguous', time: 'scene', missing: [2], unresolved: [] },
  { relation: 'affirmed_all', voice: 'narrated_fact', time: 'scene', missing: [], unresolved: [2] },
  { relation: 'not_affirmed_all', voice: 'ambiguous', time: 'ambiguous', missing: [2], unresolved: [] },
  { relation: 'affirmed_all', voice: 'attributed_claim', time: 'scene', missing: [2], unresolved: [] },
  { relation: 'affirmed_all', voice: 'narrated_fact', time: 'earlier_history', missing: [2], unresolved: [] },
  { relation: 'affirmed_all', voice: 'hypothetical', time: 'future', missing: [2], unresolved: [] },
  { relation: 'not_affirmed_all', voice: 'narrated_fact', time: 'scene', missing: [], unresolved: [] },
])('selects all independently of every raw exemption axis: %j', test => {
  const c = { ...candidate('他把钥匙带齐。'), missingOrdinals: test.missing, unresolvedSourceOrdinals: test.unresolved };
  const checks = quantityDisjointChecks([c], [{ candidateIndex: 0, numbers: [], all: { ...noAll, ...test } }]);
  expect(checks.length).toBe(test.missing.length || test.unresolved.length ? 1 : 0);
  if (checks.length) expect(checks[0]!.target).toEqual({ kind: 'all' });
});

it.each(['no_exemption', 'unresolved', 'positive_exemption'] as const)('keeps raw axes immutable and returns separate unsupported-exemption pending: %s', verdict => {
  const original = review({ voice: 'attributed_claim' }), snapshot = JSON.stringify(original), data = dataFor(candidate(), original);
  const result = admit(original, decision(data, verdict, false), data);
  expect(JSON.stringify(original)).toBe(snapshot); expect(result.pending).toHaveLength(2);
  expect(result.pending.every(item => item.diagnosticType === 'unresolved_semantic_exemption')).toBe(true);
  expect(result.receipts[0]!.admitted).toBe(false); expect(result.receipts[0]!.authorityChecksum).toHaveLength(64);
});

it('admits an exact independently evidenced exemption only for its own numeral and never borrows it for all', () => {
  const c = candidate('本组带两把钥匙，别组带三把钥匙。'), r = { ...review(), numbers: [number({ numberIndex: 0 }), number({ numberIndex: 1 })], all: noAll };
  const data = dataFor(c, r); expect(data.checks.map(check => check.target)).toEqual([
    { kind: 'number', numberIndex: 0 }, { kind: 'number', numberIndex: 1 }, { kind: 'all' }]);
  const value = decision(data, 'unresolved');
  value.reviews[0] = { ...value.reviews[0]!, verdict: 'positive_exemption', basis: 'count_role' };
  value.reviews[1] = { ...value.reviews[1]!, verdict: 'positive_exemption', basis: 'different_inventory' };
  const result = admit(r, value, data, c);
  expect(result.receipts.map(item => item.admitted)).toEqual([true, true, false]);
  expect(result.pending.map(item => item.target)).toEqual([{ kind: 'all' }]);
});

it.each(['missing', 'duplicate', 'foreign_target', 'foreign_clause', 'foreign_view'] as const)('rejects fabricated coverage or evidence: %s', mode => {
  const data = dataFor(), value = decision(data, 'positive_exemption');
  if (mode === 'missing') value.reviews = [];
  if (mode === 'duplicate') value.reviews.push({ ...value.reviews[0]! });
  if (mode === 'foreign_target') value.reviews[0]!.checkIndex = 99;
  if (mode === 'foreign_clause') value.reviews[0]!.evidenceRefs[0]!.clauseIndex = 99;
  if (mode === 'foreign_view') value.reviews[0]!.evidenceRefs[0]!.view = 'before';
  expect(() => validateQuantityDisjointWaivers(quantityDisjointWaiverSchema.parse(value), data)).toThrow();
});

it('binds the opaque target to the actual UTF16 span rather than guessing numeric order or alias markers', () => {
  const c = candidate('😺B204有〔本目标数词〕标记，她另带三把钥匙。'), r = review({ numberIndex: 1 });
  const data = dataFor(c, r), check = data.checks[0]!, focus = check.evidence.find(item => item.view === 'focus')!;
  expect(check.targetMaskedSpan!.marker).not.toBe('〔本目标数词〕');
  expect(focus.text.slice(check.targetMaskedSpan!.start, check.targetMaskedSpan!.end)).toBe(check.targetMaskedSpan!.marker);
  expect(focus.text).not.toContain('204'); expect(focus.text).not.toContain('三'); expect(check.target).toEqual({ kind: 'number', numberIndex: 1 });
});

async function production(text: string, r: QuantityCollectionReview, verifyDisjointWaivers: Infer, unresolvedSource = false, memberFixture = false) {
  return reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses: topicSummaryClauses(text, ''),
    fetchFn: async () => { throw new Error('No external transport is allowed in an injected semantic fixture.'); },
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: unresolvedSource ? async context => {
      const value = await confirmedQuantitySourcePremiseFixture(context) as { sets: Array<{ members: Array<{ memberAvailability: string }> }> };
      for (const set of value.sets) for (const member of set.members) member.memberAvailability = 'ambiguous'; return value;
    } : confirmedQuantitySourcePremiseFixture,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: memberFixture ? [
      { setIndex: 0, usage: 'current_possessed_members', numberIndexes: r.numbers.filter(item => item.relation === 'affirmed_holding').map(item => item.numberIndex) },
      { setIndex: 0, usage: 'missing', numberIndexes: r.numbers.filter(item => item.relation === 'missing').map(item => item.numberIndex) },
    ] : [{ setIndex: 0, usage: r.numbers.length ? 'current_possessed_count' : 'current_possessed_all', numberIndexes: r.numbers.map(item => item.numberIndex) }] }] }),
    verifyRoles: async () => r && ({ reviews: [r] }), verifyDisjointWaivers });
}

it.each(['unresolved', 'no_exemption', 'positive_exemption'] as const)('runs the unified independent batch through production while preserving raw cold bytes: %s', async verdict => {
  const text = '她想起口袋里的三把钥匙，冰冷的金属贴在腿边。', r = review({ voice: 'attributed_claim', collection: 'ambiguous' }), snapshot = JSON.stringify(r);
  const verifyDisjointWaivers = vi.fn<Infer>(async context => {
    const { purpose, data } = JSON.parse(context.user);
    expect(purpose).toBe('topic_reply_quantity_semantic_exemption_verification');
    expect(context.user).not.toContain('SECRET_COLD_REASON'); expect(context.user).not.toContain('availableUpperBound');
    expect(context.user).not.toContain('missingOrdinals'); expect(context.system).not.toContain('宿主numberCandidates.value=null');
    expect(context.user).not.toContain('warmCount'); expect(context.user).not.toContain('countPotential');
    for (const check of data.checks) for (const evidence of check.evidence) expect(evidence.text).not.toMatch(/[\p{N}三二]/u);
    return decision(data, verdict, true, 'attributed_claim');
  });
  const correction = await production(text, r, verifyDisjointWaivers);
  expect(verifyDisjointWaivers).toHaveBeenCalledTimes(1); expect(JSON.stringify(r)).toBe(snapshot);
  if (verdict === 'positive_exemption') expect(correction).toBeUndefined();
  else { expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).not.toContain('mathematical_contradiction');
    expect(correction).toContain('quantity_semantic_exemption_v3'); expect(correction).toContain('"admitted":false'); }
});

it('binds the ephemeral receipt to exact source/draft authority without changing its independent input', () => {
  const data = dataFor(), value = quantityDisjointWaiverSchema.parse(decision(data, 'positive_exemption'));
  const first = admitQuantityDisjointWaivers([review()], value, data, authority, [candidate()]);
  const changed = admitQuantityDisjointWaivers([review()], value, data, { ...authority, evidence: [{ ...authority.evidence[0]!, focusChecksum: 'd'.repeat(64) }] }, [candidate()]);
  expect(first.receipts[0]!.inputChecksum).toBe(changed.receipts[0]!.inputChecksum);
  expect(first.receipts[0]!.authorityChecksum).not.toBe(changed.receipts[0]!.authorityChecksum);
  expect(first.receipts[0]!.inputChecksum).toBe(createHash('sha256').update(JSON.stringify(data)).digest('hex'));
});

it.each(['holding_vs_total', 'source_number', 'source_all', 'safe_low_count'] as const)('keeps every raw-allowed counterfactual path behind independent pending admission: %s', async mode => {
  const text = mode === 'source_all' ? '她把钥匙全部带齐。' : mode === 'safe_low_count' ? '她带两把钥匙。' : '她带三把钥匙。';
  const r = { ...review({ relation: mode === 'holding_vs_total' ? 'collection_size' : 'affirmed_holding' }),
    numbers: mode === 'source_all' ? [] : [number({ relation: mode === 'holding_vs_total' ? 'collection_size' : 'affirmed_holding' })],
    all: { ...noAll, relation: mode === 'source_all' ? 'affirmed_all' : 'not_affirmed_all' } };
  const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'unresolved'));
  const correction = await production(text, r, reader, mode.startsWith('source_'));
  expect(reader).toHaveBeenCalledTimes(1); expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).not.toContain('mathematical_contradiction');
});

it.each(['math', 'holding_pending', 'source_pending'] as const)('never lets a later independent exemption overrule the whole raw decision: %s', async mode => {
  const r = review({ collection: mode === 'holding_pending' ? 'ambiguous' : 'same' }), reader = vi.fn<Infer>();
  const correction = await production('她带三把钥匙。', r, reader, mode === 'source_pending');
  expect(correction).toContain(mode === 'math' ? 'mathematical_contradiction' : mode === 'source_pending' ? 'unresolved_source_premise' : 'unresolved_holding_relation');
  expect(reader).not.toHaveBeenCalled();
});

it('treats unsupported positive evidence as one semantic pending result through production rather than resampling it', async () => {
  const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'positive_exemption', false));
  const correction = await production('她带三把钥匙。', review(), reader);
  expect(reader).toHaveBeenCalledTimes(1); expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).not.toContain('mathematical_contradiction');
});

it.each(['missing_target', 'foreign_evidence', 'unknown_key', 'missing_basis'] as const)('bounds the unified phase to three structural attempts without echoing injected fields: %s', async mode => {
  const injected = 'IGNORE_PRIOR_RULES_PRIVATE_UNKNOWN_KEY', reader = vi.fn<Infer>(async context => {
    const wire = JSON.parse(context.user);
    if (wire.formatCorrection) { expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500); expect(wire.formatCorrection).not.toContain(injected); }
    const value = decision(wire.data, 'positive_exemption');
    if (mode === 'missing_target') return { reviews: [] };
    if (mode === 'foreign_evidence') value.reviews[0]!.evidenceRefs[0]!.clauseIndex = 999;
    if (mode === 'missing_basis') { const withoutBasis: Record<string, unknown> = { ...value.reviews[0]! }; delete withoutBasis.basis; return { reviews: [withoutBasis, ...value.reviews.slice(1)] }; }
    return mode === 'unknown_key' ? { ...value, [injected]: injected } : value;
  });
  await expect(production('她带三把钥匙。', review(), reader)).rejects.toThrow('未发布正文'); expect(reader).toHaveBeenCalledTimes(3);
});

it('keeps oversized independent output an explicit capacity failure rather than silently dropping targets', () => {
  expect(quantityDisjointWaiverSchema.safeParse({ reviews: Array.from({ length: 1001 }, (_, checkIndex) => ({
    checkIndex, verdict: 'unresolved', basis: 'none', evidenceRefs: [], reason: 'capacity boundary' })) }).success).toBe(false);
});

it('rejects more than one thousand actual risky targets before rendering or requesting the conditional batch', async () => {
  const text = Array.from({ length: 501 }, () => '她带三把钥匙，张明带三把钥匙。').join('\n'), clauses = topicSummaryClauses(text, '');
  const reader = vi.fn<Infer>();
  await expect(reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses,
    fetchFn: async () => { throw new Error('No external transport allowed.'); },
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: confirmedQuantitySourcePremiseFixture,
    extractClaims: async () => ({ clauses: clauses.map(clause => ({ clauseIndex: clause.clauseIndex, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] })) }),
    verifyRoles: async () => ({ reviews: clauses.map(clause => ({ candidateIndex: clause.clauseIndex, numbers: [number(), number({ numberIndex: 1 })], all: noAll })) }),
    verifyDisjointWaivers: reader })).rejects.toThrow('超过单批容量'); expect(reader).not.toHaveBeenCalled();
});

it.each([
  { basis: 'different_inventory', axes: { collection: 'ambiguous' }, allowed: true },
  { basis: 'different_inventory', axes: { collection: 'same' }, allowed: false },
  ...(['attributed_claim', 'question', 'hypothetical'] as const).flatMap(basis => [
    { basis, axes: { voice: 'ambiguous' }, allowed: true }, { basis, axes: { voice: 'narrated_fact' }, allowed: false },
    { basis, axes: { voice: 'question' }, allowed: true }]),
  { basis: 'earlier_history', axes: { time: 'ambiguous' }, allowed: true },
  { basis: 'earlier_history', axes: { time: 'scene' }, allowed: false },
  { basis: 'earlier_history', axes: { time: 'future' }, allowed: false },
  { basis: 'future', axes: { time: 'ambiguous' }, allowed: true },
  { basis: 'future', axes: { time: 'earlier_history' }, allowed: false },
  { basis: 'negative_or_missing', axes: { relation: 'missing' }, allowed: true },
  { basis: 'negative_or_missing', axes: { relation: 'ambiguous' }, allowed: true },
  { basis: 'negative_or_missing', axes: { relation: 'affirmed_holding' }, allowed: false },
  { basis: 'pure_collection_total', axes: { relation: 'collection_size' }, allowed: true },
  { basis: 'pure_collection_total', axes: { relation: 'affirmed_holding' }, allowed: false },
  { basis: 'unrelated_target', axes: { voice: 'unrelated', kind: 'unrelated', relation: 'unrelated' }, allowed: true },
  { basis: 'unrelated_target', axes: { kind: 'count', relation: 'unrelated' }, allowed: false },
  { basis: 'unrelated_target', axes: { kind: 'member', relation: 'ambiguous' }, allowed: false },
] as const)('admits one safe OR basis with unknown-compatible positive-opposition checks: %j', test => {
  const c = candidate(), r = review(test.axes), data = dataFor(c, r), value = decision(data, 'positive_exemption', true, test.basis);
  expect(admit(r, value, data, c).receipts[0]!.admitted).toBe(test.allowed);
});

it.each([
  { text: '她携带第1、3把钥匙。', index: 1, kind: 'member', basis: 'member_role', allowed: true },
  { text: '她携带第1、3把钥匙。', index: 1, kind: 'count', basis: 'member_role', allowed: false },
  { text: '她携带两把钥匙。', index: 0, kind: 'count', basis: 'count_role', allowed: true },
  { text: '她携带第2把钥匙。', index: 0, kind: 'ambiguous', basis: 'count_role', allowed: false },
  { text: '她携带两把钥匙。', index: 0, kind: 'member', basis: 'count_role', allowed: false },
  { text: '她携带第2把钥匙。', index: 0, kind: 'member', basis: 'member_role', allowed: false },
  { text: '她携带三把钥匙。', index: 0, kind: 'count', basis: 'count_role', allowed: false },
] as const)('requires the independent numeral role to leave zero count/member risk: %j', test => {
  const c = candidate(test.text), r = review({ numberIndex: test.index, kind: test.kind }), data = dataFor(c, r);
  const value = decision(data, 'positive_exemption', true, test.basis);
  expect(admit(r, value, data, c).receipts[0]!.admitted).toBe(test.allowed);
});

it.each(['not_affirmed_all', 'ambiguous', 'affirmed_all'])('admits independent no_all only against unknown or compatible all semantics: %s', relation => {
  const c = candidate('这里有钥匙。'), r = { ...review(), numbers: [], all: { ...noAll, relation } }, data = dataFor(c, r);
  const result = admit(r, decision(data, 'positive_exemption'), data, c);
  expect(result.receipts[0]!.admitted).toBe(relation !== 'affirmed_all');
});

it('does not let a role label hide a simultaneous count and missing-member risk or use a numeral role for all', () => {
  const c = { ...candidate(), missingOrdinals: [3], availableUpperBound: 2 }, r = review({ kind: 'ambiguous' }), data = dataFor(c, r);
  for (const basis of ['count_role', 'member_role'] as const) {
    const value = decision(data, 'positive_exemption', true, basis); value.reviews[1]!.basis = basis;
    expect(admit(r, value, data, c).receipts.map(item => item.admitted)).toEqual([false, false]);
  }
});

it('keeps known sibling risks and independent all after an unknown token, and admits no source-only witness', () => {
  const c = candidate('她带两三把钥匙，另带三把钥匙。'), r = { ...review(), numbers: [number(), number({ numberIndex: 1 })] }, data = dataFor(c, r);
  expect(data.checks.map(check => check.target)).toEqual([{ kind: 'number', numberIndex: 1 }, { kind: 'all' }]);
  const value = decision(data, 'positive_exemption'); for (const item of value.reviews) item.evidenceRefs = [{ view: 'source_identity', clauseIndex: 0 }];
  expect(admit(r, value, data, c).pending).toHaveLength(2);
});

it.each(['ambiguous', 'affirmed_all'])('uses independent no_all evidence through production without treating unknown as a contrary assertion: %s', async relation => {
  const r = { candidateIndex: 0, numbers: [], all: { ...noAll, voice: 'question', time: 'ambiguous', relation } };
  const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'positive_exemption'));
  const correction = await production('她问钥匙在哪里。', r, reader);
  expect(reader).toHaveBeenCalledTimes(1);
  if (relation === 'ambiguous') expect(correction).toBeUndefined();
  else { expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).toContain('opposed_raw_assertion'); }
});

it('still checks independent all once for a safe low nonmember while omitting its unnecessary numeric target', async () => {
  const reader = vi.fn<Infer>(async context => {
    const data = JSON.parse(context.user).data;
    expect(data.checks.map((check: { target: unknown }) => check.target)).toEqual([{ kind: 'all' }]);
    return decision(data, 'positive_exemption');
  });
  expect(await production('她带一把钥匙。', review({ collection: 'same' }), reader)).toBeUndefined();
  expect(reader).toHaveBeenCalledTimes(1);
});

it('records original raw classifications and residual-role failure only in host diagnostics', () => {
  const c = candidate(), r = review({ kind: 'count' }), data = dataFor(c, r), value = decision(data, 'positive_exemption', true, 'count_role');
  expect(JSON.stringify(data)).not.toContain('SECRET_COLD_REASON'); expect(JSON.stringify(data)).not.toContain('countPotential');
  const receipt = admit(r, value, data, c).receipts[0]!;
  expect(receipt.rawClassification).toEqual(r.numbers[0]); expect(receipt.admissionFailure).toBe('remaining_role_risk');
  expect(receipt.counterfactualRisks).toEqual({ count: true, member: false });
});

it('preserves the factive-cognition regression as independent pending even when raw attribution previously bypassed all risk', async () => {
  const r = { ...review({ collection: 'ambiguous', voice: 'attributed_claim' }), all: { ...noAll, collection: 'ambiguous' as const, voice: 'attributed_claim', relation: 'ambiguous' } };
  const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'no_exemption'));
  const correction = await production('她想起口袋里的三把钥匙，金属贴在腿边。', r, reader);
  expect(reader).toHaveBeenCalledTimes(1); expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).not.toContain('mathematical_contradiction');
});

it.each(['她说自己没有带三把钥匙。', '昨夜她曾携带三把钥匙。', '她会带三把钥匙吗？', '如果她日后带三把钥匙。'])(
  'retains explicit nonholding, earlier, question and hypothetical positive controls through the production batch: %s', async text => {
    const negative = text.includes('没有'), earlier = text.includes('昨夜'), question = text.includes('吗');
    const basis: Basis = negative ? 'negative_or_missing' : earlier ? 'earlier_history' : question ? 'question' : 'hypothetical';
    const r = review({ voice: negative ? 'attributed_claim' : question ? 'question' : earlier ? 'narrated_fact' : 'hypothetical',
      time: earlier ? 'earlier_history' : 'scene', relation: negative ? 'missing' : 'affirmed_holding' });
    const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'positive_exemption', true, basis));
    expect(await production(text, r, reader)).toBeUndefined(); expect(reader).toHaveBeenCalledTimes(1);
  });

it.each(['no_whole_set_assertion', 'explicit_not_all'] as const)('admits the original lawful partial-member scope through production with either supported projection: %s', async statement => {
  const text = '她实际只有第1和第3把钥匙，第2把仍未找到。';
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [number({ collection: 'same', kind: 'member' }),
    number({ numberIndex: 1, collection: 'same', kind: 'member' }), number({ numberIndex: 2, collection: 'same', kind: 'member', relation: 'missing' })],
  all: { ...noAll, collection: 'same' } };
  const reader = vi.fn<Infer>(async context => {
    const data = JSON.parse(context.user).data as ReturnType<typeof dataFor>;
    const value = decision(data, 'positive_exemption', true, 'negative_or_missing');
    const all = value.reviews.find(row => data.checks[row.checkIndex]!.target.kind === 'all')!;
    all.basis = statement === 'explicit_not_all' ? 'negative_or_missing' : 'no_all_assertion';
    all.allProjection = declaredAllProjectionFixture(data.checks[all.checkIndex]!, statement);
    expect(context.system).toContain('不是证明现实中不可能持齐');
    return value;
  });
  expect(await production(text, r, reader, false, true)).toBeUndefined(); expect(reader).toHaveBeenCalledTimes(1);
});

it.each(['她把整套钥匙收入随身衣袋。', '她把整套钥匙收入随身衣袋，却说没有全部带上。'])(
  'cannot discharge a positive whole-inventory projection with absence or a selected negative: %s', async text => {
    const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, collection: 'same' } };
    const reader = vi.fn<Infer>(async context => {
      const data = JSON.parse(context.user).data as ReturnType<typeof dataFor>, value = decision(data, 'positive_exemption');
      value.reviews[0]!.allProjection = declaredAllProjectionFixture(data.checks[0]!, 'affirmative_whole_set');
      return value;
    });
    const correction = await production(text, r, reader);
    expect(correction).toContain('all_projection_does_not_support_absence');
    expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).not.toContain('mathematical_contradiction');
    expect(reader).toHaveBeenCalledTimes(1);
  });

it.each(['这里的钥匙刻有字母。', '她站在钥匙柜旁。'])(
  'allows no-whole projection with a neutral literal target scope and no invented holding predicate: %s', async text => {
    const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, collection: 'same' } };
    const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'positive_exemption'));
    expect(await production(text, r, reader)).toBeUndefined(); expect(reader).toHaveBeenCalledTimes(1);
  });

it('keeps universality over an explicitly held subset separate from the whole inventory', async () => {
  const text = '第1和第3把钥匙都放在她的口袋，第2把钥匙仍未找到。';
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [number({ collection: 'same', kind: 'member' }),
    number({ numberIndex: 1, collection: 'same', kind: 'member' }), number({ numberIndex: 2, collection: 'same', kind: 'member', relation: 'missing' })], all: { ...noAll, collection: 'same' } };
  const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'positive_exemption', true, 'negative_or_missing'));
  expect(await production(text, r, reader, false, true)).toBeUndefined(); expect(reader).toHaveBeenCalledTimes(1);
});

it.each(['attributed_claim', 'earlier_history', 'future', 'different_inventory'] as const)(
  'retains a compatible independently evidenced safe OR basis for an actual whole-set proposition: %s', basis => {
    const c = candidate('她声称曾把整套钥匙带在身上。'), r: QuantityCollectionReview = { candidateIndex: 0, numbers: [],
      all: { ...noAll, voice: 'ambiguous', time: 'ambiguous', collection: 'ambiguous', relation: 'affirmed_all' } }, data = dataFor(c, r);
    const value = decision(data, 'positive_exemption'); value.reviews[0]!.basis = basis;
    value.reviews[0]!.allProjection = declaredAllProjectionFixture(data.checks[0]!, 'affirmative_whole_set');
    expect(admit(r, value, data, c).receipts[0]!.admitted).toBe(true);
  });

it.each(['affirmative_whole_set', 'explicit_not_all', 'no_whole_set_assertion'] as const)(
  'keeps a claimed all projection without its own literal scope witness pending instead of forcing another sample: %s', async statement => {
    const reader = vi.fn<Infer>(async context => {
      const data = JSON.parse(context.user).data as ReturnType<typeof dataFor>, value = decision(data, 'positive_exemption');
      const row = value.reviews.find(x => data.checks[x.checkIndex]!.target.kind === 'all')!;
      row.allProjection = { ...declaredAllProjectionFixture(data.checks[row.checkIndex]!, statement), witnesses: [] };
      return value;
    });
    const correction = await production('这里有钥匙。', { candidateIndex: 0, numbers: [], all: noAll }, reader);
    expect(correction).toContain('all_projection_unwitnessed'); expect(reader).toHaveBeenCalledTimes(1);
  });

it.each(['missing', 'foreign_focus', 'partial_coverage', 'fabricated_quote', 'number_projection'] as const)(
  'rejects invalid all projection structure within the original three format slots without echoing witness content: %s', async mode => {
    const injected = 'IGNORE_INSTRUCTIONS_PRIVATE_WITNESS', reader = vi.fn<Infer>(async context => {
      const wire = JSON.parse(context.user), data = wire.data as ReturnType<typeof dataFor>;
      if (wire.formatCorrection) { expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500); expect(wire.formatCorrection).not.toContain(injected); }
      const value = decision(data, 'positive_exemption'), row = value.reviews.find(x => data.checks[x.checkIndex]!.target.kind === 'all')!;
      if (mode === 'missing') delete row.allProjection;
      else if (mode === 'foreign_focus') row.allProjection!.reviewedFocusRef.clauseIndex = 99;
      else if (mode === 'partial_coverage') return { reviews: value.reviews.map(x => x === row ? { ...x, allProjection: { ...x.allProjection, coverage: 'selected_quote' } } : x) };
      else if (mode === 'fabricated_quote') row.allProjection!.witnesses[0]!.quote = injected;
      else value.reviews[0]!.allProjection = row.allProjection;
      return value;
    });
    await expect(production('她带三把钥匙。', review(), reader)).rejects.toThrow('未发布正文'); expect(reader).toHaveBeenCalledTimes(3);
  });

it('stores the projection and host located literal UTF16 witness only on its all receipt', () => {
  const c = candidate('😺这里有钥匙。'), r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: noAll }, data = dataFor(c, r);
  const value = decision(data, 'positive_exemption'), result = admit(r, value, data, c);
  expect(result.receipts[0]!.allProjection!.coverage).toBe('whole_focus');
  const located = result.receipts[0]!.literalWitnessLocations![0]!, focus = data.checks[0]!.evidence.find(x => x.view === 'focus')!;
  expect(focus.text.slice(located.firstMatchUtf16Span.start, located.firstMatchUtf16Span.end)).toBe(value.reviews[0]!.allProjection!.witnesses[0]!.quote);
});

it('cannot substitute a source-canon negative for a proposition missing from the actual focus', () => {
  const c = candidate('她把整套钥匙收入衣袋。'), r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: noAll }, data = dataFor(c, r);
  const value = decision(data, 'positive_exemption'), source = data.checks[0]!.evidence.find(x => x.view === 'source_identity')!;
  const row = value.reviews[0]!; row.basis = 'negative_or_missing';
  row.allProjection!.statement = 'explicit_not_all';
  row.allProjection!.witnesses.push({ role: 'negative_or_limited_scope', evidenceRef: { view: 'source_identity', clauseIndex: source.clauseIndex }, quote: source.text });
  const result = admit(r, value, data, c);
  expect(result.receipts[0]!.admissionFailure).toBe('all_projection_unwitnessed'); expect(result.pending).toHaveLength(1);
});

it.each(['not_affirmed_all', 'ambiguous'])('cannot waive a witnessed affirmative whole-inventory proposition as an unrelated target under raw %s', relation => {
  const c = candidate('她把整套钥匙收入随身衣袋。'), r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, relation } }, data = dataFor(c, r);
  const value = decision(data, 'positive_exemption'), row = value.reviews[0]!;
  row.basis = 'unrelated_target'; row.allProjection = declaredAllProjectionFixture(data.checks[0]!, 'affirmative_whole_set');
  const result = admit(r, value, data, c);
  expect(result.receipts[0]!.admissionFailure).toBe('whole_set_projection_incompatible_basis');
  expect(result.receipts[0]!.protocol).toBe('quantity_semantic_exemption_v3');
  expect(result.pending).toHaveLength(1); expect(result.pending[0]!.diagnosticType).toBe('unresolved_semantic_exemption');
});
