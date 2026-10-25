import { expect, it, vi } from 'vitest';
import { enumerateProposalQuantities, enumerateProposalQuantityClauses, reviewCompanionProposalQuantities, validateProposalQuantityRelations,
  type ProposalQuantityOperand, type ProposalQuantityRelations } from '../../src/main/companions/proposal-quantity-review';

const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' };
function classified(input: { proposal: unknown; adoptedPlan?: unknown }, claims: unknown[]) {
  const typed = claims as ProposalQuantityRelations['claims'];
  const ids = (claim: ProposalQuantityRelations['claims'][number]) => !claim.relation ? [] : claim.relation.kind === 'equal'
    ? [claim.relation.left, claim.relation.right] : claim.relation.kind === 'sum' ? [...claim.relation.terms, claim.relation.total]
      : [claim.relation.pool, claim.relation.recipients, ...(claim.relation.perRecipient ? [claim.relation.perRecipient] : []), ...claim.relation.reserved];
  return { claims, coverage: enumerateProposalQuantityClauses(input.proposal, input.adoptedPlan).map(clause => {
    const indexes = typed.flatMap((claim, index) => ['asserted', 'adopted'].includes(claim.disposition)
      && (clause.operandIds.some(id => ids(claim).includes(id)) || !clause.operandIds.length && claim.disposition === 'adopted') ? [index] : []);
    const nonasserted = typed.find(claim => !['asserted', 'adopted'].includes(claim.disposition));
    const classification = nonasserted ? nonasserted.disposition : indexes.length ? 'relation' : clause.operandIds.length ? 'quantity_only' : 'unrelated';
    return { clauseId: clause.id, classification, claimIndexes: classification === 'relation' ? indexes : [] };
  }) };
}
function operand(values: ProposalQuantityOperand[], document: ProposalQuantityOperand['document'], path: string, kind: ProposalQuantityOperand['kind']) {
  const found = values.find(value => value.document === document && value.path === path && value.kind === kind);
  if (!found) throw new Error('Missing actual operand: ' + path); return found.id;
}

it('rejects the actual five-items-for-four-seats assertion although its component sum is correct', async () => {
  const proposal = '我愿意当上帝、不抽牌。牌表 2 狼 + 1 预言家 + 2 平民 = 5，张数正好对得上抽牌的四位。';
  const values = enumerateProposalQuantities(proposal);
  expect(values.map(value => value.value)).toEqual([2, 1, 2, 5, 4]);
  const infer = vi.fn(async () => classified({ proposal }, [
    { disposition: 'asserted', evidence: { path: '', quote: proposal }, relation: { kind: 'sum', terms: values.slice(0, 3).map(value => value.id), total: values[3]!.id } },
    { disposition: 'asserted', evidence: { path: '', quote: '张数正好对得上抽牌的四位。' }, relation: { kind: 'allocation', pool: values[3]!.id, recipients: values[4]!.id, reserved: [] } },
  ]));
  const result = await reviewCompanionProposalQuantities({ proposal }, config, undefined, { infer });
  expect(result.allowed).toBe(false); expect(result.reason).toContain('5 与 4'); expect(infer).toHaveBeenCalledTimes(1);
});

it('measures actual array length and accepts an explicitly reserved item without selecting a scenario rule', () => {
  const proposal = { allocation: { recipients: ['a', 'b', 'c', 'd'], supplies: 5, reserve: 1 } };
  const values = enumerateProposalQuantities(proposal);
  const pool = operand(values, 'proposal', '/allocation/supplies', 'number');
  const recipients = operand(values, 'proposal', '/allocation/recipients', 'array_length');
  const reserve = operand(values, 'proposal', '/allocation/reserve', 'number');
  const claim = { disposition: 'asserted', evidence: { path: '/allocation' }, relation: { kind: 'allocation', pool, recipients, reserved: [reserve] } };
  expect(validateProposalQuantityRelations({ proposal }, classified({ proposal }, [claim]))).toEqual({ allowed: true });
  const unreserved = { allocation: { recipients: ['a', 'b', 'c', 'd'], supplies: 5 } };
  expect(validateProposalQuantityRelations({ proposal: unreserved }, classified({ proposal: unreserved }, [{ ...claim, relation: { ...claim.relation, reserved: [] } }])).allowed).toBe(false);
  const described = { summary: '五份材料，四位接收者每人一份，留一份备用。', recipients: ['a', 'b', 'c', 'd'], total: 5, perRecipient: 1, reserved: 1 };
  const textValues = enumerateProposalQuantities(described).filter(value => value.kind === 'text_number');
  const textClaim = { disposition: 'asserted', evidence: { path: '/summary', quote: described.summary }, relation: { kind: 'allocation',
    pool: textValues[0]!.id, recipients: textValues[1]!.id, perRecipient: textValues[2]!.id, reserved: [textValues[3]!.id] } };
  expect(enumerateProposalQuantityClauses(described).every(clause => clause.path === '/summary')).toBe(true);
  expect(validateProposalQuantityRelations({ proposal: described }, classified({ proposal: described }, [textClaim]))).toEqual({ allowed: true });
  expect(validateProposalQuantityRelations({ proposal: described }, classified({ proposal: described }, [
    textClaim, { disposition: 'asserted', evidence: { path: '/summary', quote: '五份材料' }, relation: null },
  ]))).toEqual({ allowed: true });
  const crossField = { summary: '按名单分配并保留备用。', recipients: ['a', 'b', 'c', 'd'], total: 5, perRecipient: 1, reserved: 1 };
  const crossValues = enumerateProposalQuantities(crossField);
  const crossClaim = { disposition: 'asserted', evidence: { path: '/summary', quote: crossField.summary }, relation: { kind: 'allocation',
    pool: operand(crossValues, 'proposal', '/total', 'number'), recipients: operand(crossValues, 'proposal', '/recipients', 'array_length'),
    perRecipient: operand(crossValues, 'proposal', '/perRecipient', 'number'), reserved: [operand(crossValues, 'proposal', '/reserved', 'number')] } };
  expect(validateProposalQuantityRelations({ proposal: crossField }, classified({ proposal: crossField }, [crossClaim]))).toEqual({ allowed: true });
});

it('checks sums and declared counts using exact escaped JSON paths rather than model supplied numbers', () => {
  const proposal = { 'a/b': { parts: [2, 1, 2], declared: 4, readers: ['a', 'b', 'c', 'd'], count: 4 } };
  const values = enumerateProposalQuantities(proposal);
  const terms = [0, 1, 2].map(index => operand(values, 'proposal', '/a~1b/parts/' + index, 'number'));
  const total = operand(values, 'proposal', '/a~1b/declared', 'number');
  const equality = { disposition: 'asserted', evidence: { path: '/a~1b' }, relation: { kind: 'equal',
    left: operand(values, 'proposal', '/a~1b/readers', 'array_length'), right: operand(values, 'proposal', '/a~1b/count', 'number') } };
  expect(validateProposalQuantityRelations({ proposal }, classified({ proposal }, [equality]))).toEqual({ allowed: true });
  expect(validateProposalQuantityRelations({ proposal }, classified({ proposal }, [{ disposition: 'asserted', evidence: { path: '/a~1b' }, relation: { kind: 'sum', terms, total } }])).allowed).toBe(false);
  expect(() => validateProposalQuantityRelations({ proposal }, classified({ proposal }, [{ ...equality, relation: { kind: 'equal', left: total, right: 'invented_5' } }]))).toThrow('不存在');
  expect(() => validateProposalQuantityRelations({ proposal }, classified({ proposal }, [{ ...equality, evidence: { path: '/invented' } }]))).toThrow('真实路径');
});

it('only checks a candidate old plan when the current proposal explicitly adopts it, even without new numbers', async () => {
  const adoptedPlan = { allocation: { recipients: ['a', 'b', 'c', 'd'], items: 5 } };
  const proposal = '现在按照已确认的安排开始发放。';
  const values = enumerateProposalQuantities(proposal, adoptedPlan);
  const allocation = { kind: 'allocation', pool: operand(values, 'adopted_plan', '/allocation/items', 'number'),
    recipients: operand(values, 'adopted_plan', '/allocation/recipients', 'array_length'), reserved: [] };
  const claim = { disposition: 'adopted', evidence: { path: '', quote: proposal }, planEvidencePath: '/allocation', relation: allocation };
  const infer = vi.fn(async () => classified({ proposal, adoptedPlan }, [claim]));
  expect((await reviewCompanionProposalQuantities({ proposal, adoptedPlan }, config, undefined, { infer })).allowed).toBe(false);
  expect(() => validateProposalQuantityRelations({ proposal, adoptedPlan }, classified({ proposal, adoptedPlan }, [{ ...claim, disposition: 'asserted' }]))).toThrow('明确采用');
  expect(() => validateProposalQuantityRelations({ proposal, adoptedPlan }, classified({ proposal, adoptedPlan }, [{ ...claim, evidence: { path: '' } }]))).toThrow('逐字引文');
  expect(() => validateProposalQuantityRelations({ proposal, adoptedPlan }, classified({ proposal, adoptedPlan }, [{ ...claim, planEvidencePath: '/allocation/recipients' }]))).toThrow('证据范围');
  const correction = '旧方案五份分给四人是错的，先不执行，等待修改。';
  expect(validateProposalQuantityRelations({ proposal: correction, adoptedPlan }, classified({ proposal: correction, adoptedPlan }, [{ disposition: 'quoted', evidence: { path: '', quote: correction }, relation: null }]))).toEqual({ allowed: true });
});

it('does not force uncertain alternative collections to be equal or permit quoted relationships to execute', () => {
  const proposal = '方案甲有五份物资；方案乙可能有四位参与者，是否采用尚未确定。';
  expect(validateProposalQuantityRelations({ proposal }, classified({ proposal }, [{ disposition: 'alternative', evidence: { path: '', quote: proposal }, relation: null }]))).toEqual({ allowed: true });
  const values = enumerateProposalQuantities(proposal);
  expect(() => validateProposalQuantityRelations({ proposal }, classified({ proposal }, [{ disposition: 'unknown', evidence: { path: '' },
    relation: { kind: 'equal', left: values[0]!.id, right: values[1]!.id } }]))).toThrow('不能冒充');
});

it('reviews real structured adoption without inventing adoption text or imposing an old plan on an ordinary private note', async () => {
  const adoptedPlan = { allocation: { recipients: ['a', 'b', 'c', 'd'], items: 5 } };
  const proposal = { operation: 'topic.update', privateUpdate: { workingState: { state: { phase: 'distribution', assignments: ['a', 'b', 'c', 'd'] } } } };
  const values = enumerateProposalQuantities(proposal, adoptedPlan);
  const claim = { disposition: 'adopted', evidence: { path: '/privateUpdate' }, planEvidencePath: '/allocation', relation: { kind: 'allocation',
    pool: operand(values, 'adopted_plan', '/allocation/items', 'number'), recipients: operand(values, 'adopted_plan', '/allocation/recipients', 'array_length'), reserved: [] } };
  const infer = vi.fn(async () => classified({ proposal, adoptedPlan }, [claim]));
  const result = await reviewCompanionProposalQuantities({ proposal, adoptedPlan }, config, undefined, { infer });
  expect(result.allowed).toBe(false); expect(result.reason).toContain('5 与 4'); expect(infer).toHaveBeenCalledTimes(1);
  const note = { operation: 'topic.update', privateUpdate: { workingState: { state: { mood: 'quiet' } } } };
  const noteInfer = vi.fn(async () => classified({ proposal: note, adoptedPlan }, []));
  expect(await reviewCompanionProposalQuantities({ proposal: note, adoptedPlan }, config, undefined, { infer: noteInfer })).toEqual({ allowed: true });
  expect(noteInfer).toHaveBeenCalledTimes(1);
});

it('skips no-quantity speech and whole date, time, UUID and identifier tokens without a semantic request', async () => {
  const infer = vi.fn(async () => { throw new Error('Should not request a model'); });
  for (const proposal of ['收到。', '2026-10-25T01:23:45Z；2026年10月25日；06ccd162-f809-47b5-8c2e-ceabf6f9ec3d；record_301']) {
    expect(enumerateProposalQuantities(proposal)).toEqual([]);
    expect(await reviewCompanionProposalQuantities({ proposal }, config, undefined, { infer })).toEqual({ allowed: true });
  }
  expect(infer).not.toHaveBeenCalled();
});

it('reuses an exact contradictory classification instead of sampling again until an identical proposal passes', async () => {
  const proposal = { quantityCacheCase: { available: 4, claimedEqual: 5 } }, values = enumerateProposalQuantities(proposal);
  const classification = classified({ proposal }, [{ disposition: 'asserted', evidence: { path: '/quantityCacheCase' },
    relation: { kind: 'equal', left: values[0]!.id, right: values[1]!.id } }]);
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(classification) } }] })));
  expect((await reviewCompanionProposalQuantities({ proposal }, config, undefined, { fetchFn })).allowed).toBe(false);
  expect((await reviewCompanionProposalQuantities({ proposal }, config, undefined, { fetchFn })).allowed).toBe(false);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('advertises exact document path enums and corrects a wrong transport-envelope path without rewriting it', async () => {
  const proposal = '五份完全对应四位。', values = enumerateProposalQuantities(proposal), adoptedPlan = { allocation: { people: ['a', 'b'] } };
  const infer = vi.fn(async (context: { user: string }) => {
    const data = JSON.parse(context.user), schema = data.outputSchema.properties.claims.items.properties;
    expect(schema.evidence.properties.path.enum).toEqual(['']);
    expect(schema.planEvidencePath.enum).toContain('/allocation');
    expect(data.evidencePathContract.proposalRootEvidenceExample).toEqual({ path: '', quote: proposal });
    if (infer.mock.calls.length === 2) expect(data.formatCorrection).toContain('evidence.path只可从[""]选');
    return classified({ proposal, adoptedPlan }, [{ disposition: 'asserted', evidence: { path: infer.mock.calls.length === 1 ? '/exactProposal' : '', quote: proposal },
      relation: { kind: 'equal', left: values[0]!.id, right: values[1]!.id } }]);
  });
  expect((await reviewCompanionProposalQuantities({ proposal, adoptedPlan }, config, undefined, { infer })).allowed).toBe(false);
  expect(infer).toHaveBeenCalledTimes(2);
});

it('rejects omitted later subclauses, a correct sum used as their cover, and unknown allocation coverage', () => {
  const proposal = '2 + 1 + 2 = 5，张数正好对得上四位。', values = enumerateProposalQuantities(proposal);
  const sum = { disposition: 'asserted', evidence: { path: '', quote: proposal }, relation: { kind: 'sum',
    terms: values.slice(0, 3).map(value => value.id), total: values[3]!.id } };
  const raw = classified({ proposal }, [sum]);
  expect(raw.coverage).toHaveLength(2);
  expect(() => validateProposalQuantityRelations({ proposal }, { ...raw, coverage: raw.coverage.slice(0, 1) })).toThrow('不能遗漏后半句');
  expect(() => validateProposalQuantityRelations({ proposal }, { ...raw, coverage: raw.coverage.map(row => ({ ...row, classification: 'relation', claimIndexes: [0] })) })).toThrow('前文正确等式');
  expect(() => validateProposalQuantityRelations({ proposal }, raw)).toThrow('不能只标纯数量');
  expect(() => validateProposalQuantityRelations({ proposal }, { ...raw, coverage: raw.coverage.map((row, index) => index ? { ...row, classification: 'unrelated', claimIndexes: [] } : row) })).toThrow('不能标无关');
  const unknown = { ...raw, coverage: raw.coverage.map((row, index) => index ? { ...row, classification: 'unknown', claimIndexes: [] } : row) };
  expect(validateProposalQuantityRelations({ proposal }, unknown).allowed).toBe(false);
  const lexical = '大家一起讨论，我这一席不让给别人。';
  expect(enumerateProposalQuantities(lexical).length).toBeGreaterThan(0);
  expect(validateProposalQuantityRelations({ proposal: lexical }, { claims: [], coverage: enumerateProposalQuantityClauses(lexical)
    .map(clause => ({ clauseId: clause.id, classification: 'unrelated', claimIndexes: [] })) })).toEqual({ allowed: true });
});

it('skips pure collection transport metadata without a current numerical assertion or natural-language context', async () => {
  const infer = vi.fn(async () => { throw new Error('Should not request a semantic review'); });
  expect(await reviewCompanionProposalQuantities({ proposal: { recipientIds: ['a', 'b'], topic: { tags: [] } } }, config, undefined, { infer })).toEqual({ allowed: true });
  expect(infer).not.toHaveBeenCalled();
});
