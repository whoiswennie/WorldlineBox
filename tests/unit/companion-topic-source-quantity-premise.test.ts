import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { reviewTopicSourceQuantities as actualQuantityReview, topicQuantityNumberCandidates } from '../../src/main/companions/topic-summary-quantity-review';
import { topicSummaryClauses } from '../../src/main/companions/topic-summary-canon-review';
import { admitQuantitySourcePremises, buildQuantitySourcePremiseCandidates, quantitySourceEvidenceClauses,
  quantitySourcePremiseInput, quantitySourcePremiseSchema, quantitySourcePremiseSystem, validateQuantitySourcePremises } from '../../src/main/companions/topic-source-quantity-premise';
import { declaredDisjointQuantityFixture, declaredWarmAllFixture, withDeclaredQuantitySemanticFixture } from '../helpers/companion-quantity-role-fixture';

const reviewTopicSourceQuantities = (options: Parameters<typeof actualQuantityReview>[0]) => actualQuantityReview(withDeclaredQuantitySemanticFixture(options));

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

it.each(['reply', 'summary'] as const)('keeps source-only and identity prompts separate from numeric-value instructions through the actual %s provider path', async kind => {
  const text = '张明拿着7张照片，这套物品与来源库存互不共用。', systems = new Map<string, string>(), payloads = new Map<string, unknown>();
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), wire = JSON.parse(request.messages.at(-1).content);
    systems.set(wire.purpose, request.messages[0].content); payloads.set(wire.purpose, wire.data);
    let output: unknown;
    if (wire.purpose.endsWith('_source_sets')) output = { sets: [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] };
    else if (wire.purpose.endsWith('_source_premise_verification')) output = premiseResponse(wire.data);
    else if (wire.purpose.endsWith('_actual_claims')) output = declaredWarmAllFixture({ user: JSON.stringify(wire) }, { clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] });
    else if (wire.purpose.endsWith('_role_verification')) output = { reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0, collection: 'different',
      voice: 'narrated_fact', time: 'scene', relation: 'affirmed_holding', kind: 'count', reason: '明确另一组的实际数量。' }], all: { ...noAll, collection: 'different' } }] };
    else if (wire.purpose.endsWith('_semantic_exemption_verification')) output = await declaredDisjointQuantityFixture({ system: request.messages[0].content, user: JSON.stringify(wire) });
    else throw new Error('Unexpected quantity phase in the isolated actual provider path.');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  expect(await reviewTopicSourceQuantities({ kind, config, fetchFn, canon: sourceCanon(), summary: text, stage: '', clauses: topicSummaryClauses(text, '') })).toBeUndefined();
  const prefix = 'topic_' + kind + '_quantity_';
  expect([...systems.keys()]).toEqual(['source_sets', 'source_premise_verification', 'actual_claims', 'role_verification', 'semantic_exemption_verification'].map(phase => prefix + phase));
  expect(fetchFn).toHaveBeenCalledTimes(5);
  expect(systems.get(prefix + 'source_premise_verification')).toBe(quantitySourcePremiseSystem);
  expect(quantitySourcePremiseSystem).toContain('不要求知道或换算其具体数值');
  expect(quantitySourcePremiseSystem).toContain('成员与这份集合关系不明只令该member.applicability=ambiguous');
  for (const phase of ['source_premise_verification', 'semantic_exemption_verification']) {
    expect(systems.get(prefix + phase)).not.toContain('宿主numberCandidates.value=null');
    expect(systems.get(prefix + phase)).not.toContain('来源总数/缺失序号不可计算时不能建立set');
  }
  for (const phase of ['source_sets', 'role_verification']) expect(systems.get(prefix + phase)).toContain('宿主numberCandidates.value=null');
  expect(systems.get(prefix + 'actual_claims')).toContain('value=null只弃权该数值');
  const blindData = payloads.get(prefix + 'actual_claims') as { sets: unknown[] };
  expect(blindData.sets).toEqual([{ setIndex: 0, entityQuote: '照片' }]);
  const premiseData = payloads.get(prefix + 'source_premise_verification') as ReturnType<typeof quantitySourcePremiseInput>;
  expect(premiseData.candidates[0]!.numberReferences.every(reference => !('value' in reference) && !('numberQuote' in reference))).toBe(true);
  expect(premiseData).not.toHaveProperty('proposed'); expect(premiseData).not.toHaveProperty('upper'); expect(premiseData).not.toHaveProperty('warm');
});

it('still filters an actually uncomputable source total before the source-only reviewer instead of confusing masking with null', async () => {
  const verifySourcePremises = vi.fn(), systems: string[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), wire = JSON.parse(request.messages.at(-1).content);
    systems.push(request.messages[0].content);
    expect(wire.purpose).toBe('topic_reply_quantity_source_sets');
    expect(wire.data.canon[0].numberCandidates[0].value).toBeNull();
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ sets: [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex: 0,
      missingOrdinalNumberIndexes: [1] }] }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  expect(await reviewTopicSourceQuantities({ kind: 'reply', config, fetchFn, verifySourcePremises, canon: sourceCanon('盒内一万张照片，第5张照片未取得。'),
    summary: '她拿着7张照片。', stage: '', clauses: topicSummaryClauses('她拿着7张照片。', '') })).toBeUndefined();
  expect(fetchFn).toHaveBeenCalledTimes(1); expect(verifySourcePremises).not.toHaveBeenCalled();
  expect(systems[0]).toContain('宿主numberCandidates.value=null');
});

it.each([
  { id: 'same_inventory_and_time', quote: '蓝盒共有7张照片，第5张照片尚未取得。', applicability: 'current_direct', diagnostic: 'mathematical_contradiction' },
  { id: 'same_inventory_shared_custody', quote: '本组共有7张照片，由张明和王玲共同保管，第5张照片尚未取得。', applicability: 'current_direct', diagnostic: 'mathematical_contradiction' },
  { id: 'same_inventory_transferred_box', quote: '本组7张照片从蓝盒转存红盒，第5张照片尚未取得。', applicability: 'current_direct', diagnostic: 'mathematical_contradiction' },
  { id: 'other_box_inventory', quote: '蓝盒共有7张照片。红盒独立库存的第5张照片尚未取得。', applicability: 'outside_current_inventory' },
  { id: 'other_owner_inventory', quote: '张明共有7张照片。王玲独立库存的第5张照片尚未取得。', applicability: 'outside_current_inventory' },
  { id: 'different_inventory_time', quote: '去年这组有7张照片。今年第5张照片尚未取得。', applicability: 'outside_current_inventory' },
  { id: 'attributed_inventory', quote: '这组共有7张照片。王玲声称第5张照片未取得。', applicability: 'attributed_or_conditional' },
  { id: 'only_total_inventory_attributed', quote: '王玲声称这组共有7张照片。第5张照片尚未取得。', applicability: 'attributed_or_conditional' },
  { id: 'only_total_inventory_conditional', quote: '如果这组共有7张照片，第5张照片尚未取得。', applicability: 'attributed_or_conditional' },
  { id: 'masked_identity_uncertain', quote: 'A17共有7张照片。A18的第5张照片未取得。', applicability: 'ambiguous', diagnostic: 'unresolved_source_premise' },
])('keeps total syntax independent and applies member absence only relative to that inventory and time: $id', async test => {
  const text = '她拿着7张照片。', sourceNumbers = topicQuantityNumberCandidates(test.quote), extractClaims = vi.fn(async () => ({ clauses: [{
    clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }));
  const totalNumberIndex = sourceNumbers.find(number => number.numberQuote === '7')!.numberIndex;
  const ordinalNumberIndex = sourceNumbers.find(number => number.ordinal && number.value === 5)!.numberIndex;
  const result = await reviewTopicSourceQuantities({ kind: 'reply', config, canon: sourceCanon(test.quote), summary: text, stage: '',
    clauses: topicSummaryClauses(text, ''),
    fetchFn: vi.fn<typeof fetch>(async () => { throw new Error('No actual transport is permitted in the relative-inventory contract control.'); }),
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex, missingOrdinalNumberIndexes: [ordinalNumberIndex] }] }),
    verifySourcePremises: async context => {
      const data = JSON.parse(context.user).data;
      expect(context.system).toBe(quantitySourcePremiseSystem);
      expect(context.system).toContain('不比较总数与member序号');
      expect(context.system).toContain('相对于totalReference所计的那份实际inventory及其适用时点');
      expect(context.system).toContain('不能只因另一组自己的句子是现在时就扣本组库存');
      expect(context.system).toContain('换owner或容器本身不充分，同组共管或同一集合转盒仍可current_direct');
      expect(context.system).toContain('total所计库存本身与该member未得/可用状态均为直接陈述并适用于同一实际当前库存及其时点');
      expect(context.system).toContain('total库存侧或member状态侧任一侧仅人物声称/条件/计划均为attributed_or_conditional');
      expect(data.candidates[0].numberReferences.every((reference: Record<string, unknown>) => !('value' in reference))).toBe(true);
      return premiseResponse(data, { applicability: test.applicability });
    },
    extractClaims,
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0, collection: 'same', voice: 'narrated_fact', time: 'scene',
      relation: 'affirmed_holding', kind: 'count', reason: '本地注入的拟稿同集合控制，不声称实模分类准确率。' }], all: noAll }] }) });
  if (test.diagnostic) { expect(result).toContain(test.diagnostic); expect(extractClaims).toHaveBeenCalledTimes(1); }
  else { expect(result).toBeUndefined(); expect(extractClaims).not.toHaveBeenCalled(); }
  if (test.applicability === 'ambiguous') expect(result).not.toContain('mathematical_contradiction');
});

it.each([
  '照片盒编号7，第5张照片尚未取得。',
  '这箱照片重7千克，第5张照片尚未取得。',
])('does not admit a source number that is not a cardinality of the actual object collection: %s', async quote => {
  const extractClaims = vi.fn(), verifyRoles = vi.fn();
  expect(await reviewTopicSourceQuantities({ kind: 'reply', config, canon: sourceCanon(quote), summary: '她拿着7张照片。', stage: '',
    clauses: topicSummaryClauses('她拿着7张照片。', ''),
    extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '照片', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }),
    verifySourcePremises: async context => {
      const data = JSON.parse(context.user).data;
      expect(context.system).toContain('时间、重量、ID或属性的数量不是物品本体集合的基数');
      return { sets: premiseResponse(data).sets.map(set => ({ ...set, totalBinding: 'not_supported' })) };
    }, extractClaims, verifyRoles })).toBeUndefined();
  expect(extractClaims).not.toHaveBeenCalled(); expect(verifyRoles).not.toHaveBeenCalled();
});
