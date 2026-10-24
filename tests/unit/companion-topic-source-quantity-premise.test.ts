import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { reviewTopicSourceQuantities, topicQuantityNumberCandidates } from '../../src/main/companions/topic-summary-quantity-review';
import { topicSummaryClauses } from '../../src/main/companions/topic-summary-canon-review';
import { admitQuantitySourcePremises, buildQuantitySourcePremiseCandidates, quantitySourceEvidenceClauses,
  quantitySourcePremiseInput, quantitySourcePremiseSchema, validateQuantitySourcePremises } from '../../src/main/companions/topic-source-quantity-premise';
import { declaredDisjointQuantityFixture } from '../helpers/companion-quantity-role-fixture';

function candidates(quote = '盒内有7张照片，第5张背面的名字仍不可辨认。', totalNumberIndex = 0, missingOrdinalNumberIndexes = [1]) {
  return buildQuantitySourcePremiseCandidates([{ canonIndex: 0, sourceMessageId: 'actual-source', sourceChecksum: 'c'.repeat(64), quote,
    numberCandidates: topicQuantityNumberCandidates(quote) }], [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex, missingOrdinalNumberIndexes }]);
}
function receipt(items = candidates(), changes: Record<string, unknown> = {}, setChanges: Record<string, unknown> = {}) {
  return quantitySourcePremiseSchema.parse({ sets: items.map(item => ({ setIndex: item.setIndex, totalBinding: 'supported',
    totalEvidenceClauseIndex: item.totalClauseIndex, reason: '独立核实际来源总数本体。',
    members: [...item.memberClauseIndexes].map(([ordinalNumberIndex, clauseIndex]) => ({ ordinalNumberIndex, evidenceClauseIndexes: [clauseIndex],
      predicateTarget: 'physical_member', memberAvailability: 'not_possessed', applicability: 'current_direct', reason: '本体当前明确未得。', ...changes })),
    ...setChanges })) });
}

it.each([
  { predicateTarget: 'physical_member', memberAvailability: 'not_possessed', applicability: 'current_direct', result: 'confirmed' },
  { predicateTarget: 'physical_member', memberAvailability: 'ambiguous', applicability: 'current_direct', result: 'unresolved' },
  { predicateTarget: 'physical_member', memberAvailability: 'not_possessed', applicability: 'ambiguous', result: 'unresolved' },
  { predicateTarget: 'physical_member', memberAvailability: 'ambiguous', applicability: 'ambiguous', result: 'unresolved' },
  { predicateTarget: 'member_attribute', memberAvailability: 'present', applicability: 'current_direct', result: 'excluded' },
  { predicateTarget: 'member_attribute', memberAvailability: 'not_possessed', applicability: 'current_direct', result: 'excluded' },
  { predicateTarget: 'physical_member', memberAvailability: 'present', applicability: 'current_direct', result: 'excluded' },
  { predicateTarget: 'physical_member', memberAvailability: 'not_stated', applicability: 'current_direct', result: 'excluded' },
  { predicateTarget: 'physical_member', memberAvailability: 'not_possessed', applicability: 'outside_current_inventory', result: 'excluded' },
  { predicateTarget: 'physical_member', memberAvailability: 'not_possessed', applicability: 'attributed_or_conditional', result: 'excluded' },
  { predicateTarget: 'ambiguous', memberAvailability: 'not_possessed', applicability: 'current_direct', result: 'excluded' },
  { predicateTarget: 'none', memberAvailability: 'ambiguous', applicability: 'ambiguous', result: 'excluded' },
])('admits only independently supported physical availability and never turns attributes into absent objects: %j', test => {
  const input = candidates();
  const { result, ...classification } = test;
  const actual = admitQuantitySourcePremises(receipt(input, classification), input);
  if (result === 'excluded') expect(actual).toEqual([]);
  else {
    expect(actual[0]!.total).toBe(7);
    expect(actual[0]!.missingOrdinals).toEqual(result === 'confirmed' ? [5] : []);
    expect(actual[0]!.unresolvedOrdinals).toEqual(result === 'unresolved' ? [5] : []);
  }
});

it.each(['not_supported', 'ambiguous'])('does not construct a factual or possible bound from an unverified total: %s', totalBinding => {
  const input = candidates();
  expect(admitQuantitySourcePremises(receipt(input, {}, { totalBinding }), input)).toEqual([]);
});

it('binds complete UTF16 source clauses and exposes only opaque number references to the source-only reviewer', () => {
  const quote = '😺A17的盒内共有7张照片。第5张照片背面姓名不可辨认。';
  const input = candidates(quote, 1, [2]), data = quantitySourcePremiseInput(input).candidates[0]!;
  for (const clause of quantitySourceEvidenceClauses(quote)) expect(quote.slice(clause.start, clause.end)).toBe(clause.text);
  expect(data.sourceClauses[0]!.start).toBe(0);
  expect(data.sourceClauses[0]!.text).toContain('😺A〔候选A〕');
  expect(data.sourceClauses[0]!.text).toContain('〔候选B〕张照片');
  expect(data.sourceClauses[1]!.text).toContain('第〔候选C〕张照片');
  expect(data.sourceClauses.every(clause => !/[\p{N}一二三四五六七八九十]/u.test(clause.text))).toBe(true);
  expect(data.numberReferences.every(span => !('value' in span) && !('numberQuote' in span))).toBe(true);
  expect(data.totalReference).toEqual({ numberIndex: 1, clauseIndex: 0 });
  expect(data.members).toEqual([{ ordinalNumberIndex: 2, memberClauseIndex: 1 }]);
  expect(data.sourceQuoteChecksum).toBe(createHash('sha256').update(quote).digest('hex'));
  expect(data).not.toHaveProperty('proposed'); expect(data).not.toHaveProperty('upper'); expect(data).not.toHaveProperty('warm');
});

it('does not leak detectable alternative numeral aliases through the source evidence view', () => {
  const input = candidates('盒内7张照片，第5张姓名未知，旁注Ⅲ、③、叁。');
  const text = quantitySourcePremiseInput(input).candidates[0]!.sourceClauses.map(clause => clause.text).join('');
  expect(text).not.toMatch(/[Ⅲ③叁]/u); expect(text).toContain('〔数值已遮蔽〕');
});

it.each(['foreign_set', 'missing_set', 'duplicate_set', 'foreign_member', 'missing_member', 'duplicate_member', 'foreign_evidence', 'wrong_total_evidence', 'missing_member_clause'])(
  'rejects incomplete or forged source-premise evidence before authority admission: %s', mode => {
    const input = candidates('盒内7张照片。第5张照片未取得。'), value = receipt(input), set = value.sets[0]!;
    if (mode === 'foreign_set') set.setIndex = 99;
    if (mode === 'missing_set') value.sets = [];
    if (mode === 'duplicate_set') value.sets.push({ ...set });
    if (mode === 'foreign_member') set.members[0]!.ordinalNumberIndex = 99;
    if (mode === 'missing_member') set.members = [];
    if (mode === 'duplicate_member') set.members.push({ ...set.members[0]! });
    if (mode === 'foreign_evidence') set.members[0]!.evidenceClauseIndexes = [99];
    if (mode === 'wrong_total_evidence') set.totalEvidenceClauseIndex = 1;
    if (mode === 'missing_member_clause') set.members[0]!.evidenceClauseIndexes = [0];
    expect(() => validateQuantitySourcePremises(value, input)).toThrow('source premise');
    expect(() => admitQuantitySourcePremises(value, input)).toThrow('source premise');
  });

it('never makes null, ordinal totals, duplicate or out-of-range source members into a calculable premise', () => {
  expect(candidates('盒内一万张照片，第5张未拿到。')).toEqual([]);
  expect(() => candidates('第7张照片在场，第5张未拿到。')).toThrow('source premise');
  expect(() => candidates('盒内7张照片，第8张未拿到。')).toThrow('source premise');
  expect(() => candidates(undefined, 0, [1, 1])).toThrow('source premise');
});

it('binds receipt provenance to exact source bytes without calling the quotation a semantic proof', () => {
  const original = candidates('盒内7张照片，第5张未拿到。'), revised = candidates('盒内7张照片，第5张已经拿到。');
  const before = admitQuantitySourcePremises(receipt(original), original)[0]!.sourcePremiseReceipt;
  const after = admitQuantitySourcePremises(receipt(revised), revised)[0]!.sourcePremiseReceipt;
  expect(before.sourceMessageId).toBe(after.sourceMessageId); expect(before.sourceQuoteChecksum).not.toBe(after.sourceQuoteChecksum);
  expect(before.sourceChecksum).toBe('c'.repeat(64));
  expect(before.review.members[0]!.evidenceClauseIndexes).toEqual([0]);
});

const config = { apiFormat: 'openai_chat' as const, model: 'source-premise-fixture', apiKey: 'fixture' };
const sourceCanon = (quote = '盒内有7张照片，第5张照片仍未取得。') => ({ version: 1 as const, throughSequence: 2,
  entries: [{ id: 'actual-photo-rule', sourceMessageId: 'photo-source', sourceChecksum: createHash('sha256').update(quote).digest('hex'), quote, rule: quote }] });
const noAll = { collection: 'same', voice: 'narrated_fact', time: 'scene', relation: 'not_affirmed_all', reason: '无独立all断言。' };
function premiseResponse(data: { candidates: Array<{ setIndex: number; totalReference: { clauseIndex: number }; members: Array<{ ordinalNumberIndex: number; memberClauseIndex: number }> }> },
  changes: Record<string, unknown> = {}) {
  return { sets: data.candidates.map(candidate => ({ setIndex: candidate.setIndex, totalBinding: 'supported',
    totalEvidenceClauseIndex: candidate.totalReference.clauseIndex, reason: '独立原句关系判定。', members: candidate.members.map(member => ({
      ordinalNumberIndex: member.ordinalNumberIndex, evidenceClauseIndexes: [member.memberClauseIndex], predicateTarget: 'physical_member',
      memberAvailability: 'not_possessed', applicability: 'current_direct', reason: '实际物体可用性判定。', ...changes })) })) };
}

it.each(['member_attribute', 'present', 'not_stated'])('does not dispatch draft review after an independent negative physical premise: %s', async kind => {
  const text = '她把7张照片全部拿在手里。', extractClaims = vi.fn(), verifyRoles = vi.fn();
  expect(await reviewTopicSourceQuantities({ kind: 'reply', config, canon: sourceCanon('盒内有7张照片，第5张背面的名字仍不可辨认。'), summary: text, stage: '',
    clauses: topicSummaryClauses(text, ''), extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: async context => premiseResponse(JSON.parse(context.user).data, kind === 'member_attribute' ? { predicateTarget: kind } : { memberAvailability: kind }),
    extractClaims, verifyRoles })).toBeUndefined();
  expect(extractClaims).not.toHaveBeenCalled(); expect(verifyRoles).not.toHaveBeenCalled();
});

it.each([
  { text: '她拿着7张照片。', availability: 'not_possessed', diagnostic: 'mathematical_contradiction' },
  { text: '她拿着7张照片。', availability: 'ambiguous', diagnostic: 'unresolved_source_premise' },
  { text: '她拿着6张照片。', availability: 'ambiguous' },
  { text: '她拿着第5张照片。', availability: 'ambiguous', member: true, diagnostic: 'unresolved_source_premise' },
  { text: '她拿着第6张照片。', availability: 'ambiguous', member: true },
  { text: '她把照片全部拿齐。', availability: 'ambiguous', all: true, diagnostic: 'unresolved_source_premise' },
  { text: '另一组拿着7张照片。', availability: 'ambiguous', collection: 'different' },
  { text: '她声称拿着7张照片。', availability: 'ambiguous', voice: 'attributed_claim' },
  { text: '多年前她拿着7张照片。', availability: 'ambiguous', time: 'earlier_history' },
  { text: '她拿着一万张照片。', availability: 'ambiguous' },
])('keeps unconfirmed physical absence out of arithmetic and only raises an actual possible conflict: $text $availability', async test => {
  const clauses = topicSummaryClauses(test.text, '');
  const correction = await reviewTopicSourceQuantities({ kind: 'reply', config, canon: sourceCanon(), summary: test.text, stage: '', clauses,
    fetchFn: vi.fn<typeof fetch>(async () => { throw new Error('Unexpected transport in a declared source-premise fixture.'); }),
    verifyDisjointWaivers: declaredDisjointQuantityFixture,
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: async context => premiseResponse(JSON.parse(context.user).data, { memberAvailability: test.availability }),
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: test.all ? 'current_possessed_all' : test.member ? 'current_possessed_members' : 'current_possessed_count',
      numberIndexes: test.all ? [] : [0] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: topicQuantityNumberCandidates(test.text).map(number => ({ numberIndex: number.numberIndex,
      collection: test.collection ?? 'same', voice: test.voice ?? 'narrated_fact', time: test.time ?? 'scene', relation: 'affirmed_holding', kind: test.member ? 'member' : 'count', reason: '独立拟稿关系。' })),
    all: { ...noAll, relation: test.all ? 'affirmed_all' : 'not_affirmed_all' } }] }) });
  if (test.diagnostic) expect(correction).toContain(test.diagnostic); else expect(correction).toBeUndefined();
  if (test.diagnostic === 'unresolved_source_premise') expect(correction).not.toContain('mathematical_contradiction');
});

it('requires complete source-only receipts in the original three bounded format slots without advancing to draft review', async () => {
  const verifySourcePremises = vi.fn(async context => {
    const wire = JSON.parse(context.user);
    if (wire.formatCorrection) { expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500); expect(wire.formatCorrection).toContain('source premise'); }
    return { sets: [] };
  }), extractClaims = vi.fn();
  await expect(reviewTopicSourceQuantities({ kind: 'reply', config, canon: sourceCanon(), summary: '她拿7张照片。', stage: '', clauses: topicSummaryClauses('她拿7张照片。', ''),
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }), verifySourcePremises, extractClaims })).rejects.toThrow('未发布正文');
  expect(verifySourcePremises).toHaveBeenCalledTimes(3); expect(extractClaims).not.toHaveBeenCalled();
});

it('caches only independently verified negative receipts and invalidates the cache for exact-source revisions and owner changes', async () => {
  const purposes: string[] = [], quote = '盒内7张照片，第5张背面名字不清。';
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), wire = JSON.parse(request.messages.at(-1).content);
    purposes.push(wire.purpose);
    const output = wire.purpose.endsWith('_source_sets') ? { sets: [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }
      : premiseResponse(wire.data, { predicateTarget: 'member_attribute', memberAvailability: 'present' });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const run = (actualQuote: string, ownerId: string) => reviewTopicSourceQuantities({ kind: 'reply', config, fetchFn,
    canon: sourceCanon(actualQuote), summary: '她拿7张照片。', stage: '', clauses: topicSummaryClauses('她拿7张照片。', ''),
    scope: { ownerId, conversationId: 'verified-negative-receipt-room', topicId: 'photo-topic' } });
  await expect(run(quote, 'owner-a')).resolves.toBeUndefined(); await expect(run(quote, 'owner-a')).resolves.toBeUndefined();
  expect(purposes).toEqual(['topic_reply_quantity_source_sets', 'topic_reply_quantity_source_premise_verification']);
  await expect(run(quote + '原文实际修订。', 'owner-a')).resolves.toBeUndefined(); await expect(run(quote, 'owner-b')).resolves.toBeUndefined();
  expect(purposes).toHaveLength(6);
});

it('does not cache a raw empty proposal as a verified negative source receipt', async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"sets":[]}' } }] }), { headers: { 'Content-Type': 'application/json' } }));
  for (let repeat = 0; repeat < 2; repeat++) await expect(reviewTopicSourceQuantities({ kind: 'reply', config, fetchFn, canon: sourceCanon(),
    summary: '她拿7张照片。', stage: '', clauses: topicSummaryClauses('她拿7张照片。', ''),
    scope: { ownerId: 'raw-empty-owner', conversationId: 'raw-empty-room', topicId: 'raw-empty-topic' } })).resolves.toBeUndefined();
  expect(fetchFn).toHaveBeenCalledTimes(2);
});
