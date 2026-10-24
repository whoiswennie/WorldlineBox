import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { quantityDisjointChecks, quantityDisjointInput, quantityDisjointWaiverSchema, validateQuantityDisjointWaivers,
  admitQuantityDisjointWaivers, quantityAuthorAllProjectionSchema, quantityAuthorAllProjectionAdmission as actualAllAdmission, validateQuantityAuthorAllProjection, deriveQuantityAuthorAllProjection as actualAllDerive, buildQuantityAuthorEvidenceLane,
  quantityAuthorNumberProjectionSchema, validateQuantityAuthorNumberProjection, bindQuantityHostNumberTarget, quantityAuthorNumberProjectionAdmission,
  type QuantityAuthorAllProjection, type QuantityAuthorNumberProjection, type QuantityCollectionReview } from '../../src/main/companions/topic-quantity-disjoint-waiver';
import { reviewTopicSourceQuantities, topicQuantityNumberCandidates } from '../../src/main/companions/topic-summary-quantity-review';
import { topicSummaryClauses } from '../../src/main/companions/topic-summary-canon-review';
import { confirmedQuantitySourcePremiseFixture, declaredAllProjectionFixture, declaredWarmAllFixture, declaredNumberProjectionFixture } from '../helpers/companion-quantity-role-fixture';

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
  c = bindDeclaredCandidate(c);
  return quantityDisjointInput(quantityDisjointChecks([c], [r]), [c], topicSummaryClauses(c.claimQuote, ''), mask);
}
const decision = (data: ReturnType<typeof dataFor>, verdict: Value['reviews'][number]['verdict'], witness = true, basis: Basis = 'different_inventory'): Value => ({
  reviews: data.checks.map(check => ({ checkIndex: check.checkIndex, verdict, basis: verdict === 'positive_exemption'
    ? check.target.kind === 'all' ? 'different_inventory' : basis : 'none',
  targetScopeComplete: true, assertionEvidenceIds: check.scopeObligation?.assertionEvidenceIds ?? [],
  evidenceRefs: witness ? [{ view: 'focus', clauseIndex: check.evidence.find(item => item.view === 'focus')!.clauseIndex }] : [],
  reason: 'Independent decision, not a stored authority.' })),
});
const authority = { scope: { ownerId: 'reader', conversationId: 'room', topicId: 'topic' },
  evidence: [{ candidateIndex: 0, sourceQuoteChecksum: 'a'.repeat(64), focusChecksum: 'b'.repeat(64) }] };
const admit = (r: QuantityCollectionReview, value: Value, data: ReturnType<typeof dataFor>, c = candidate()) =>
  admitQuantityDisjointWaivers([r], quantityDisjointWaiverSchema.parse(value), data, authority, [bindDeclaredCandidate(c)]);

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

it('distinguishes invalid assertion IDs from valid clause references and preserves missing-all-ID semantic pending', () => {
  const data = dataFor(), value = decision(data, 'positive_exemption'), numberCheck = data.checks.find(check => check.target.kind === 'number')!;
  const row = value.reviews[numberCheck.checkIndex]!, originalRefs = structuredClone(row.evidenceRefs);
  row.assertionEvidenceIds = [numberCheck.evidence.find(evidence => evidence.view === 'focus')!.textChecksum];
  expect(quantityDisjointWaiverSchema.safeParse(value).success).toBe(true);
  expect(row.evidenceRefs).toEqual(originalRefs);
  expect(() => validateQuantityDisjointWaivers(value, data)).toThrow('assertionEvidenceIds');
  row.assertionEvidenceIds = [];
  expect(() => validateQuantityDisjointWaivers(value, data)).not.toThrow();
  row.evidenceRefs[0]!.clauseIndex = 999;
  expect(() => validateQuantityDisjointWaivers(value, data)).toThrow('数量语义豁免证据须引用本目标实际有界原句。');

  const text = '他说整套钥匙都带走了，她也声称带齐。', { projection } = twoWholeFixture(text), c = propositionCandidate(text, projection);
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, voice: 'ambiguous', collection: 'ambiguous' } };
  const allData = dataFor(c, r), allValue = decision(allData, 'positive_exemption');
  expect(allData.checks[0]!.scopeObligation!.assertionEvidenceIds.length).toBeGreaterThan(0);
  expect(() => validateQuantityDisjointWaivers(allValue, allData)).not.toThrow();
  allValue.reviews[0]!.assertionEvidenceIds = [allData.checks[0]!.evidence.find(evidence => evidence.view === 'focus')!.textChecksum];
  expect(() => validateQuantityDisjointWaivers(allValue, allData)).toThrow('assertionEvidenceIds');
  for (const review of allValue.reviews) delete review.assertionEvidenceIds;
  expect(() => validateQuantityDisjointWaivers(allValue, allData)).not.toThrow();
  expect(admit(r, allValue, allData, c).pending).toHaveLength(allData.checks.length);
});

it('binds the opaque target to the actual UTF16 span rather than guessing numeric order or alias markers', () => {
  const c = candidate('😺B204有〔本目标数词〕标记，她另带三把钥匙。'), r = review({ numberIndex: 1 });
  const data = dataFor(c, r), check = data.checks[0]!, focus = check.evidence.find(item => item.view === 'focus')!;
  expect(check.targetMaskedSpan!.marker).not.toBe('〔本目标数词〕');
  expect(focus.text.slice(check.targetMaskedSpan!.start, check.targetMaskedSpan!.end)).toBe(check.targetMaskedSpan!.marker);
  expect(focus.text).not.toContain('204'); expect(focus.text).not.toContain('三'); expect(check.target).toEqual({ kind: 'number', numberIndex: 1 });
});

async function production(text: string, r: QuantityCollectionReview, verifyDisjointWaivers: Infer, unresolvedSource = false, memberFixture = false,
  projection?: QuantityAuthorAllProjection | ((context: { user: string }, value: unknown) => unknown),
  numberStatements?: Parameters<typeof declaredWarmAllFixture>[3]) {
  return reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses: topicSummaryClauses(text, ''),
    fetchFn: async () => { throw new Error('No external transport is allowed in an injected semantic fixture.'); },
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: unresolvedSource ? async context => {
      const value = await confirmedQuantitySourcePremiseFixture(context) as { sets: Array<{ members: Array<{ memberAvailability: string }> }> };
      for (const set of value.sets) for (const member of set.members) member.memberAvailability = 'ambiguous'; return value;
    } : confirmedQuantitySourcePremiseFixture,
    extractClaims: async context => { const value = { clauses: [{ clauseIndex: 0, quantities: memberFixture ? [
      { setIndex: 0, usage: 'current_possessed_members', numberIndexes: r.numbers.filter(item => item.relation === 'affirmed_holding').map(item => item.numberIndex) },
      { setIndex: 0, usage: 'missing', numberIndexes: r.numbers.filter(item => item.relation === 'missing').map(item => item.numberIndex) },
    ] : [{ setIndex: 0, usage: r.numbers.length ? 'current_possessed_count' : 'current_possessed_all', numberIndexes: r.numbers.map(item => item.numberIndex) }] }],
    allProjections: [{ clauseIndex: 0, setIndex: 0, projection: typeof projection === 'object' ? projection
      : declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: 0, text }] }, 'ambiguous') }] };
      const complete = declaredWarmAllFixture(context, value, undefined, numberStatements);
      return typeof projection === 'function' ? projection(context, complete) : complete; },
    verifyRoles: async () => r && ({ reviews: [r] }), verifyDisjointWaivers });
}

it('lets production infer repair invalid assertion IDs in its next original slot without changing semantics or clause references', async () => {
  const text = '他说她带三把钥匙。', r = review({ voice: 'attributed_claim', collection: 'ambiguous' }), rawSnapshot = JSON.stringify(r);
  let attempts = 0, firstData: string, firstSchema: string, firstSemantics: string, rejectedIDs: string[] = [];
  const reader = vi.fn<Infer>(async context => {
    const wire = JSON.parse(context.user), value = decision(wire.data, 'positive_exemption', true, 'attributed_claim');
    expect(wire.data.checks).toHaveLength(1); expect(wire.data.checks[0].target.kind).toBe('number');
    const semanticCopy = structuredClone(value); for (const row of semanticCopy.reviews) delete row.assertionEvidenceIds;
    if (++attempts === 1) {
      expect(wire.formatCorrection).toBeUndefined();
      firstData = JSON.stringify(wire.data); firstSchema = JSON.stringify(wire.outputSchema); firstSemantics = JSON.stringify(semanticCopy);
      rejectedIDs = wire.data.checks[0].evidence.map((evidence: { textChecksum: string }) => evidence.textChecksum);
      value.reviews[0]!.assertionEvidenceIds = rejectedIDs;
      expect(quantityDisjointWaiverSchema.safeParse(value).success).toBe(true);
      return value; // The real infer validator must reject this exact first slot.
    }
    expect(attempts).toBe(2);
    expect(wire.formatCorrection).toContain('assertionEvidenceIds');
    expect(wire.formatCorrection).toContain('scopeObligation.assertionEvidenceIds');
    expect(wire.formatCorrection).toContain('number目标须省略或返回空数组');
    expect(wire.formatCorrection).toContain('textChecksum不是该ID');
    expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500);
    for (const rejected of rejectedIDs) expect(wire.formatCorrection).not.toContain(rejected);
    expect(JSON.stringify(wire.data)).toBe(firstData); expect(JSON.stringify(wire.outputSchema)).toBe(firstSchema);
    expect(JSON.stringify(semanticCopy)).toBe(firstSemantics);
    return value;
  });
  const correction = await production(text, r, reader, false, false, authorProjection(text, 'no_whole_set_assertion'));
  expect(correction).toBeUndefined(); expect(reader).toHaveBeenCalledTimes(2); expect(JSON.stringify(r)).toBe(rawSnapshot);
});

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
    expect(correction).toContain('quantity_semantic_exemption_v9'); expect(correction).toContain('"admitted":false'); }
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
  const correction = await reviewTopicSourceQuantities({ kind: 'reply', config, summary: text, stage: '', clauses,
    fetchFn: async () => { throw new Error('No external transport allowed.'); },
    canon: { version: 1, throughSequence: 1, entries: [{ id: 'source', quote: '共有3把钥匙，第2把尚未找到。', rule: '', sourceMessageId: 'actual', sourceChecksum: 'c'.repeat(64) }] },
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: confirmedQuantitySourcePremiseFixture,
    extractClaims: async () => ({ clauses: clauses.map(clause => ({ clauseIndex: clause.clauseIndex, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] })),
      allProjections: clauses.map(clause => ({ clauseIndex: clause.clauseIndex, setIndex: 0, projection: declaredAllProjectionFixture({ evidence: [{ view: 'focus', ...clause }] }, 'ambiguous') })) }),
    verifyRoles: async () => ({ reviews: clauses.map(clause => ({ candidateIndex: clause.clauseIndex, numbers: [number(), number({ numberIndex: 1 })], all: noAll })) }),
    verifyDisjointWaivers: reader });
  expect(correction).toContain('unresolved_author_projection_capacity'); expect(correction).toContain('超过单批容量'); expect(reader).not.toHaveBeenCalled();
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
  // Preserve the old title while explicitly retiring its source-aware syntax authority.
  expect(admit(r, value, data, c).receipts[0]!.admitted).toBe(['negative_or_missing', 'pure_collection_total', 'unrelated_target'].includes(test.basis) ? false : test.allowed);
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
  const text = '这里有钥匙。', c = { ...candidate(text), authorAllProjection: declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: 0, text }] }) };
  expect(quantityAuthorAllProjectionAdmission(c, { ...noAll, relation }).safeAbsence).toBe(relation !== 'affirmed_all');
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
  const text = '她问钥匙在哪里。', correction = await production(text, r, reader, false, false,
    declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: 0, text }] }));
  expect(reader).not.toHaveBeenCalled();
  if (relation === 'ambiguous') expect(correction).toBeUndefined();
  else { expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).toContain('opposed_raw_author_projection'); }
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
    expect(await production(text, r, reader, false, false, undefined, negative ? { '0:0:0': 'explicit_nonpossession' } : undefined)).toBeUndefined(); expect(reader).toHaveBeenCalledTimes(1);
  });

const projectionTexts = new WeakMap<object, string>();
function authorProjection(text: string, statement: Parameters<typeof declaredAllProjectionFixture>[1]) {
  const projection = declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: 0, text }] }, statement);
  projectionTexts.set(projection, text); return projection;
}
function bindDeclaredCandidate<T extends Parameters<typeof actualAllAdmission>[0]>(c: T) {
  const projection = (c as T & { authorAllProjection?: QuantityAuthorAllProjection }).authorAllProjection;
  if (!projection) return c;
  const clauses = numericClauses(c.claimQuote), lane = buildQuantityAuthorEvidenceLane({ clauseIndex: c.clauseIndex, setIndex: 0 }, clauses);
  return { ...c, authorEvidenceLane: lane, authorAllPair: { clauseIndex: c.clauseIndex, setIndex: 0 },
    authorAllWitnessLocations: validateQuantityAuthorAllProjection(projection, c.clauseIndex, clauses, lane) };
}
function quantityAuthorAllProjectionAdmission(c: Parameters<typeof actualAllAdmission>[0], raw: Parameters<typeof actualAllAdmission>[1]) {
  return actualAllAdmission(bindDeclaredCandidate(c), raw);
}
function deriveQuantityAuthorAllProjection(projection: QuantityAuthorAllProjection, clauseIndex: number) {
  const text = projectionTexts.get(projection); if (!text) return actualAllDerive(projection, clauseIndex);
  return actualAllDerive(projection, clauseIndex, validateQuantityAuthorAllProjection(projection, clauseIndex, numericClauses(text)));
}

it.each(['no_whole_set_assertion', 'explicit_not_all'] as const)('admits the original lawful partial-member scope through production with either supported projection: %s', async statement => {
  const text = '她实际只有第1和第3把钥匙，第2把仍未找到。';
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [number({ collection: 'same', kind: 'member' }),
    number({ numberIndex: 1, collection: 'same', kind: 'member' }), number({ numberIndex: 2, collection: 'same', kind: 'member', relation: 'missing' })], all: { ...noAll, collection: 'same' } };
  const reader = vi.fn<Infer>(async context => { const data = JSON.parse(context.user).data as ReturnType<typeof dataFor>;
    expect(data.checks.every(check => check.target.kind === 'number')).toBe(true);
    return decision(data, 'positive_exemption', true, 'negative_or_missing'); });
  expect(await production(text, r, reader, false, true, authorProjection(text, statement), { '0:0:2': 'explicit_nonpossession' })).toBeUndefined();
  expect(reader).not.toHaveBeenCalled(); // Witnessed blind number/all absence needs no source-aware approval.
});

it.each(['她把整套钥匙收入随身衣袋。', '她把整套钥匙收入随身衣袋，却说没有全部带上。'])(
  'cannot discharge a positive whole-inventory projection with absence or a selected negative: %s', async text => {
    const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, collection: 'same' } };
    const reader = vi.fn<Infer>(async context => { const value = decision(JSON.parse(context.user).data, 'positive_exemption'); value.reviews[0]!.basis = 'no_all_assertion'; return value; });
    const correction = await production(text, r, reader, false, false, authorProjection(text, 'affirmative_whole_set'));
    expect(correction).toContain('whole_set_projection_incompatible_basis');
    expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).not.toContain('mathematical_contradiction'); expect(reader).toHaveBeenCalledTimes(1);
  });

it.each(['这里的钥匙刻有字母。', '她站在钥匙柜旁。'])(
  'allows no-whole projection with a neutral literal target scope and no invented holding predicate: %s', async text => {
    const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, collection: 'same' } }, reader = vi.fn<Infer>();
    expect(await production(text, r, reader, false, false, authorProjection(text, 'no_whole_set_assertion'))).toBeUndefined();
    expect(reader).not.toHaveBeenCalled(); // New phase3 authority clears only all; phase5 cannot reproject it.
  });

it('keeps universality over an explicitly held subset separate from the whole inventory', async () => {
  const text = '第1和第3把钥匙都放在她的口袋，第2把钥匙仍未找到。';
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [number({ collection: 'same', kind: 'member' }),
    number({ numberIndex: 1, collection: 'same', kind: 'member' }), number({ numberIndex: 2, collection: 'same', kind: 'member', relation: 'missing' })], all: { ...noAll, collection: 'same' } };
  const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'positive_exemption', true, 'negative_or_missing'));
  expect(await production(text, r, reader, false, true, authorProjection(text, 'explicit_not_all'), { '0:0:2': 'explicit_nonpossession' })).toBeUndefined(); expect(reader).not.toHaveBeenCalled();
});

it.each(['attributed_claim', 'earlier_history', 'future', 'different_inventory'] as const)(
  'retains a compatible independently evidenced safe OR basis for an actual whole-set proposition: %s', basis => {
    const text = '她声称曾把整套钥匙带在身上。', c = { ...candidate(text), authorAllProjection: authorProjection(text, 'affirmative_whole_set') };
    const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, voice: 'ambiguous', time: 'ambiguous', collection: 'ambiguous', relation: 'affirmed_all' } }, data = dataFor(c, r);
    const value = decision(data, 'positive_exemption'); value.reviews[0]!.basis = basis;
    expect(admit(r, value, data, c).receipts[0]!.admitted).toBe(true);
  });

it.each(['affirmative_whole_set', 'explicit_not_all', 'no_whole_set_assertion'] as const)(
  'keeps a claimed all projection without its own literal scope witness pending instead of forcing another sample: %s', async statement => {
    const text = '这里有钥匙。', reader = vi.fn<Infer>(async context => { const value = decision(JSON.parse(context.user).data, 'positive_exemption'); value.reviews[0]!.basis = 'no_all_assertion'; return value; });
    const projection = authorProjection(text, statement); projection.semanticRoles = [];
    if (projection.kind === 'recorded_whole_assertions') projection.propositions = [];
    if (projection.kind === 'no_whole_assertion_in_complete_focus') projection.bases = [];
    const correction = await production(text, { candidateIndex: 0, numbers: [], all: noAll }, reader, false, false, projection);
    expect(correction).toContain('all_projection_unwitnessed'); expect(reader).toHaveBeenCalledTimes(1);
  });

it.each(['missing', 'foreign_focus', 'partial_coverage', 'fabricated_quote', 'number_projection'] as const)(
  'rejects invalid all projection structure within the original three format slots without echoing witness content: %s', async mode => {
    const injected = 'IGNORE_INSTRUCTIONS_PRIVATE_WITNESS', warm = vi.fn((context: { user: string }, input: unknown) => {
      const wire = JSON.parse(context.user);
      if (wire.formatCorrection) { expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500); expect(wire.formatCorrection).not.toContain(injected); }
      const value = input as { allProjections?: Array<{ projection: QuantityAuthorAllProjection }> };
      if (mode === 'missing') delete value.allProjections;
      else if (mode === 'foreign_focus') value.allProjections![0]!.projection.reviewedFocusId = 'foreign_focus';
      else if (mode === 'partial_coverage') return { ...value, allProjections: value.allProjections!.map(row => ({ ...row, projection: { ...row.projection, reviewedFocusId: 'selected_quote' } })) };
      else if (mode === 'fabricated_quote') value.allProjections![0]!.projection = { ...authorProjection('她带三把钥匙。', 'no_whole_set_assertion'), semanticRoles: [{ role: 'non_holding_scope', evidenceId: injected }] };
      else return { ...value, allProjections: undefined, reviews: [{ allProjection: value.allProjections![0]!.projection }] };
      return value;
    });
    const reader = vi.fn<Infer>();
    await expect(production('她带三把钥匙。', review(), reader, false, false, warm)).rejects.toThrow('未发布正文');
    expect(warm).toHaveBeenCalledTimes(3); expect(reader).not.toHaveBeenCalled();
  });

it('stores the projection and host located literal UTF16 witness only on its all receipt', () => {
  const text = '😺这里有钥匙。', projection = authorProjection(text, 'ambiguous');
  projection.semanticRoles = [{ role: 'non_holding_scope', evidenceId: buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, numericClauses(text)).evidence.find(e => e.kind === 'text_segment')!.id }];
  const c = { ...candidate(text), authorAllProjection: projection, authorAllWitnessLocations: validateQuantityAuthorAllProjection(projection, 0, topicSummaryClauses(text, '')) };
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: noAll }, data = dataFor(c, r), value = decision(data, 'positive_exemption'), result = admit(r, value, data, c);
  const receipt = result.receipts[0]!;
  if (!('authorAllProjection' in receipt) || !('literalWitnessLocations' in receipt)) throw new Error('Expected the actual all receipt branch.');
  expect(receipt.authorAllProjection!.reviewedFocusId).toBe(projection.reviewedFocusId);
  const located = receipt.literalWitnessLocations![0]!;
  expect(text.slice(located.firstMatchUtf16Span.start, located.firstMatchUtf16Span.end)).toBe(located.quote);
});

it('cannot substitute a source-canon negative for a proposition missing from the actual focus', () => {
  const text = '她把整套钥匙收入衣袋。', projection = { ...authorProjection(text, 'explicit_not_all'), semanticRoles: [{ role: 'whole_negative_scope', evidenceId: 'source_identity_forbidden' }] };
  expect(() => validateQuantityAuthorAllProjection(quantityAuthorAllProjectionSchema.parse(projection), 0, numericClauses(text))).toThrow();
  const c = { ...candidate(text), authorAllProjection: authorProjection(text, 'affirmative_whole_set') }, r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: noAll }, data = dataFor(c, r);
  const value = decision(data, 'positive_exemption'); value.reviews[0]!.basis = 'negative_or_missing';
  const result = admit(r, value, data, c);
  expect(result.receipts[0]!.admissionFailure).toBe('whole_set_projection_incompatible_basis'); expect(result.pending).toHaveLength(1);
});

it.each(['not_affirmed_all', 'ambiguous'])('cannot waive a witnessed affirmative whole-inventory proposition as an unrelated target under raw %s', relation => {
  const text = '她把整套钥匙收入随身衣袋。', c = { ...candidate(text), authorAllProjection: authorProjection(text, 'affirmative_whole_set') };
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, relation } }, data = dataFor(c, r), value = decision(data, 'positive_exemption');
  value.reviews[0]!.basis = 'unrelated_target'; const result = admit(r, value, data, c);
  expect(result.receipts[0]!.admissionFailure).toBe('whole_set_projection_incompatible_basis');
  expect(result.receipts[0]!.protocol).toBe('quantity_semantic_exemption_v9'); expect(result.pending).toHaveLength(1);
  expect(result.pending[0]!.diagnosticType).toBe('unresolved_semantic_exemption');
});

it('makes the complete warm request source-state-blind while preserving actual text and canonical identity in the later reader', async () => {
  const text = '她拿两把钥匙。', warm = vi.fn((context: { user: string }, value: unknown) => {
    const data = JSON.parse(context.user).data;
    expect(Object.keys(data).sort()).toEqual(['authorLanes', 'requiredClauseIndexes', 'requiredNumberTargets', 'requiredPairs', 'sets']);
    expect(data.sets).toEqual([{ setIndex: 0, entityQuote: '钥匙' }]);
    expect(data.authorLanes[0].window[0].text).toBe(text); expect(data).not.toHaveProperty('proposed');
    expect(data.authorLanes[0].window[0].numberCandidates[0].value).toBe(2); // Actual author numbers remain visible, not source state.
    return { ...(value as object), allProjections: [{ clauseIndex: 0, setIndex: 0, projection: authorProjection(text, 'no_whole_set_assertion') }] };
  });
  const reader = vi.fn<Infer>(async context => {
    const data = JSON.parse(context.user).data as ReturnType<typeof dataFor>;
    expect(data.checks).toHaveLength(1); expect(data.checks[0]!.target.kind).toBe('number');
    expect(data.checks[0]!.evidence.find(e => e.view === 'source_identity')!.text).toContain('尚未找到');
    expect(JSON.stringify(data)).not.toContain('authorAllProjection'); expect(JSON.stringify(data)).not.toContain('allProjections');
    return decision(data, 'positive_exemption', true, 'count_role');
  });
  expect(await production(text, review({ collection: 'same' }), reader, false, false, warm)).toBeUndefined();
  expect(warm).toHaveBeenCalledTimes(1); expect(reader).toHaveBeenCalledTimes(1);
});

it.each(['duplicate', 'missing_pair', 'foreign_set', 'foreign_source_view'] as const)(
  'enforces blind all sidecar coverage and actual-author references through the real warm validator: %s', async mode => {
    const warm = vi.fn((_context: { user: string }, input: unknown) => {
      const value = input as { allProjections: Array<{ clauseIndex: number; setIndex: number; projection: QuantityAuthorAllProjection }> };
      if (mode === 'duplicate') value.allProjections.push({ ...value.allProjections[0]! });
      else if (mode === 'missing_pair') value.allProjections = [];
      else if (mode === 'foreign_set') value.allProjections[0]!.setIndex = 99;
      else return { ...value, allProjections: value.allProjections.map(row => ({ ...row, projection: { ...row.projection,
        semanticRoles: [{ role: 'whole_negative_scope', evidenceId: 'source_identity_forbidden' }] } })) };
      return value;
    }), reader = vi.fn<Infer>();
    await expect(production('她拿两把钥匙。', review(), reader, false, false, warm)).rejects.toThrow('未发布正文');
    expect(warm).toHaveBeenCalledTimes(3); expect(reader).not.toHaveBeenCalled();
  });

it.each(['affirmative_whole_set', 'ambiguous'] as const)(
  'keeps a real independent safe OR route for a semantically unproved blind projection: %s', async statement => {
    const text = '她说自己把整套钥匙拿走了。', r: QuantityCollectionReview = { candidateIndex: 0, numbers: [],
      all: { ...noAll, voice: 'attributed_claim', relation: 'ambiguous' } }, warm = vi.fn((_context: { user: string }, value: unknown) => {
        const projection = authorProjection(text, statement); projection.semanticRoles = [];
        if (projection.kind === 'recorded_whole_assertions') projection.propositions = [];
        return { ...(value as object), allProjections: [{ clauseIndex: 0, setIndex: 0, projection }] }; });
    const reader = vi.fn<Infer>(async context => { const value = decision(JSON.parse(context.user).data, 'positive_exemption'); value.reviews[0]!.basis = 'attributed_claim'; return value; });
    expect(await production(text, r, reader, false, false, warm)).toBeUndefined(); expect(warm).toHaveBeenCalledTimes(1); expect(reader).toHaveBeenCalledTimes(1);
  });

it('rejects any fifth-stage attempt to emit or replace the author all projection', async () => {
  const text = '这里有钥匙。', reader = vi.fn<Infer>(async context => { const value = decision(JSON.parse(context.user).data, 'positive_exemption');
    return { reviews: value.reviews.map(row => ({ ...row, allProjection: authorProjection(text, 'no_whole_set_assertion') })) }; });
  await expect(production(text, { candidateIndex: 0, numbers: [], all: noAll }, reader)).rejects.toThrow('未发布正文'); expect(reader).toHaveBeenCalledTimes(3);
});

it('does not let a blind absence projection discharge the same candidate numeric risk', async () => {
  const text = '她声称自己带三把钥匙。', reader = vi.fn<Infer>(async context => { const data = JSON.parse(context.user).data;
    expect(data.checks.map((x: { target: unknown }) => x.target)).toEqual([{ kind: 'number', numberIndex: 0 }]); return decision(data, 'no_exemption'); });
  const correction = await production(text, review({ voice: 'attributed_claim' }), reader, false, false, authorProjection(text, 'no_whole_set_assertion'));
  expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).toContain('"kind":"number"'); expect(reader).toHaveBeenCalledTimes(1);
});

const numericClauses = (text: string) => topicSummaryClauses(text, '').map(clause => ({ ...clause, numberCandidates: topicQuantityNumberCandidates(clause.text) }));
function numericCandidate(text: string, statement: Parameters<typeof declaredNumberProjectionFixture>[2], index = 0) {
  const clauses = numericClauses(text), projection = declaredNumberProjectionFixture(clauses[0]!, index, statement);
  return { ...candidate(text), authorEvidenceLane: buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, clauses), authorAllPhase: 'topic_reply_quantity_actual_claims', authorAllPair: { clauseIndex: 0, setIndex: 0 },
    authorAllInputChecksum: '1'.repeat(64), authorAllOutputChecksum: '2'.repeat(64),
    authorNumberProjections: [{ numberIndex: index, projection, hostTargetBinding: bindQuantityHostNumberTarget({ clauseIndex: 0, setIndex: 0, numberIndex: index }, clauses),
      literalWitnessLocations: validateQuantityAuthorNumberProjection(projection, 0, index, clauses) }] };
}

it('binds repeated equal numerals to their actual UTF16 target instead of the first literal match', () => {
  const text = '😺编号2与第2把钥匙仍未取得。', clauses = numericClauses(text);
  const projection = declaredNumberProjectionFixture(clauses[0]!, 1, 'explicit_nonpossession');
  const lane = buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, clauses);
  projection.semanticRoles[0]!.evidenceId = lane.numberTargets[1]!.targetId;
  const located = validateQuantityAuthorNumberProjection(projection, 0, 1, clauses);
  expect(located[0]!.allMatchingUtf16Spans).toHaveLength(2);
  expect(located[0]!.targetCoveringUtf16Spans).toEqual([{ start: clauses[0]!.numberCandidates[1]!.start, end: clauses[0]!.numberCandidates[1]!.end }]);
  expect(() => validateQuantityAuthorNumberProjection({ ...projection, targetId: lane.numberTargets[0]!.targetId }, 0, 1, clauses)).toThrow('完整数词');
  projection.semanticRoles[0]!.evidenceId = lane.evidence.find(e => e.kind === 'entity_span')?.id ?? lane.numberTargets[0]!.targetId;
  const unassociated = validateQuantityAuthorNumberProjection(projection, 0, 1, clauses);
  expect(unassociated[0]!.coversTarget).toBe(false);
  // A semantic witness is still literal, but need not contain the target.
  // The neutral target location comes only from the independently bound span.
  expect(bindQuantityHostNumberTarget({ clauseIndex: 0, setIndex: 0, numberIndex: 1 }, clauses).targetUtf16Span)
    .toEqual({ start: clauses[0]!.numberCandidates[1]!.start, end: clauses[0]!.numberCandidates[1]!.end });
  const binding = bindQuantityHostNumberTarget({ clauseIndex: 0, setIndex: 0, numberIndex: 1 }, clauses);
  expect(binding.targetNumberQuote).toBe('2'); expect(binding.targetOccurrence).toBe(1);
  expect(binding.focusChecksum).toBe(createHash('sha256').update(text).digest('hex'));
  expect(binding.origin).toBe('host'); expect(binding.protocol).toBe('quantity_host_number_target_v1');
});

it('binds the exact archived parallel-member focus without inventing a missing contiguous noun phrase', async () => {
  // Exact clause from strict-RED 2d33; this is a new neutral-binding control,
  // not a reclassification of that historical model output or report.
  const text = '她实际只有第1和第3把钥匙，第2把仍未找到。', clauses = numericClauses(text);
  expect(text).not.toContain('第1把钥匙');
  const bindings = clauses[0]!.numberCandidates.map(number => bindQuantityHostNumberTarget({ clauseIndex: 0, setIndex: 0, numberIndex: number.numberIndex }, clauses));
  expect(bindings.map(binding => binding.targetNumberQuote)).toEqual(['1', '3', '2']);
  for (const binding of bindings) expect(text.slice(binding.targetUtf16Span.start, binding.targetUtf16Span.end)).toBe(binding.targetNumberQuote);
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [
    number({ numberIndex: 0, kind: 'member', collection: 'same' }),
    number({ numberIndex: 1, kind: 'member', collection: 'same' }),
    number({ numberIndex: 2, kind: 'member', collection: 'same', relation: 'missing' }),
  ], all: noAll }, reader = vi.fn<Infer>();
  const correction = await production(text, r, reader, false, true, authorProjection(text, 'no_whole_set_assertion'),
    { '0:0:0': 'affirmative_possession', '0:0:1': 'affirmative_possession', '0:0:2': 'explicit_nonpossession' });
  expect(correction).toBeUndefined(); expect(reader).not.toHaveBeenCalled();
});

it('rejects the removed model neutral target role instead of repairing or treating it as semantic evidence', () => {
  const projection = declaredNumberProjectionFixture(numericClauses('她仍未取得第2把钥匙。')[0]!, 0, 'explicit_nonpossession');
  expect(() => quantityAuthorNumberProjectionSchema.parse({ ...projection,
    witnesses: [{ role: 'target_scope', evidenceRef: { view: 'focus', clauseIndex: 0 }, quote: '第2把钥匙' }] })).toThrow();
});

it.each(['foreign_number', 'foreign_set', 'stale_focus', 'wrong_span', 'missing_binding'] as const)(
  'does not borrow a host neutral binding for another actual target: %s', mode => {
    const c = numericCandidate('😺编号2与第2把钥匙仍未取得。', 'explicit_nonpossession', 1), row = c.authorNumberProjections[0]!;
    if (mode === 'foreign_number') row.hostTargetBinding.logicalTriple.numberIndex = 0;
    else if (mode === 'foreign_set') row.hostTargetBinding.logicalTriple.setIndex = 1;
    else if (mode === 'stale_focus') row.hostTargetBinding.focusChecksum = 'f'.repeat(64);
    else if (mode === 'wrong_span') row.hostTargetBinding.targetUtf16Span = { start: 4, end: 5 };
    const actual = mode === 'missing_binding' ? { ...c, authorNumberProjections: [{ ...row, hostTargetBinding: undefined }] } : c;
    const result = quantityAuthorNumberProjectionAdmission(actual, number({ numberIndex: 1, kind: 'member', relation: 'missing' }));
    expect(result.safeAbsence).toBe(false); expect(result.failure).toBe('invalid_host_number_target_binding');
  });

it.each(['affirmative_possession', 'explicit_nonpossession', 'ambiguous'] as const)(
  'never turns host-only position proof into a numeric semantic assertion: %s', statement => {
    const c = numericCandidate('那是第2把钥匙。', statement); c.authorNumberProjections[0]!.projection.semanticRoles = [];
    c.authorNumberProjections[0]!.literalWitnessLocations = validateQuantityAuthorNumberProjection(c.authorNumberProjections[0]!.projection, 0, 0, numericClauses(c.claimQuote));
    const result = quantityAuthorNumberProjectionAdmission(c, number({ kind: 'member', relation: 'missing' }));
    expect(result.receipt.protocol).toBe('quantity_author_number_projection_v3_evidence_ids'); expect(result.receipt.hostTargetBindingValid).toBe(true);
    expect(result.receipt.projection!.statement).toBe(statement); expect(result.safeAbsence).toBe(false);
    if (statement !== 'ambiguous') expect(result.failure).toBe('number_projection_unwitnessed');
  });

it.each(['explicit_nonpossession', 'no_possession_assertion'] as const)('uses witnessed current numeric absence without requiring never-held world history: %s', statement => {
  const c = numericCandidate('她曾持有第2把钥匙，如今第2把钥匙仍未取得。', statement, 1), raw = number({ numberIndex: 1, kind: 'member', relation: 'missing' });
  const result = quantityAuthorNumberProjectionAdmission(c, raw);
  expect(result.safeAbsence).toBe(true); expect(result.receipt.logicalTriple).toEqual({ clauseIndex: 0, setIndex: 0, numberIndex: 1 });
  expect(result.receipt.targetUtf16Span).toEqual({ start: c.numberSpans[1]!.start, end: c.numberSpans[1]!.end });
  expect(result.receipt.parsedOutputChecksum).toBe('2'.repeat(64));
  expect(quantityAuthorNumberProjectionAdmission(c, { ...raw, relation: 'affirmed_holding' }).conflictsWithRaw).toBe(true);
});

it.each(['获得了', '取回了', '随身携带', '当场实际可用的是'] as const)('preserves affirmative physical possession syntax and never licenses a fifth-stage negative rewrite: %s', verb => {
  const c = numericCandidate(`她${verb}三把钥匙。`, 'affirmative_possession'), r = review({ relation: 'missing' }), data = dataFor(c, r);
  const result = admit(r, decision(data, 'positive_exemption', true, 'negative_or_missing'), data, c);
  expect(result.receipts[0]!.admitted).toBe(false); expect(result.receipts[0]!.admissionFailure).toBe('number_projection_requires_independent_safe_or');
  const receipt = result.receipts[0]!;
  if (!('authorNumberReceipt' in receipt)) throw new Error('Expected the actual number receipt branch.');
  const projection = receipt.authorNumberReceipt.projection;
  if (!projection || !('statement' in projection)) throw new Error('Expected the actual numeric statement projection.');
  expect(projection.statement).toBe('affirmative_possession');
});

it('accepts a focus-bound numeric target with its real governing negative predicate in the adjacent clause', async () => {
  const text = '那是第2把钥匙。她仍未得到它。', clauses = numericClauses(text);
  const projection: QuantityAuthorNumberProjection = declaredNumberProjectionFixture(clauses[0]!, 0, 'explicit_nonpossession');
  const lane = buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, clauses);
  projection.laneId = lane.id; projection.reviewedFocusId = lane.focusId; projection.targetId = lane.numberTargets[0]!.targetId;
  projection.semanticRoles = [{ role: 'negative_scope', evidenceId: lane.evidence.find(e => e.view === 'after' && e.kind === 'text_segment')!.id }];
  const r = review({ kind: 'member', relation: 'missing', collection: 'same' }), reader = vi.fn<Infer>();
  const correction = await production(text, r, reader, false, false, (_context, input) => ({ ...(input as object),
    allProjections: [{ clauseIndex: 0, setIndex: 0, projection: declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: 0, text: clauses[0]!.text }] }, 'no_whole_set_assertion', lane) }],
    numberProjections: [{ clauseIndex: 0, setIndex: 0, numberIndex: 0, projection }] }));
  expect(correction).toBeUndefined(); expect(reader).not.toHaveBeenCalled();
  const positive = '那是第2把钥匙。她现在取回了它。';
  const result = await production(positive, review({ kind: 'member', collection: 'same' }), reader, false, false,
    declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: 0, text: '那是第2把钥匙。' }] }, 'no_whole_set_assertion', buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, numericClauses(positive))), { '0:0:0': 'explicit_nonpossession' });
  expect(result).toContain('数学'); expect(reader).not.toHaveBeenCalled(); // Raw mathematics precedes any new projection.
});

it.each(['missing', 'duplicate', 'foreign', 'wrong_occurrence', 'fabricated_quote'] as const)(
  'rejects malformed complete numeric sidecars in the original three format slots: %s', async mode => {
    const warm = vi.fn((_context: { user: string }, input: unknown) => {
      const value = input as { numberProjections: Array<{ numberIndex: number; projection: ReturnType<typeof declaredNumberProjectionFixture> }> };
      if (mode === 'missing') value.numberProjections = [];
      else if (mode === 'duplicate') value.numberProjections.push({ ...value.numberProjections[0]! });
      else if (mode === 'foreign') value.numberProjections[0]!.numberIndex = 99;
      else if (mode === 'wrong_occurrence') value.numberProjections[0]!.projection.targetId = 'wrong_occurrence';
      else value.numberProjections[0]!.projection.semanticRoles = [{ role: 'possession_predicate', evidenceId: 'fabricated_quote' }];
      return value;
    }), reader = vi.fn<Infer>();
    await expect(production('她带三把钥匙。', review(), reader, false, false, warm)).rejects.toThrow('未发布正文');
    expect(warm).toHaveBeenCalledTimes(3); expect(reader).not.toHaveBeenCalled();
  });

it('keeps valid weak numeric witnesses semantic pending and does not resample for a stronger assertion', async () => {
  const warm = vi.fn((_context: { user: string }, value: unknown) => {
    const typed = value as { numberProjections: Array<{ projection: ReturnType<typeof declaredNumberProjectionFixture> }> };
    typed.numberProjections[0]!.projection.statement = 'explicit_nonpossession'; typed.numberProjections[0]!.projection.semanticRoles = []; return typed;
  }), reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'positive_exemption', true, 'negative_or_missing'));
  const correction = await production('她说自己未得三把钥匙。', review({ voice: 'attributed_claim', relation: 'missing' }), reader, false, false,
    (context, value) => warm(context, value));
  expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).toContain('number_projection_unwitnessed');
  expect(warm).toHaveBeenCalledTimes(1); expect(reader).toHaveBeenCalledTimes(1);
});

it.each(['一', '一万'] as const)('does not invent numeric disagreement pending for an actually non-risk target: %s', async numeral => {
  const text = `她带${numeral}把钥匙。`, c = numericCandidate(text, 'no_possession_assertion'), r = review({ collection: 'same' }), reader = vi.fn<Infer>();
  expect(quantityDisjointChecks([c], [r]).filter(check => check.target.kind === 'number')).toEqual([]);
  expect(await production(text, r, reader, false, false, authorProjection(text, 'no_whole_set_assertion'), { '0:0:0': 'no_possession_assertion' })).toBeUndefined();
  expect(reader).not.toHaveBeenCalled();
});

it('does not let a past negative occurrence erase a separately bound currently recovered missing member', async () => {
  const text = '去年她未取得第2把钥匙，如今她取回了第2把钥匙。', r: QuantityCollectionReview = { candidateIndex: 0,
    numbers: [number({ numberIndex: 0, collection: 'same', relation: 'missing', kind: 'member', time: 'earlier_history' }),
      number({ numberIndex: 1, collection: 'same', relation: 'affirmed_holding', kind: 'member' })], all: noAll }, reader = vi.fn<Infer>();
  const correction = await production(text, r, reader, false, true, authorProjection(text, 'no_whole_set_assertion'),
    { '0:0:0': 'explicit_nonpossession', '0:0:1': 'affirmative_possession' });
  expect(correction).toContain('数学'); expect(reader).not.toHaveBeenCalled();
});

it.each([31, 32])('bounds the complete source-blind combined grid before warm without dropping any numeric occurrence: %s numbers', async count => {
  const text = '钥匙编号' + Array.from({ length: count }, (_x, index) => index + 1).join('、') + '。', r = { ...review(), numbers: Array.from({ length: count }, (_x, numberIndex) => number({ numberIndex, voice: 'unrelated', kind: 'unrelated', relation: 'unrelated' })) };
  const warm = vi.fn((context: { user: string }, value: unknown) => {
    expect(JSON.parse(context.user).data.requiredNumberTargets).toHaveLength(count);
    const complete = declaredWarmAllFixture(context, value, undefined, Object.fromEntries(Array.from({ length: count }, (_x, index) => ['0:0:' + index, 'no_possession_assertion'])));
    return { ...(complete as object), clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }],
      allProjections: [{ clauseIndex: 0, setIndex: 0, projection: authorProjection(text, 'no_whole_set_assertion') }] };
  }), reader = vi.fn<Infer>();
  const result = await production(text, r, reader, false, false, (context, value) => {
    const data = value as { numberProjections: unknown }; delete (data as { numberProjections?: unknown }).numberProjections;
    return warm(context, data);
  });
  if (count === 31) { expect(warm).toHaveBeenCalledTimes(1); expect(result).toBeUndefined(); }
  else { expect(warm).not.toHaveBeenCalled(); expect(result).toContain('unresolved_author_projection_capacity'); }
  expect(reader).not.toHaveBeenCalled();
});

it('permits a complete unknown numeral longer than one hundred characters without an impossible copy schema', () => {
  const text = '编号' + '9'.repeat(101) + '的钥匙。', clauses = numericClauses(text), projection = declaredNumberProjectionFixture(clauses[0]!, 0);
  expect(quantityAuthorNumberProjectionSchema.safeParse(projection).success).toBe(true);
  expect(() => validateQuantityAuthorNumberProjection(projection, 0, 0, clauses)).not.toThrow();
});

/** These are declared author IR premises, not a natural-language classifier or
 * evidence that a model interprets the example prose correctly. */
type LegacyAllFields = { domainScope?: string; exhaustivity?: string; holding?: string; opposition?: string };
type LegacyRole = 'target_scope' | 'domain_reference' | 'scoped_possession_predicate' | 'exhaustive_coverage_operator' | 'negative_or_limited_scope' | 'partitive_domain_restriction';
function allIR(text: string, fields: LegacyAllFields = {}, witnesses: Array<[LegacyRole, string]> = [['target_scope', text]]): QuantityAuthorAllProjection {
  const lane = buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, numericClauses(text));
  const id = lane.evidence.find(e => e.kind === 'text_segment' && e.view === 'focus')!.id;
  const names = { target_scope: 'non_holding_scope', domain_reference: 'domain_reference', scoped_possession_predicate: 'possession_predicate',
    exhaustive_coverage_operator: 'coverage_operator', negative_or_limited_scope: 'whole_negative_scope', partitive_domain_restriction: 'partitive_restriction' } as const;
  const semanticRoles = witnesses.map(([role]) => ({ role: names[role], evidenceId: id }));
  const index = (role: typeof semanticRoles[number]['role']) => { const i = semanticRoles.findIndex(r => r.role === role); return i < 0 ? null : i; };
  const common = { laneId: lane.id, reviewedFocusId: lane.focusId, semanticRoles };
  let projection: QuantityAuthorAllProjection;
  if (fields.opposition && fields.opposition !== 'none_in_reviewed_scope') {
    projection = declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: 0, text }] }, 'affirmative_whole_set', lane);
    if (projection.kind !== 'recorded_whole_assertions') throw new Error('Whole fixture branch required.');
    projection.semanticRoles.push({ role: 'whole_negative_scope', evidenceId: id });
    projection.propositions.push({ ...projection.propositions[0]!, polarity: 'denied', negativeRole: 3 });
    projection.scopeLinks = [{ left: 0, right: 1, relation: fields.opposition === 'competing_whole_possession_assertions' ? 'same_assertion_scope' : 'unresolved_scope', evidenceIds: [id] }];
  } else if (fields.exhaustivity === 'exhaustive' && fields.domainScope !== 'explicit_partitive_scope') {
    projection = { ...common, kind: 'recorded_whole_assertions', propositions: [{ kind: 'whole_possession', polarity: 'affirmed',
      domainRole: index('domain_reference'), coverageRole: index('coverage_operator'), predicateRole: fields.holding === 'not_asserted' ? null : index('possession_predicate'),
      negativeRole: index('whole_negative_scope'), scopeEvidenceIds: [id] }], scopeLinks: [] };
  } else if (fields.holding === 'not_asserted' && semanticRoles.some(r => r.role !== 'non_holding_scope')) {
    projection = { ...common, kind: 'no_whole_assertion_in_complete_focus', bases: [] };
  } else {
    const limited = fields.domainScope === 'explicit_partitive_scope' || index('whole_negative_scope') !== null;
    if (limited && index('whole_negative_scope') !== null) semanticRoles[index('whole_negative_scope')!]!.role = 'partitive_restriction';
    projection = { ...common, kind: 'no_whole_assertion_in_complete_focus', bases: index('possession_predicate') !== null
      ? [limited ? { kind: 'limited_possession', domainRole: index('domain_reference'), predicateRole: index('possession_predicate'),
        restrictionRole: index('partitive_restriction'), coverageRole: fields.exhaustivity === 'exhaustive' ? index('coverage_operator') : null }
        : { kind: 'ordinary_possession', domainRole: index('domain_reference'), predicateRole: index('possession_predicate') }]
      : index('non_holding_scope') !== null ? [{ kind: 'non_holding', scopeRole: index('non_holding_scope') }] : [] };
  }
  projectionTexts.set(projection, text); return projection;
}

it('derives no whole assertion from the actual ordinary quoted cardinal while keeping its numeric obligation', async () => {
  const text = '男人声称“许岚口袋里有三把钥匙”。', ir = allIR(text, { holding: 'affirmed', domainScope: 'whole_collection_candidate' },
    [['target_scope', text], ['domain_reference', '三把钥匙'], ['scoped_possession_predicate', '许岚口袋里有']]);
  expect(validateQuantityAuthorAllProjection(ir, 0, topicSummaryClauses(text, ''))).toHaveLength(3);
  expect(deriveQuantityAuthorAllProjection(ir, 0).statement).toBe('no_whole_set_assertion');
  const reader = vi.fn<Infer>(async context => {
    const data = JSON.parse(context.user).data as ReturnType<typeof dataFor>;
    expect(data.checks.map(check => check.target)).toEqual([{ kind: 'number', numberIndex: 0 }]);
    return decision(data, 'positive_exemption', true, 'attributed_claim');
  });
  expect(await production(text, review({ collection: 'same', voice: 'attributed_claim' }), reader, false, false, ir,
    { '0:0:0': 'affirmative_possession' })).toBeUndefined();
  expect(reader).toHaveBeenCalledTimes(1);
});

it('keeps a real same-source impossible numeric possession rejected even when the new all IR has no whole operator', async () => {
  const text = '她口袋里有三把钥匙。', ir = allIR(text, { holding: 'affirmed' },
    [['target_scope', text], ['domain_reference', '三把钥匙'], ['scoped_possession_predicate', '口袋里有']]);
  const reader = vi.fn<Infer>(), correction = await production(text, review({ collection: 'same' }), reader, false, false, ir,
    { '0:0:0': 'affirmative_possession' });
  expect(deriveQuantityAuthorAllProjection(ir, 0).statement).toBe('no_whole_set_assertion');
  expect(correction).toContain('数学'); expect(reader).not.toHaveBeenCalled();
});

it('derives the original whole material from an actual operator and refuses its controlled raw-not-all bypass', async () => {
  const text = '她把钥匙全部带在身上。', ir = allIR(text, { domainScope: 'whole_collection_candidate', exhaustivity: 'exhaustive', holding: 'affirmed' },
    [['domain_reference', '钥匙'], ['exhaustive_coverage_operator', '全部'], ['scoped_possession_predicate', '带在身上']]);
  expect(deriveQuantityAuthorAllProjection(ir, 0).statement).toBe('affirmative_whole_set');
  const reader = vi.fn<Infer>(async context => decision(JSON.parse(context.user).data, 'unresolved'));
  const correction = await production(text, { candidateIndex: 0, numbers: [], all: { ...noAll, collection: 'same' } }, reader, false, false, ir);
  expect(correction).toContain('unresolved_semantic_exemption'); expect(reader).toHaveBeenCalledTimes(1);
});

it.each([
  { text: '她把架上所有钥匙收进包，一把没落下。', domain: '架上所有钥匙', operator: '一把没落下', predicate: '收进包' },
  { text: '最后那枚钥匙也进了衣袋，原来挂钥匙的架子已经空了。', domain: '钥匙', operator: '架子已经空了', predicate: '最后那枚钥匙也进了衣袋' },
])('supports a declared natural exhaustive construction without treating a descriptive domain as a subset: $text', test => {
  const ir = allIR(test.text, { domainScope: 'whole_collection_candidate', exhaustivity: 'exhaustive', holding: 'affirmed' },
    [['domain_reference', test.domain], ['exhaustive_coverage_operator', test.operator], ['scoped_possession_predicate', test.predicate]]);
  expect(validateQuantityAuthorAllProjection(ir, 0, topicSummaryClauses(test.text, ''))).toHaveLength(3);
  expect(deriveQuantityAuthorAllProjection(ir, 0).statement).toBe('affirmative_whole_set');
  const unresolvedDomain = structuredClone(ir); if (unresolvedDomain.kind !== 'recorded_whole_assertions') throw new Error('Whole branch.'); unresolvedDomain.propositions[0]!.domainRole = null; projectionTexts.set(unresolvedDomain, test.text);
  expect(deriveQuantityAuthorAllProjection(unresolvedDomain, 0).statement).toBe('ambiguous');
});

it('does not cross-compose a universal property with another ordinary count holding predicate', () => {
  const text = '所有钥匙都刻着细纹，她手里有两把钥匙。', ir = allIR(text, { holding: 'affirmed' },
    [['target_scope', text], ['domain_reference', '钥匙'], ['scoped_possession_predicate', '她手里有']]);
  expect(deriveQuantityAuthorAllProjection(ir, 0).statement).toBe('no_whole_set_assertion');
  const falseAttachment = structuredClone(ir); falseAttachment.semanticRoles.push({ role: 'coverage_operator', evidenceId: ir.semanticRoles[0]!.evidenceId }); projectionTexts.set(falseAttachment, text);
  expect(() => validateQuantityAuthorAllProjection(falseAttachment, 0, topicSummaryClauses(text, ''))).not.toThrow();
  expect(deriveQuantityAuthorAllProjection(falseAttachment, 0)).toMatchObject({ statement: 'ambiguous' });
});

it.each(['competing_whole_possession_assertions', 'unresolved_possible_competition'] as const)(
  'gives relevant whole-focus opposition priority over an otherwise safe absence: %s', opposition => {
    const text = '她把整套钥匙带在身上，却又没有带齐。', ir = allIR(text, { opposition });
    const c = { ...candidate(text), authorAllProjection: ir }, admitted = quantityAuthorAllProjectionAdmission(c, noAll);
    expect(admitted.safeAbsence).toBe(false); expect(admitted.derivedStatement).toBe('ambiguous');
    expect(admitted.failure).toMatch(/all_projection_(opposed|unresolved)_scope/);
  });

it.each([
  { exhaustivity: 'not_asserted' as const, holding: 'ambiguous' as const, role: 'exhaustive_coverage_operator' as const },
  { exhaustivity: 'ambiguous' as const, holding: 'not_asserted' as const, role: 'scoped_possession_predicate' as const },
  { exhaustivity: 'ambiguous' as const, holding: 'not_asserted' as const, role: 'exhaustive_coverage_operator' as const },
  { exhaustivity: 'exhaustive' as const, holding: 'not_asserted' as const, role: 'target_scope' as const },
])('keeps contradictory absence IR pending even if another strong role is missing: %j', test => {
  const text = '她把钥匙全部带在身上。', ir = allIR(text, { exhaustivity: test.exhaustivity, holding: test.holding }, [[test.role, text]]);
  expect(deriveQuantityAuthorAllProjection(ir, 0)).toMatchObject({ statement: 'ambiguous' });
});

it('allows actual limited and negative holding to coexist with no positive exhaustive assertion without borrowing numeric authority', async () => {
  const text = '她实际只有第1和第3把钥匙，第2把仍未找到。', ir = allIR(text,
    { domainScope: 'whole_collection_candidate', holding: 'affirmed', exhaustivity: 'not_asserted' },
    [['domain_reference', '钥匙'], ['scoped_possession_predicate', '她实际只有'], ['negative_or_limited_scope', '第2把仍未找到']]);
  expect(deriveQuantityAuthorAllProjection(ir, 0).statement).toBe('no_whole_set_assertion');
  expect(quantityAuthorAllProjectionAdmission({ ...candidate(text), authorAllProjection: ir }, noAll).safeAbsence).toBe(true);
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [number({ collection: 'same', kind: 'member' }),
    number({ numberIndex: 1, collection: 'same', kind: 'member' }), number({ numberIndex: 2, collection: 'same', kind: 'member', relation: 'missing' })],
    all: { ...noAll, collection: 'same' } }, reader = vi.fn<Infer>();
  expect(await production(text, r, reader, false, true, ir, { '0:0:2': 'explicit_nonpossession' })).toBeUndefined();
  expect(reader).not.toHaveBeenCalled();
});

it('keeps declared positive and negative whole-holding scopes unresolved even when the opposition field omits the conflict', () => {
  const text = '她把整套钥匙带在身上，却又没有带齐。', ir = allIR(text,
    { domainScope: 'whole_collection_candidate', exhaustivity: 'exhaustive', holding: 'affirmed' },
    [['domain_reference', '钥匙'], ['exhaustive_coverage_operator', '整套'], ['scoped_possession_predicate', '带在身上'], ['negative_or_limited_scope', '没有带齐']]);
  expect(() => validateQuantityAuthorAllProjection(ir, 0, topicSummaryClauses(text, ''))).not.toThrow();
  expect(deriveQuantityAuthorAllProjection(ir, 0)).toMatchObject({ statement: 'ambiguous' });
});

it.each([
  { exhaustivity: 'not_asserted' as const, holding: 'ambiguous' as const },
  { exhaustivity: 'ambiguous' as const, holding: 'not_asserted' as const },
])('retains independently witnessed absence despite an irrelevant unknown axis: %j', fields => {
  const text = '钥匙表面刻着细纹。', ir = allIR(text, fields);
  expect(quantityAuthorAllProjectionAdmission({ ...candidate(text), authorAllProjection: ir }, noAll).safeAbsence).toBe(true);
});

it('requires an actual partitive restriction independently of an exhaustive operator and never converts it to not-all', () => {
  const text = '她把手头两把钥匙全装进袋，第2把仍未找到。', ir = allIR(text,
    { domainScope: 'explicit_partitive_scope', exhaustivity: 'exhaustive', holding: 'affirmed' },
    [['domain_reference', '钥匙'], ['exhaustive_coverage_operator', '全'], ['scoped_possession_predicate', '装进袋'], ['partitive_domain_restriction', '手头两把钥匙']]);
  expect(deriveQuantityAuthorAllProjection(ir, 0).statement).toBe('no_whole_set_assertion');
  expect(deriveQuantityAuthorAllProjection(allIR(text, { domainScope: 'explicit_partitive_scope', exhaustivity: 'exhaustive', holding: 'affirmed' }, [['domain_reference', text], ['exhaustive_coverage_operator', text], ['scoped_possession_predicate', text]]), 0).statement).toBe('ambiguous');
  expect(deriveQuantityAuthorAllProjection(allIR(text, { exhaustivity: 'ambiguous' }, []), 0).statement).toBe('ambiguous');
});

it('removes the free statement and collective-domain legacy role instead of retaining a second all authority', () => {
  const text = '这里有三把钥匙。', ir = allIR(text);
  expect(quantityAuthorAllProjectionSchema.safeParse({ ...ir, statement: 'affirmative_whole_set' }).success).toBe(false);
  expect(quantityAuthorAllProjectionSchema.safeParse({ ...ir, witnesses: [{ role: 'whole_set_quantifier_or_collective_domain',
    evidenceRef: { view: 'focus', clauseIndex: 0 }, quote: '三把钥匙' }] }).success).toBe(false);
  const receipt = quantityAuthorAllProjectionAdmission({ ...candidate(text), authorAllProjection: ir }, noAll).receipt;
  expect(receipt.protocol).toBe('quantity_author_all_propositions_v1'); expect(receipt.derivedStatement).toBe('no_whole_set_assertion');
});


// New evidence/proposition controls exercise the real host, not model accuracy.
function propositionCandidate(text: string, projection: QuantityAuthorAllProjection) {
  return bindDeclaredCandidate({ ...candidate(text), authorAllProjection: projection });
}
function twoWholeFixture(text: string, second: 'affirmed' | 'denied' = 'affirmed') {
  const lane = buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, numericClauses(text));
  const segments = lane.evidence.filter(e => e.kind === 'text_segment' && e.view === 'focus' && e.quote !== text);
  const first = segments[0] ?? lane.evidence.find(e => e.kind === 'text_segment')!, last = segments[1] ?? first;
  const projection: QuantityAuthorAllProjection = { kind: 'recorded_whole_assertions', laneId: lane.id, reviewedFocusId: lane.focusId,
    semanticRoles: [{ role: 'domain_reference', evidenceId: first.id }, { role: 'coverage_operator', evidenceId: first.id },
      { role: 'possession_predicate', evidenceId: first.id }, { role: 'domain_reference', evidenceId: last.id },
      { role: second === 'affirmed' ? 'coverage_operator' : 'whole_negative_scope', evidenceId: last.id }, { role: 'possession_predicate', evidenceId: last.id }],
    propositions: [{ kind: 'whole_possession', polarity: 'affirmed', domainRole: 0, coverageRole: 1, predicateRole: 2, negativeRole: null, scopeEvidenceIds: [first.id] },
      { kind: 'whole_possession', polarity: second, domainRole: 3, coverageRole: second === 'affirmed' ? 4 : null, predicateRole: 5,
        negativeRole: second === 'denied' ? 4 : null, scopeEvidenceIds: [last.id] }],
    scopeLinks: [{ left: 0, right: 1, relation: 'explicitly_distinct_scope', evidenceIds: [first.id, last.id] }] };
  projectionTexts.set(projection, text); return { projection, lane };
}

it('addresses exact emoji bytes and repeated numeric occurrences without accepting another lane or a fabricated quote', () => {
  const text = '😺编号2与第2把钥匙仍未取得。', clauses = numericClauses(text), lane = buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, clauses, '钥匙');
  const target = lane.evidence.find(e => e.id === lane.numberTargets[1]!.targetId)!;
  expect(Buffer.from(text).subarray(target.utf8Span.start, target.utf8Span.end).toString()).toBe('2');
  expect(target.utf16Span.start).toBe(clauses[0]!.numberCandidates[1]!.start);
  const projection = declaredNumberProjectionFixture(lane, 1, 'explicit_nonpossession');
  expect(() => validateQuantityAuthorNumberProjection({ ...projection, targetId: lane.numberTargets[0]!.targetId }, 0, 1, clauses, lane)).toThrow();
  expect(() => validateQuantityAuthorNumberProjection({ ...projection, semanticRoles: [{ role: 'negative_scope', evidenceId: 'invented' }] }, 0, 1, clauses, lane)).toThrow();
  expect(quantityAuthorNumberProjectionSchema.safeParse({ ...projection, witnesses: [{ quote: '第1把钥匙' }] }).success).toBe(false);
});

it('cannot borrow the original far partial focus or a source quote for a quoted-count evidence ID', () => {
  const text = '男人声称“许岚口袋里有三把钥匙”。这只是他的说法；她实际只有第1和第3把钥匙，第2把仍未找到。', clauses = numericClauses(text);
  const lane = buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, clauses), far = buildQuantityAuthorEvidenceLane({ clauseIndex: 2, setIndex: 0 }, clauses);
  expect(lane.evidence.every(e => e.clauseIndex <= 1)).toBe(true);
  const projection = declaredAllProjectionFixture({ evidence: [{ view: 'focus', clauseIndex: 0, text: clauses[0]!.text }] }, 'no_whole_set_assertion', lane);
  projection.semanticRoles[0]!.evidenceId = far.evidence.find(e => e.view === 'focus')!.id;
  expect(() => validateQuantityAuthorAllProjection(projection, 0, clauses, lane)).toThrow('evidenceId');
  projection.semanticRoles[0]!.evidenceId = 'source_identity_第2把尚未找到';
  expect(() => validateQuantityAuthorAllProjection(projection, 0, clauses, lane)).toThrow('evidenceId');
});

it.each(['wrong_role_kind', 'out_of_range', 'same_operand', 'foreign_operand'] as const)(
  'validates proposition role kinds and two actual distinct whole link operands: %s', mode => {
    const text = '他说整套钥匙都带走了，她却没有带齐。', { projection, lane } = twoWholeFixture(text, 'denied');
    if (projection.kind !== 'recorded_whole_assertions') throw new Error('Whole branch.');
    if (mode === 'wrong_role_kind') projection.propositions[0]!.predicateRole = 1;
    if (mode === 'out_of_range') projection.propositions[0]!.predicateRole = 99;
    if (mode === 'same_operand') projection.scopeLinks[0]!.right = 0;
    if (mode === 'foreign_operand') projection.scopeLinks[0]!.right = 2;
    expect(() => validateQuantityAuthorAllProjection(projection, 0, numericClauses(text), lane)).toThrow();
  });

it.each(['empty_bases', 'null_predicate', 'missing_scope_link', 'empty_propositions'] as const)(
  'keeps legal weak author propositions pending without closing the independent full-scope safe OR: %s', mode => {
    const text = '他说整套钥匙都带走了，她也声称带齐了。', { projection } = twoWholeFixture(text);
    let value: QuantityAuthorAllProjection = projection;
    if (value.kind !== 'recorded_whole_assertions') throw new Error('Whole branch.');
    if (mode === 'null_predicate') value.propositions[0]!.predicateRole = null;
    if (mode === 'missing_scope_link') value.scopeLinks = [];
    if (mode === 'empty_propositions') { value.propositions = []; value.scopeLinks = []; }
    if (mode === 'empty_bases') value = { kind: 'no_whole_assertion_in_complete_focus', laneId: value.laneId, reviewedFocusId: value.reviewedFocusId, semanticRoles: [], bases: [] };
    const c = propositionCandidate(text, value), r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, voice: 'attributed_claim' } };
    const author = quantityAuthorAllProjectionAdmission(c, r.all); expect(author.safeAbsence).toBe(false); expect(author.derivedStatement).toBe('ambiguous');
    const data = dataFor(c, r); expect(data.checks.some(check => check.target.kind === 'all' && check.target.assertionIndex === undefined)).toBe(true);
    const decisionValue = decision(data, 'positive_exemption'); for (const item of decisionValue.reviews) item.basis = 'attributed_claim';
    expect(admit(r, decisionValue, data, c).pending).toEqual([]);
    for (const item of decisionValue.reviews) item.targetScopeComplete = false;
    expect(admit(r, decisionValue, data, c).pending.length).toBe(data.checks.length);
  });

it('collects a later opposing whole before any affirmative return and never treats a missing link as no conflict', () => {
  const text = '她把整套钥匙带在身上，却又没有带齐。', { projection } = twoWholeFixture(text, 'denied');
  if (projection.kind !== 'recorded_whole_assertions') throw new Error('Whole branch.');
  projection.scopeLinks[0]!.relation = 'same_assertion_scope';
  expect(quantityAuthorAllProjectionAdmission(propositionCandidate(text, projection), noAll)).toMatchObject({ safeAbsence: false, derivedStatement: 'ambiguous', failure: 'all_projection_opposed_scope' });
  projection.scopeLinks = [];
  expect(quantityAuthorAllProjectionAdmission(propositionCandidate(text, projection), noAll).failure).toBe('all_projection_unresolved_scope');
});

it('requires each live whole to obtain its own independent scope-bound exemption rather than borrowing the quoted one', () => {
  const text = '他说整套钥匙都带走了，她把整套钥匙带在身上。', { projection } = twoWholeFixture(text), c = propositionCandidate(text, projection);
  const r: QuantityCollectionReview = { candidateIndex: 0, numbers: [], all: { ...noAll, voice: 'ambiguous', collection: 'ambiguous' } }, data = dataFor(c, r);
  expect(data.checks.map(check => check.target)).toEqual([{ kind: 'all', assertionIndex: 0 }, { kind: 'all', assertionIndex: 1 }]);
  const value = decision(data, 'unresolved'); value.reviews[0] = { ...value.reviews[0]!, verdict: 'positive_exemption', basis: 'attributed_claim' };
  expect(admit(r, value, data, c).pending.map(p => p.target)).toEqual([{ kind: 'all', assertionIndex: 1 }]);
  const both = decision(data, 'positive_exemption'); both.reviews[1]!.assertionEvidenceIds = data.checks[0]!.scopeObligation!.assertionEvidenceIds;
  expect(() => admit(r, both, data, c)).toThrow('本目标');
  expect(data.checks[0]!.scopeObligation!.focusChecksum).toBe(createHash('sha256').update(text).digest('hex'));
});

it('treats a numeric address as provenance only and keeps real numeric mathematics independent of all absence', async () => {
  const text = '她口袋里有三把钥匙。', clauses = numericClauses(text), lane = buildQuantityAuthorEvidenceLane({ clauseIndex: 0, setIndex: 0 }, clauses);
  const projection = declaredNumberProjectionFixture(lane, 0, 'affirmative_possession'); projection.semanticRoles[0]!.evidenceId = lane.numberTargets[0]!.targetId;
  const c = numericCandidate(text, 'affirmative_possession'); c.authorNumberProjections[0]!.projection = projection;
  c.authorNumberProjections[0]!.literalWitnessLocations = validateQuantityAuthorNumberProjection(projection, 0, 0, clauses, lane);
  expect(quantityAuthorNumberProjectionAdmission(c, number()).failure).toBe('number_projection_unwitnessed');
  const reader = vi.fn<Infer>(), correction = await production(text, review({ collection: 'same' }), reader, false, false, authorProjection(text, 'no_whole_set_assertion'));
  expect(correction).toContain('数学'); expect(reader).not.toHaveBeenCalled();
});

it('counts every actual whole sub-obligation before cold dispatch without increasing the combined32 budget', async () => {
  const text = '他说整套钥匙都带走了，她把整套钥匙带在身上，编号' + Array.from({ length: 31 }, (_, i) => i + 1).join('、') + '。';
  const { projection } = twoWholeFixture(text); const reader = vi.fn<Infer>();
  const r = { ...review(), numbers: Array.from({ length: 31 }, (_, numberIndex) => number({ numberIndex, voice: 'unrelated', relation: 'unrelated', kind: 'unrelated' })) };
  const correction = await production(text, r, reader, false, false, (_context, value) => ({ ...(value as object),
    clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }], allProjections: [{ clauseIndex: 0, setIndex: 0, projection }] }));
  expect(correction).toContain('unresolved_author_projection_capacity'); expect(reader).not.toHaveBeenCalled();
});
