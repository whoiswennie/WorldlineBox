import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { reviewTopicSourceQuantities as productionQuantityReview, topicQuantityNumberCandidates } from '../../src/main/companions/topic-summary-quantity-review';
import { topicSummaryClauses } from '../../src/main/companions/topic-summary-canon-review';
import type { TopicUserCanon } from '../../src/main/companions/topic-user-canon';
import { confirmedQuantitySourcePremiseFixture, declaredDisjointQuantityFixture, quantityRoleFixture, withDeclaredQuantitySemanticFixture } from '../helpers/companion-quantity-role-fixture';

const actualProductionQuantityReview = (options: Parameters<typeof productionQuantityReview>[0]) => productionQuantityReview(withDeclaredQuantitySemanticFixture(options));

const actualQuantityReview = (options: Parameters<typeof actualProductionQuantityReview>[0]) => actualProductionQuantityReview({ ...options,
  verifyRoles: options.verifyRoles ? quantityRoleFixture(options.verifyRoles) : undefined });
const reviewTopicSourceQuantities = actualQuantityReview;

const config = { apiFormat: 'openai_chat' as const, model: 'synthetic', apiKey: 'fixture' };
const canon: TopicUserCanon = { version: 1, throughSequence: 2, entries: [{ id: 'actual-total-missing', sourceMessageId: 'actual-source', sourceChecksum: 'c'.repeat(64),
  quote: '共有3把钥匙，第2把仍未找到，不能自行找回。', rule: '自由解释不是数学来源' }] };
const extractSets = async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] });
const input = (text: string) => ({ kind: 'reply' as const, canon, summary: text, stage: '', config, clauses: topicSummaryClauses(text, ''), extractSets,
  fetchFn: vi.fn<typeof fetch>(async () => { throw new Error('Unexpected transport in a declared semantic fixture.'); }),
  verifySourcePremises: confirmedQuantitySourcePremiseFixture });
const originalParagraph = '许岚把这句话在心里过了一遍。她想起口袋里的三把钥匙，冰冷的金属贴在大腿外侧。第一把在她手里，第三把也在她手里，第二把却始终没有找到——翻遍了该翻的地方，问了该问的人，得到的都是模棱两可的摇头。这件事她没对A17提起。';

it.each(['current_possessed_count', 'total', 'planned', 'attributed', 'missing'] as const)('audits original prose and independently rejects three-held even when warm usage is %s', async warmUsage => {
  const purposes: string[] = [], base = input(originalParagraph);
  const correction = await reviewTopicSourceQuantities({ ...base,
    extractSets: async context => { const wire = JSON.parse(context.user); purposes.push(wire.purpose);
      expect(wire.data.canon[0].quote).toBe(canon.entries[0]!.quote); return extractSets(); },
    extractClaims: async context => { const wire = JSON.parse(context.user); purposes.push(wire.purpose);
      expect(wire.data.proposed).toEqual({ kind: 'reply', text: originalParagraph });
      expect(wire.data.actualClauses.map((clause: { text: string }) => clause.text)).toEqual(base.clauses.map(clause => clause.text));
      return { clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex, quantities: clause.text.includes('口袋里的三把钥匙')
        ? [{ setIndex: 0, usage: warmUsage, numberIndexes: [0] }] : [] })) }; },
    verifyRoles: async context => { const wire = JSON.parse(context.user); purposes.push(wire.purpose);
      expect(wire.data.proposed).toBeUndefined(); expect(context.user).not.toContain(canon.entries[0]!.quote);
      expect(wire.data.candidates).toHaveLength(1); expect(wire.data.candidates[0].actualClause).toContain('口袋里的三把钥匙');
      return { reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind: 'count', currentNumberIndexes: [0], reason: '实际叙述名词短语断言口袋中三把，不是过去或他人发言。' }] }; } });
  expect(purposes).toEqual(['topic_reply_quantity_source_sets', 'topic_reply_quantity_actual_claims', 'topic_reply_quantity_role_verification']);
  expect(correction).toContain('"availableUpperBound":2'); expect(correction).toContain('原提案未正式发布');
  expect(correction).toContain('口袋里的三把钥匙');
});

it.each(['missing', 'total', 'planned', 'historical', 'attributed', 'ambiguous'] as const)('retains semantic abstention for reply quantity usage %s', async usage => {
  const text = '男人声称“她以后会带三把钥匙”。', base = input(text), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0,
    assertion: 'attributed', kind: 'not_current', currentNumberIndexes: [], reason: '真实局部语法是他人的未来声称，不是叙述者当前实际持有。' }] }));
  expect(await reviewTopicSourceQuantities({ ...base, verifyRoles,
    extractClaims: async () => ({ clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: [{ setIndex: 0, usage, numberIndexes: [0] }] })) }) })).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('allows first-and-third possession, yet rejects holding the explicitly missing second member', async () => {
  for (const [text, numbers, rejected] of [['她携带第1和第3把钥匙。', ['1', '3'], false], ['她携带第1和第2把钥匙。', ['1', '2'], true]] as const) {
    const base = input(text);
    const correction = await reviewTopicSourceQuantities({ ...base,
      extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_members',
        numberIndexes: numbers.map((_number, index) => index) }] }] }),
      verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind: 'members', currentNumberIndexes: [0, 1], reason: '独立核对实际持有成员的字面序号。' }] }) });
    expect(!!correction).toBe(rejected);
  }
});

it('allows a cold grammar review to identify past possession without seeing canon or accepting a mathematical waiver', async () => {
  const base = input('她回想多年前口袋里有三把钥匙。');
  expect(await reviewTopicSourceQuantities({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles: async context => { expect(context.user).not.toContain(canon.entries[0]!.quote); expect(context.user).not.toContain('availableUpperBound');
      return { reviews: [{ candidateIndex: 0, assertion: 'earlier_history', kind: 'not_current', currentNumberIndexes: [], reason: '多年前明确给出过去的持有，不断言当前。' }] }; } })).toBeUndefined();
});

it('does not dispatch any quantity model when no actual user canon exists', async () => {
  const infer = vi.fn();
  expect(await reviewTopicSourceQuantities({ ...input(originalParagraph), canon: { version: 1, throughSequence: 2, entries: [] },
    extractSets: infer, extractClaims: infer, verifyRoles: infer })).toBeUndefined();
  expect(infer).not.toHaveBeenCalled();
});

it('does not certify an explicit ordinal as a cardinal count and lets the same bounded format slot correct its grammar', async () => {
  const base = input('她持有第1和第3把钥匙。');
  const verifyRoles = vi.fn(async context => {
    const wire = JSON.parse(context.user);
    if (!wire.formatCorrection) return { reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind: 'count', currentNumberIndexes: [1], reason: '错误把末位3当数量' }] };
    expect(wire.formatCorrection).toContain('第N成员序号'); expect(context.user).not.toContain(canon.entries[0]!.quote);
    return { reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind: 'members', currentNumberIndexes: [0, 1], reason: '实际第1、第3是成员序号，不是3个。' }] };
  });
  expect(await reviewTopicSourceQuantities({ ...base, verifyRoles,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_members',
      numberIndexes: [0, 1] }] }] }) })).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(2);
});

it.each([
  ['collection_total', '共有三把钥匙。', '三', 'count'],
  ['not_possessed', '她没携带第2把钥匙。', '2', 'members'],
  ['earlier_history', '多年前她携带三把钥匙。', '三', 'count'],
  ['planned', '她计划带三把钥匙。', '三', 'count'],
  ['attributed', '男人声称“她带着三把钥匙”。', '三', 'count'],
  ['ambiguous', '也许她带着三把钥匙。', '三', 'count'],
] as const)('does not derive current possession merely from numeral kind when the assertion is %s', async (assertion, text, _numberQuote, kind) => {
  const base = input(text);
  const correction = await reviewTopicSourceQuantities({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'total', numberIndexes: [0] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, assertion, kind, currentNumberIndexes: [0], reason: '数字语法不等于当前肯定持有关系。' }] }) });
  if (assertion === 'ambiguous') { expect(correction).toContain('unresolved_holding_relation'); expect(correction).not.toContain('mathematical_contradiction'); }
  else expect(correction).toBeUndefined();
});

it('requires the independent assertion axis instead of inferring current ownership from an affirmative numeric kind', async () => {
  const base = input('她现在携带三把钥匙。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0, kind: 'count', currentNumberIndexes: [0], reason: '遗漏肯定当前持有轴' }] }));
  await expect(reviewTopicSourceQuantities({ ...base, verifyRoles,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }) })).rejects.toThrow('未发布正文');
  expect(verifyRoles).toHaveBeenCalledTimes(3);
});

it('enumerates whole repeated numerals with exact UTF16 offsets and an independent ordinal marker', () => {
  const text = '😺第 2把，第二十一把；三把与三把，二〇二四，123，3.5，一万。';
  const spans = topicQuantityNumberCandidates(text);
  expect(spans.map(span => [span.numberQuote, span.value, span.ordinal])).toEqual([
    ['2', 2, true], ['二十一', 21, true], ['三', 3, false], ['三', 3, false], ['二〇二四', 2024, false],
    ['123', 123, false], ['3.5', null, false], ['一万', null, false],
  ]);
  expect(spans[0]!.start).toBe(4); expect(spans[3]!.occurrence).toBe(1);
  for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.numberQuote);
  expect(topicQuantityNumberCandidates('十二')).toHaveLength(1);
  expect(topicQuantityNumberCandidates('十二')[0]!.value).toBe(12);
  expect(topicQuantityNumberCandidates('十百')[0]!.value).toBeNull();
  expect(topicQuantityNumberCandidates('两三')[0]!.numberQuote).toBe('两三');
  expect(topicQuantityNumberCandidates('两三')[0]!.value).toBeNull();
  expect(topicQuantityNumberCandidates('二〇二六')[0]!.value).toBe(2026);
  for (const literal of ['3,000', '3e3', '3E+3']) {
    expect(topicQuantityNumberCandidates(literal)).toHaveLength(1);
    expect(topicQuantityNumberCandidates(literal)[0]!.numberQuote).toBe(literal);
    expect(topicQuantityNumberCandidates(literal)[0]!.value).toBeNull();
  }
});

it.each([{ numberIndexes: [99] }, { numberIndexes: [-1] }, { numberIndexes: [0, 0] }])('refuses nonexistent, negative or duplicate host numeric indexes without inventing a fallback: %j', async ({ numberIndexes }) => {
  const base = input('她携带三把钥匙。'), extractClaims = vi.fn(async () => ({ clauses: [{ clauseIndex: 0,
    quantities: [{ setIndex: 0, usage: 'total', numberIndexes }] }] }));
  await expect(reviewTopicSourceQuantities({ ...base, extractClaims })).rejects.toThrow('未发布正文');
  expect(extractClaims).toHaveBeenCalledTimes(3);
});

it('rejects an invented canon numeric index and an ordinal masquerading as a total within the original bounded slots', async () => {
  for (const totalNumberIndex of [99, 1]) {
    const extractSets = vi.fn(async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex, missingOrdinalNumberIndexes: [1] }] }));
    const extractClaims = vi.fn();
    await expect(reviewTopicSourceQuantities({ ...input('她带三把钥匙。'), extractSets, extractClaims })).rejects.toThrow('未发布正文');
    expect(extractSets).toHaveBeenCalledTimes(3); expect(extractClaims).not.toHaveBeenCalled();
  }
});

it('gives cold grammar every actual clause number even when warm selection omits the contradictory outer count', async () => {
  const base = input('她带三把钥匙（第1、3把在手，第2把未找到）。');
  const correction = await reviewTopicSourceQuantities({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_members', numberIndexes: [1, 2] }] }] }),
    verifyRoles: async context => {
      const candidate = JSON.parse(context.user).data.candidates[0];
      expect(candidate.numberCandidates.map((span: { numberQuote: string }) => span.numberQuote)).toEqual(['三', '1', '3', '2']);
      expect(context.user).not.toContain('availableUpperBound'); expect(context.user).not.toContain(canon.entries[0]!.quote);
      return { reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind: 'count', currentNumberIndexes: [0], reason: '外层三把实际肯定持有，不受括号遗漏影响。' }] };
    } });
  expect(correction).toContain('"availableUpperBound":2');
});

it.each(['两三', '一万', '3.5'])('abstains mathematically on an existing but uncomputable whole numeral %s without format retries', async numeral => {
  const base = input(`她当前带${numeral}把钥匙。`);
  const extractClaims = vi.fn(async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }));
  const verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind: 'count', currentNumberIndexes: [0], reason: '当前关系明确，但宿主完整数词尚不能可靠换算。' }] }));
  expect(await reviewTopicSourceQuantities({ ...base, extractClaims, verifyRoles })).toBeUndefined();
  expect(extractClaims).toHaveBeenCalledTimes(1); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('does not create a numerical source authority from a bound but uncomputable total', async () => {
  const base = input('她带三把钥匙。'), extractClaims = vi.fn();
  const extractSets = vi.fn(async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] }] }));
  expect(await reviewTopicSourceQuantities({ ...base, canon: { ...canon, entries: [{ ...canon.entries[0]!, quote: '共有一万把钥匙，第2把尚未找到。' }] },
    extractSets, extractClaims })).toBeUndefined();
  expect(extractSets).toHaveBeenCalledTimes(1); expect(extractClaims).not.toHaveBeenCalled();
});

it.each(['count', 'all'] as const)('does not let an unrelated null token waive a confirmed known %s contradiction', async kind => {
  const base = input(kind === 'count' ? '她当前带三把钥匙，旁边有两三枚石子。' : '她当前带齐全部钥匙，旁边有两三枚石子。');
  const correction = await reviewTopicSourceQuantities({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: kind === 'count' ? 'current_possessed_count' : 'current_possessed_all', numberIndexes: kind === 'count' ? [0] : [] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, assertion: 'scene_possession', kind, currentNumberIndexes: kind === 'count' ? [0] : [], reason: '明确的三把或全部持有，与旁边不确定石子数无关。' }] }) });
  expect(correction).toContain('宿主对已来源绑定');
});

it('keeps a count with no actual numeral invalid rather than silently accepting an empty count', async () => {
  const base = input('她当前携带钥匙。'), extractClaims = vi.fn(async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [] }] }] }));
  await expect(reviewTopicSourceQuantities({ ...base, extractClaims })).rejects.toThrow('未发布正文');
  expect(extractClaims).toHaveBeenCalledTimes(3);
});

it.each(['3,000', '3e3'])('does not mistake the parseable prefix of unsupported source token %s for its total', async numeral => {
  const base = input('她带三把钥匙。'), extractClaims = vi.fn();
  expect(await reviewTopicSourceQuantities({ ...base,
    canon: { ...canon, entries: [{ ...canon.entries[0]!, quote: `共有${numeral}把钥匙，第2把尚未找到。` }] }, extractClaims })).toBeUndefined();
  expect(extractClaims).not.toHaveBeenCalled();
});

it.each([['三', true], ['两', false]] as const)('gives independent cold grammar the actual target noun instead of another inventory: %s keys', async (quantity, rejected) => {
  const base = input(`她随身携带${quantity}把钥匙和两张卡。`);
  const correction = await reviewTopicSourceQuantities({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles: async context => {
      const candidate = JSON.parse(context.user).data.candidates[0];
      expect(candidate.actualEntityQuote).toBe('钥匙');
      expect(candidate.actualEntitySpans.map((span: { start: number; end: number }) => candidate.actualClause.slice(span.start, span.end))).toEqual(['钥匙']);
      expect(context.system).toContain('不能用同句其它物品的数量代答');
      expect(context.user).not.toContain(canon.entries[0]!.quote); expect(context.user).not.toContain('availableUpperBound');
      return { reviews: [{ candidateIndex: 0, numbers: [
        { numberIndex: 0, collection: 'same', voice: 'narrated_fact', time: 'scene', relation: 'affirmed_holding', kind: 'count', reason: '只核钥匙数量。' },
        { numberIndex: 1, collection: 'same', voice: 'unrelated', time: 'scene', relation: 'unrelated', kind: 'unrelated', reason: '卡片属于另一个本体。' },
      ], all: noAllPremise }] };
    } });
  expect(!!correction).toBe(rejected);
});

it('deduplicates the actual nqh outer-count and inner-member clause while auditing each fixed numeric index', async () => {
  const base = input('许岚带信与3把钥匙（第1把左袋，第3把与B-204纸条同放）到北门。');
  const correction = await actualQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [
      { setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }, { setIndex: 0, usage: 'current_possessed_members', numberIndexes: [1, 2] }] }] }),
    verifyRoles: async context => {
      const wire = JSON.parse(context.user), candidates = wire.data.candidates;
      expect(candidates).toHaveLength(1);
      expect(candidates[0].numberCandidates.map((span: { numberQuote: string }) => span.numberQuote)).toEqual(['3', '1', '3', '-204']);
      expect(context.user).not.toContain('current_possessed'); expect(context.user).not.toContain('availableUpperBound'); expect(context.user).not.toContain(canon.entries[0]!.quote);
      return { reviews: [{ candidateIndex: 0, numbers: [
        { numberIndex: 0, assertion: 'scene_possession', kind: 'count', reason: '这个3本身是外层实际带3把，不由括号序号抵消。' },
        { numberIndex: 1, assertion: 'scene_possession', kind: 'member', reason: '第1把左袋。' },
        { numberIndex: 2, assertion: 'scene_possession', kind: 'member', reason: '第3把同放。' },
        { numberIndex: 3, assertion: 'ambiguous', kind: 'unrelated', reason: 'B-204是门牌，不是钥匙数。' },
      ], allAssertion: 'not_scene_all', allReason: '不由成员列表自行推定带齐。' }] };
    } });
  expect(correction).toContain('"numberIndex":0'); expect(correction).toContain('"value":3');
});

it.each([{ indexes: [1] }, { indexes: [0, 0] }, { indexes: [0, 99] }])('refuses incomplete, duplicated or foreign per-number cold coverage: %j', async ({ indexes }) => {
  const base = input('她带三把钥匙和两张卡。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0,
    numbers: indexes.map(numberIndex => ({ numberIndex, assertion: 'ambiguous', kind: 'unrelated', reason: '故意不完整的数字审查。' })),
    allAssertion: 'not_scene_all', allReason: '不带齐。' }] }));
  await expect(actualQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles })).rejects.toThrow('未发布正文');
  expect(verifyRoles).toHaveBeenCalledTimes(3);
});

it.each([['她把钥匙全部带在身上。', 'scene_all', true], ['她计划日后带齐钥匙，当前尚未带齐。', 'not_scene_all', false]] as const)(
  'audits no-numeral all possession separately from member inference: %s', async (text, allAssertion, rejected) => {
    const base = input(text);
    const correction = await actualQuantityReview({ ...base,
      extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_all', numberIndexes: [] }] }] }),
      verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: [], allAssertion, allReason: '只审原句明确当前全部关系，未来和否定不能算当前。' }] }) });
    expect(!!correction).toBe(rejected);
  });

it('checks independent all possession even with an unrelated low numeral', async () => {
  const base = input('她在1号门把钥匙全部带齐。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0,
    numbers: [{ numberIndex: 0, assertion: 'ambiguous', kind: 'unrelated', reason: '门号1不是持有数量。' }],
    allAssertion: 'scene_all', allReason: '明确当前把目标钥匙全部带齐。' }] }));
  const correction = await actualQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_all', numberIndexes: [] }] }] }), verifyRoles });
  expect(correction).toContain('宿主对已来源绑定'); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('does not let per-number unknown or valid members cancel another known current count', async () => {
  const base = input('她带三把钥匙（第1和第3），另有两三枚石子。');
  const correction = await actualQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_members', numberIndexes: [1, 2] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: [
      { numberIndex: 0, assertion: 'scene_possession', kind: 'count', reason: '外层当前三把。' },
      { numberIndex: 1, assertion: 'scene_possession', kind: 'member', reason: '第一把。' },
      { numberIndex: 2, assertion: 'scene_possession', kind: 'member', reason: '第三把。' },
      { numberIndex: 3, assertion: 'scene_possession', kind: 'count', reason: '故意给未知项肯定关系，仍不得猜值或豁免另一数字。' },
    ], allAssertion: 'not_scene_all', allReason: '没有根据成员自行推all。' }] }) });
  expect(correction).toContain('"numberIndex":0'); expect(correction).toContain('"value":3');
});

it('defines scene possession as the narrated actor relation without requiring the narrator or an all claim', async () => {
  const base = input('已完成进展：许岚带三把钥匙到1号门。');
  const verifyRoles = vi.fn(async context => {
    expect(context.system).toContain('不要求旁白/作者本人持有');
    expect(context.system).toContain('基数持有不要求全部');
    expect(context.system).toContain('含本故事已完成进展的回顾');
    return { reviews: [{ candidateIndex: 0, numbers: [
      { numberIndex: 0, assertion: 'scene_possession', kind: 'count', reason: '被叙述的角色在该事件场景带三把。' },
      { numberIndex: 1, assertion: 'unrelated', kind: 'unrelated', reason: '门号不是钥匙数量。' },
    ], allAssertion: 'not_scene_all', allReason: '无需全部断言，外层基数关系独立成立。' }] };
  });
  const correction = await actualQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }), verifyRoles });
  expect(correction).toContain('"value":3'); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

const numericPremise = (voice = 'narrated_fact', relation = 'affirmed_holding', time = 'scene', kind = 'count', collection = 'same') => ({ collection, voice, relation, time, kind, reason: '本数字自己的独立语法前提。' });
const noAllPremise = { collection: 'same', voice: 'narrated_fact', relation: 'not_affirmed_all', time: 'scene', reason: '没有额外肯定all关系。' };
it.each([
  { text: '“看他拿什么来对暗号。”A17把手收回袖中，“三把钥匙。第一把在守夜的灯下，第三把得等。第二把我还没找到，你要是问出它的下落，先别去找。”', index: 1, rejected: false,
    numbers: [numericPremise('narrated_fact', 'unrelated', 'scene', 'unrelated'), numericPremise('attributed_claim', 'collection_size'),
      numericPremise('attributed_claim', 'affirmed_holding', 'scene', 'member'), numericPremise('attributed_claim', 'affirmed_holding', 'future', 'member'), numericPremise('attributed_claim', 'missing', 'scene', 'member')] },
  { text: '“三把钥匙，开什么？”', rejected: false, numbers: [numericPremise('question', 'collection_size')] },
  { text: '她带着“三把钥匙”。', rejected: true, numbers: [numericPremise()] },
  { text: '她说自己带着三把钥匙。', rejected: false, numbers: [numericPremise('attributed_claim')] },
  { text: '她带三把钥匙吗？', rejected: false, numbers: [numericPremise('question')] },
  { text: '如果她带三把钥匙，就改走另一条路。', rejected: false, numbers: [numericPremise('hypothetical'), numericPremise('hypothetical', 'unrelated', 'future', 'unrelated')] },
  { text: '她问“三把钥匙开什么”，随后带着三把钥匙离开。', rejected: true, numbers: [numericPremise('question', 'collection_size'), numericPremise()] },
  { text: '已完成进展：许岚带三把钥匙到门口。', rejected: true, numbers: [numericPremise()] },
  { text: '多年前，她曾经带三把钥匙。', rejected: false, numbers: [numericPremise('narrated_fact', 'affirmed_holding', 'earlier_history')] },
  { text: '她拥有三把钥匙。', usage: 'total' as const, rejected: false, numbers: [numericPremise('narrated_fact', 'collection_size')] },
  { text: '她带三把钥匙，男人说她把钥匙全带齐了。', rejected: true, numbers: [numericPremise()],
    all: { voice: 'attributed_claim', relation: 'affirmed_all', time: 'scene', reason: 'all是旁人声称，不能影响前面的旁白基数。' } },
  { text: '她说自己带三把钥匙，但她把钥匙全部带齐。', rejected: true, numbers: [numericPremise('attributed_claim')],
    all: { voice: 'narrated_fact', relation: 'affirmed_all', time: 'scene', reason: '后半旁白明确all，不继承前面数字声部。' } },
])('uses independent voice/relation/time for each actual numeric assertion: $text', async test => {
  const base = input(test.text), verifyRoles = vi.fn(async context => {
    const candidates = JSON.parse(context.user).data.candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].numberCandidates).toHaveLength(test.numbers.length);
    return { reviews: [{ candidateIndex: 0, numbers: test.numbers.map((number, numberIndex) => ({ numberIndex, ...number })), all: test.all ? { collection: 'same', ...test.all } : noAllPremise }] };
  });
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: [{ setIndex: 0, usage: test.usage ?? 'current_possessed_count', numberIndexes: [test.index ?? 0] }] })) }), verifyRoles });
  expect(!!correction).toBe(test.rejected); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each([['她说自己把钥匙带齐了。', 'attributed_claim', false], ['她把钥匙全部带齐。', 'narrated_fact', true]] as const)(
  'gives a numeral-free all claim its own voice and time: %s', async (text, voice, rejected) => {
    const base = input(text);
    const correction = await actualProductionQuantityReview({ ...base,
      extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_all', numberIndexes: [] }] }] }),
      verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: [], all: { collection: 'same', voice, relation: 'affirmed_all', time: 'scene', reason: 'all使用自身声部，不靠数字继承。' } }] }) });
    expect(!!correction).toBe(rejected);
  });

it('retains an unresolved same-index over-bound holding versus collection-size disagreement without claiming a mathematical proof', async () => {
  const base = input('许岚带信与3把钥匙（第1把左袋，第3把与B-204纸条同放）到北门。');
  const verifyRoles = vi.fn(async context => {
    expect(context.user).not.toContain('current_possessed_count'); expect(context.user).not.toContain('availableUpperBound');
    expect(context.user).not.toContain(canon.entries[0]!.quote);
    return { reviews: [{ candidateIndex: 0, numbers: [
      { numberIndex: 0, ...numericPremise('narrated_fact', 'collection_size') },
      { numberIndex: 1, ...numericPremise('narrated_fact', 'unrelated', 'scene', 'member') },
      { numberIndex: 2, ...numericPremise('narrated_fact', 'unrelated', 'scene', 'member') },
      { numberIndex: 3, ...numericPremise('narrated_fact', 'unrelated', 'scene', 'unrelated') },
    ], all: noAllPremise }] };
  });
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [
      { setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] },
      { setIndex: 0, usage: 'current_possessed_members', numberIndexes: [1, 2] },
    ] }] }), verifyRoles });
  expect(correction).toContain('"diagnosticType":"unresolved_holding_relation"');
  expect(correction).toContain('集合总量还是当场携带量'); expect(correction).toContain('原提案未正式发布');
  expect(correction).not.toContain('此数学矛盾'); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each([
  { text: '三把钥匙里她只有两把。', warmIndex: 1, usage: 'current_possessed_count', numbers: [numericPremise('narrated_fact', 'collection_size'), numericPremise()] },
  { text: '共有三把钥匙。', warmIndex: 0, usage: 'total', numbers: [numericPremise('narrated_fact', 'collection_size')] },
  { text: '她当前带两把钥匙。', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('narrated_fact', 'collection_size')] },
  { text: '她持有第3把钥匙。', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('narrated_fact', 'collection_size')] },
  { text: '她持有第1和第3把钥匙。', warmIndex: 1, usage: 'current_possessed_members', numbers: [numericPremise('narrated_fact', 'collection_size', 'scene', 'member'), numericPremise('narrated_fact', 'collection_size', 'scene', 'member')] },
  { text: '她把三把钥匙全部带齐。', warmIndex: 0, usage: 'current_possessed_all', numbers: [numericPremise('narrated_fact', 'collection_size')] },
  { text: '她说自己带三把钥匙。', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('attributed_claim', 'collection_size')] },
  { text: '她带三把钥匙吗？', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('question', 'collection_size')] },
  { text: '多年前她带三把钥匙。', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('narrated_fact', 'collection_size', 'earlier_history')] },
  { text: '将来她带三把钥匙。', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('narrated_fact', 'collection_size', 'future')] },
  { text: '她尚缺第3把钥匙。', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('narrated_fact', 'missing', 'scene', 'member')] },
  { text: '门号3，钥匙在桌上。', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('narrated_fact', 'unrelated', 'scene', 'unrelated')] },
  { text: '她带三把钥匙。', warmIndex: 0, usage: 'current_possessed_count', ambiguous: true, numbers: [numericPremise('narrated_fact', 'ambiguous')] },
  { text: '她带一万把钥匙。', warmIndex: 0, usage: 'current_possessed_count', numbers: [numericPremise('narrated_fact', 'collection_size')] },
])('does not broaden the unresolved count gate across another index, safe value, ordinal or cold premise: $text', async test => {
  const base = input(test.text), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0,
    numbers: test.numbers.map((number, numberIndex) => ({ numberIndex, ...number })), all: noAllPremise }] }));
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: test.usage,
      numberIndexes: [test.warmIndex] }] }] }), verifyRoles });
  if (test.ambiguous) { expect(correction).toContain('ambiguous_numeric_premise'); expect(correction).not.toContain('count_holding_vs_total'); }
  else expect(correction).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('reports an independently established mathematical contradiction separately from an unresolved relation', async () => {
  const base = input('她带三把钥匙。');
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0, ...numericPremise() }], all: noAllPremise }] }) });
  expect(correction).toContain('"diagnosticType":"mathematical_contradiction"'); expect(correction).toContain('此数学矛盾');
  expect(correction).not.toContain('unresolved_holding_relation');
});

it('accepts an explicitly unrelated identifier voice without discarding the independently verified quantity premise', async () => {
  const base = input('她带三把钥匙到B-204。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0, numbers: [
    { numberIndex: 0, ...numericPremise() },
    { numberIndex: 1, ...numericPremise('unrelated', 'unrelated', 'ambiguous', 'unrelated') },
  ], all: noAllPremise }] }));
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }), verifyRoles });
  expect(correction).toContain('"diagnosticType":"mathematical_contradiction"'); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each([
  { relation: 'affirmed_holding', kind: 'count' },
  { relation: 'unrelated', kind: 'count' },
  { relation: 'collection_size', kind: 'unrelated' },
  { relation: 'unrelated', kind: 'member' },
])('does not let an unrelated voice hide an actual numeric proposition: %j', async premise => {
  const base = input('她带三把钥匙。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0,
    numbers: [{ numberIndex: 0, ...numericPremise('unrelated', premise.relation, 'scene', premise.kind) }], all: noAllPremise }] }));
  await expect(actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles })).rejects.toThrow('未发布正文');
  expect(verifyRoles).toHaveBeenCalledTimes(3);
});

it('keeps an unrelated voice invalid for the independent whole-set assertion', async () => {
  const base = input('她把钥匙带齐。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0, numbers: [],
    all: { collection: 'same', voice: 'unrelated', relation: 'affirmed_all', time: 'scene', reason: '无关声部不能豁免all命题。' } }] }));
  await expect(actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_all', numberIndexes: [] }] }] }),
    verifyRoles })).rejects.toThrow('未发布正文');
  expect(verifyRoles).toHaveBeenCalledTimes(3);
});

it('provides the actual xezsdc neighboring clauses as context while only auditing the focus numeral', async () => {
  const base = input(originalParagraph), verifyRoles = vi.fn(async context => {
    const [candidate] = JSON.parse(context.user).data.candidates;
    expect(candidate.clauseIndex).toBe(1);
    expect(candidate.actualClause).toBe(base.clauses[1]!.text);
    expect(candidate.contextClauses).toEqual([0, 2].map(index => ({ ...base.clauses[index], relative: index === 0 ? 'before' : 'after' })));
    expect(candidate.contextClauses[1].text).toContain('第二把却始终没有找到');
    expect(candidate.numberCandidates.map((number: { numberQuote: string }) => number.numberQuote)).toEqual(['三']);
    for (const clause of candidate.contextClauses) expect([base.summary, base.stage].join('\n').slice(clause.start, clause.end)).toBe(clause.text);
    expect(context.system).toContain('认知或回忆动作发生的时间不等于所想到物品状态的时间');
    expect(context.user).not.toContain(canon.entries[0]!.quote); expect(context.user).not.toContain('availableUpperBound');
    expect(context.user).not.toContain('current_possessed_count');
    return { reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0, ...numericPremise() }], all: noAllPremise }] };
  });
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: clause.clauseIndex === 1 ? [{ setIndex: 0, usage: 'total', numberIndexes: [0] }] : [] })) }), verifyRoles });
  expect(correction).toContain('"diagnosticType":"mathematical_contradiction"'); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each([
  { text: '她想起口袋里的三把钥匙，冰冷的金属贴在大腿外侧。', time: 'scene', rejected: true },
  { text: '她想起昨夜曾将三把钥匙放进口袋。如今只剩两把钥匙贴在腿边。', time: 'earlier_history', rejected: false },
])('distinguishes the cognitive act from the actual referenced inventory time without forcing scene: $text', async test => {
  const base = input(test.text), verifyRoles = vi.fn(async context => {
    const candidates = JSON.parse(context.user).data.candidates, [candidate] = candidates;
    expect(candidate.contextClauses).toHaveLength(test.time === 'scene' ? 0 : 1);
    return { reviews: candidates.map((current: { clauseIndex: number }, candidateIndex: number) => ({ candidateIndex,
      numbers: [{ numberIndex: 0, ...numericPremise('narrated_fact', 'affirmed_holding', current.clauseIndex === 0 ? test.time : 'scene') }], all: noAllPremise })) };
  });
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] })) }), verifyRoles });
  expect(!!correction).toBe(test.rejected); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each([0, 2])('bounds source context to one real neighbor at the first or last focus clause %s', async index => {
  const base = input('三把钥匙是总集合。中间原句没有数量。三把钥匙仍是集合总数。');
  const verifyRoles = vi.fn(async context => {
    const candidates = JSON.parse(context.user).data.candidates, candidate = candidates.find((item: { clauseIndex: number }) => item.clauseIndex === index);
    expect(candidate.contextClauses).toEqual([{ ...base.clauses[1], relative: index === 0 ? 'after' : 'before' }]);
    return { reviews: candidates.map((_current: unknown, candidateIndex: number) => ({ candidateIndex,
      numbers: [{ numberIndex: 0, ...numericPremise('narrated_fact', 'collection_size') }], all: noAllPremise })) };
  });
  expect(await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: clause.text.includes('钥匙') ? [{ setIndex: 0, usage: 'total', numberIndexes: [0] }] : [] })) }), verifyRoles })).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('omits absent or unverified context offsets instead of certifying arbitrary metadata', async () => {
  const base = input('前句原文。她带两把钥匙。后句原文。'), verifyRoles = vi.fn(async context => {
    const [candidate] = JSON.parse(context.user).data.candidates;
    expect(candidate.contextClauses).toEqual([
      { clauseIndex: 0, relative: 'before', text: '前句原文。' }, { clauseIndex: 2, relative: 'after', text: '后句原文。' },
    ]);
    return { reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0, ...numericPremise() }], all: noAllPremise }] };
  });
  expect(await actualProductionQuantityReview({ ...base, clauses: base.clauses.map(clause => clause.clauseIndex === 0
    ? { ...clause, start: 99, end: 104 } : clause.clauseIndex === 2 ? { clauseIndex: clause.clauseIndex, text: clause.text } : clause),
    extractClaims: async () => ({ clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: clause.clauseIndex === 1 ? [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] : [] })) }), verifyRoles })).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('does not accept a neighboring numeral as an additional focus index within the original format slots', async () => {
  const base = input('附近有99张卡。她带两把钥匙。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0, numbers: [
    { numberIndex: 0, ...numericPremise() }, { numberIndex: 1, ...numericPremise('unrelated', 'unrelated', 'scene', 'unrelated') },
  ], all: noAllPremise }] }));
  await expect(actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: clause.clauseIndex === 1 ? [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] : [] })) }), verifyRoles })).rejects.toThrow('未发布正文');
  expect(verifyRoles).toHaveBeenCalledTimes(3);
});

it('independently audits an uncertain warm quantity instead of letting it bypass cold arithmetic', async () => {
  const base = input(originalParagraph), verifyRoles = vi.fn(async context => {
    expect(context.user).not.toContain('current_possessed_count'); expect(context.user).not.toContain('availableUpperBound');
    expect(context.user).not.toContain(canon.entries[0]!.quote);
    return { reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0, ...numericPremise() }], all: noAllPremise }] };
  });
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: base.clauses.map(clause => ({ clauseIndex: clause.clauseIndex,
      quantities: clause.clauseIndex === 1 ? [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [0] }] : [] })) }), verifyRoles });
  expect(correction).toContain('mathematical_contradiction'); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('lets cold identify another actual collection despite a shared noun and uncertain warm binding', async () => {
  const base = input('张明携带别组的三把备用钥匙，与本组无关。'), verifyRoles = vi.fn(async context => {
    expect(context.system).toContain('同名物品不证明同一集合');
    return { reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0, ...numericPremise('unrelated', 'unrelated', 'scene', 'unrelated') }], all: noAllPremise }] };
  });
  expect(await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [0] }] }] }),
    verifyRoles })).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each([
  { text: '她带三把钥匙。', premise: numericPremise('ambiguous'), pending: true },
  { text: '她带三把钥匙。', premise: numericPremise('narrated_fact', 'ambiguous'), pending: true },
  { text: '她带三把钥匙。', premise: numericPremise('narrated_fact', 'affirmed_holding', 'ambiguous'), pending: true },
  { text: '她带三把钥匙。', premise: numericPremise('narrated_fact', 'affirmed_holding', 'scene', 'ambiguous'), pending: true },
  { text: '她带一万把钥匙。', premise: numericPremise('ambiguous', 'ambiguous', 'ambiguous', 'ambiguous'), pending: false },
  { text: '她带第2把钥匙。', premise: numericPremise('ambiguous', 'ambiguous', 'scene', 'member'), pending: true },
  { text: '她带第3把钥匙。', premise: numericPremise('ambiguous', 'ambiguous', 'scene', 'member'), pending: false },
  { text: '她带第4把钥匙。', premise: numericPremise('ambiguous', 'ambiguous', 'scene', 'member'), pending: true },
  { text: '她带第3把钥匙。', premise: numericPremise('ambiguous', 'ambiguous', 'scene', 'ambiguous'), pending: false },
  { text: '她说自己带三把钥匙。', premise: numericPremise('attributed_claim', 'ambiguous'), pending: false },
  { text: '她带三把钥匙吗？', premise: numericPremise('question', 'ambiguous'), pending: false },
  { text: '如果她带三把钥匙。', premise: numericPremise('hypothetical', 'ambiguous'), pending: false },
  { text: '多年前她带三把钥匙。', premise: numericPremise('ambiguous', 'ambiguous', 'earlier_history'), pending: false },
  { text: '将来她带三把钥匙。', premise: numericPremise('ambiguous', 'ambiguous', 'future'), pending: false },
  { text: '这套总共三把钥匙。', premise: numericPremise('ambiguous', 'collection_size'), pending: false },
  { text: '她缺三把钥匙。', premise: numericPremise('ambiguous', 'missing'), pending: false },
  { text: '别组携带三把钥匙。', premise: numericPremise('ambiguous', 'unrelated', 'scene', 'unrelated'), pending: false },
])('reports an uncertain mathematical-risk premise without condemning explicit non-risk semantics: $text $premise', async test => {
  const base = input(test.text), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0,
    numbers: [{ numberIndex: 0, ...test.premise }], all: noAllPremise }] }));
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [0] }] }] }), verifyRoles });
  if (test.pending) { expect(correction).toContain('ambiguous_numeric_premise'); expect(correction).not.toContain('mathematical_contradiction'); }
  else expect(correction).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('requires independent semantic pending for a low cardinality that could denote the explicitly missing member', async () => {
  const correction = await actualProductionQuantityReview({ ...input('她带两把钥匙。'),
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [0] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0,
      ...numericPremise('ambiguous', 'ambiguous', 'ambiguous', 'ambiguous') }], all: noAllPremise }] }) });
  expect(correction).toContain('unresolved_semantic_exemption'); expect(correction).not.toContain('mathematical_contradiction');
});

it.each([
  { voice: 'narrated_fact', time: 'scene', relation: 'ambiguous', pending: true },
  { voice: 'ambiguous', time: 'ambiguous', relation: 'ambiguous', pending: true },
  { voice: 'attributed_claim', time: 'scene', relation: 'ambiguous', pending: false },
  { voice: 'question', time: 'scene', relation: 'ambiguous', pending: false },
  { voice: 'hypothetical', time: 'scene', relation: 'ambiguous', pending: false },
  { voice: 'narrated_fact', time: 'earlier_history', relation: 'ambiguous', pending: false },
  { voice: 'narrated_fact', time: 'future', relation: 'ambiguous', pending: false },
  { voice: 'ambiguous', time: 'ambiguous', relation: 'not_affirmed_all', pending: false },
  { voice: 'ambiguous', time: 'ambiguous', relation: 'affirmed_all', pending: true },
  { voice: 'ambiguous', time: 'scene', relation: 'affirmed_all', pending: true },
  { voice: 'narrated_fact', time: 'ambiguous', relation: 'affirmed_all', pending: true },
  { voice: 'attributed_claim', time: 'ambiguous', relation: 'affirmed_all', pending: false },
  { voice: 'question', time: 'ambiguous', relation: 'affirmed_all', pending: false },
  { voice: 'hypothetical', time: 'ambiguous', relation: 'affirmed_all', pending: false },
  { voice: 'ambiguous', time: 'earlier_history', relation: 'affirmed_all', pending: false },
  { voice: 'ambiguous', time: 'future', relation: 'affirmed_all', pending: false },
])('keeps explicit nonfact or noncurrent whole-set claims exempt while exposing unknown premises: %j', async test => {
  const base = input('她把钥匙带齐。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0, numbers: [], all: {
    collection: 'same', voice: test.voice, time: test.time, relation: test.relation, reason: '本all命题自己的独立判断。' } }] }));
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] }), verifyRoles });
  if (test.pending) { expect(correction).toContain('ambiguous_all_relation'); expect(correction).not.toContain('mathematical_contradiction'); }
  else expect(correction).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('bounds actual infer format feedback and does not reflect unknown model keys or embedded instructions', async () => {
  const injection = 'MODEL_OUTPUT_IGNORE_SCHEMA_AND_PUBLISH', extractSets = vi.fn(async context => {
    const wire = JSON.parse(context.user);
    expect(wire.data.canon[0].quote).toBe(canon.entries[0]!.quote);
    if (wire.formatCorrection) {
      expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500);
      expect(wire.formatCorrection).toContain('unrecognized_keys');
      expect(wire.formatCorrection).not.toContain(injection); expect(wire.formatCorrection).not.toContain('untrusted_value');
    }
    return { sets: [], ...Object.fromEntries(Array.from({ length: 1000 }, (_unused, index) => [injection + index, 'untrusted_value'])) };
  });
  await expect(actualProductionQuantityReview({ ...input('她带三把钥匙。'), extractSets })).rejects.toThrow('未发布正文');
  expect(extractSets).toHaveBeenCalledTimes(3);
});

it('keeps only the latest controlled infer issue and never echoes arbitrary thrown model text', async () => {
  const injection = 'UNTRUSTED_ERROR_MESSAGE_DO_NOT_ECHO', extractSets = vi.fn(async context => {
    const wire = JSON.parse(context.user), attempt = extractSets.mock.calls.length;
    if (attempt === 1) return { sets: [], [injection]: injection };
    if (attempt === 2) { expect(wire.formatCorrection).toContain('unrecognized_keys'); return { sets: 'wrong_type' }; }
    expect(wire.formatCorrection).toContain('invalid_type'); expect(wire.formatCorrection).not.toContain('unrecognized_keys');
    expect(wire.formatCorrection).not.toContain(injection); throw new Error(injection.repeat(1000));
  });
  await expect(actualProductionQuantityReview({ ...input('她带三把钥匙。'), extractSets })).rejects.toThrow('未发布正文');
  expect(extractSets).toHaveBeenCalledTimes(3);
  const arbitraryError = vi.fn(async context => {
    const wire = JSON.parse(context.user);
    if (wire.formatCorrection) { expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500); expect(wire.formatCorrection).not.toContain(injection); }
    throw new Error(injection.repeat(1000));
  });
  await expect(actualProductionQuantityReview({ ...input('她带三把钥匙。'), extractSets: arbitraryError })).rejects.toThrow('未发布正文');
  expect(arbitraryError).toHaveBeenCalledTimes(3);
});

it('requires every host literal target even when warm tries to return empty quantities', async () => {
  const base = input('她带三把钥匙。'), extractClaims = vi.fn(async () => ({ clauses: [{ clauseIndex: 0, quantities: [] }] })), verifyRoles = vi.fn();
  await expect(actualProductionQuantityReview({ ...base, extractClaims, verifyRoles })).rejects.toThrow('未发布正文');
  expect(extractClaims).toHaveBeenCalledTimes(3); expect(verifyRoles).not.toHaveBeenCalled();
});

it('does not require empty coverage rows when no actual clause contains a source collection noun', async () => {
  const extractClaims = vi.fn(), verifyRoles = vi.fn();
  expect(await actualProductionQuantityReview({ ...input('天暗了。门开了。'), extractClaims, verifyRoles })).toBeUndefined();
  expect(extractClaims).not.toHaveBeenCalled(); expect(verifyRoles).not.toHaveBeenCalled();
});

it.each([false, true])('accepts complete sparse literal-pair coverage with optional actual nonrequired rows: %s', async includeEmptyRow => {
  const base = input('天暗了。她带两把钥匙。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0,
    numbers: [{ numberIndex: 0, ...numericPremise() }], all: noAllPremise }] }));
  expect(await actualProductionQuantityReview({ ...base,
    extractClaims: async context => {
      const data = JSON.parse(context.user).data;
      expect(data.requiredPairs).toEqual([{ clauseIndex: 1, setIndex: 0 }]); expect(data.requiredClauseIndexes).toEqual([1]);
      return { clauses: [...includeEmptyRow ? [{ clauseIndex: 0, quantities: [] }] : [],
        { clauseIndex: 1, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] };
    }, verifyRoles })).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each(['wrong_set', 'foreign_clause', 'duplicate_clause'] as const)('does not let malformed literal coverage skip the actual target: %s', async mode => {
  const base = input('她带两把钥匙。'), verifyRoles = vi.fn(), extractClaims = vi.fn(async () => ({ clauses: mode === 'foreign_clause'
    ? [{ clauseIndex: 99, quantities: [] }] : mode === 'duplicate_clause'
      ? [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }, { clauseIndex: 0, quantities: [] }]
      : [{ clauseIndex: 0, quantities: [{ setIndex: 1, usage: 'ambiguous', numberIndexes: [] }] }] }));
  await expect(actualProductionQuantityReview({ ...base, extractClaims, verifyRoles })).rejects.toThrow('未发布正文');
  expect(extractClaims).toHaveBeenCalledTimes(3); expect(verifyRoles).not.toHaveBeenCalled();
});

it.each([true, false])('independently checks an uncertain literal-noun target with no numerals for an actual all claim: %s', async all => {
  const base = input('钥匙在这里。'), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0, numbers: [], all: {
    ...noAllPremise, relation: all ? 'affirmed_all' : 'not_affirmed_all' } }] }));
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] }), verifyRoles });
  if (all) expect(correction).toContain('mathematical_contradiction'); else expect(correction).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each([12, 80])('can represent every actual source collection in one clause beyond the old ten-quantity bound: %s', async count => {
  const nouns = Array.from({ length: count }, (_unused, index) => '物件' + String.fromCharCode(65 + Math.floor(index / 26)) + String.fromCharCode(65 + index % 26));
  const base = input('这里只提到' + nouns.join('、') + '。'), extractClaims = vi.fn(async context => {
    const data = JSON.parse(context.user).data;
    expect(data.requiredPairs).toEqual(nouns.map((_noun, setIndex) => ({ clauseIndex: 0, setIndex })));
    return { clauses: [{ clauseIndex: 0, quantities: nouns.map((_noun, setIndex) => ({ setIndex, usage: 'ambiguous', numberIndexes: [] })) }] };
  }), verifyRoles = vi.fn(async context => {
    const candidates = JSON.parse(context.user).data.candidates;
    expect(candidates).toHaveLength(count);
    return { reviews: candidates.map((_candidate: unknown, candidateIndex: number) => ({ candidateIndex, numbers: [], all: noAllPremise })) };
  });
  expect(await actualProductionQuantityReview({ ...base, canon: { version: 1, throughSequence: 1, entries: nouns.map((noun, index) => ({
    id: 'set-' + index, sourceMessageId: 'source-' + index, sourceChecksum: 'c'.repeat(64), quote: `这组${noun}共有3件，第2件尚未取得。`, rule: '非来源解释' })) },
    extractSets: async () => ({ sets: nouns.map((entityQuote, canonIndex) => ({ canonIndex, entityQuote, totalNumberIndex: 0, missingOrdinalNumberIndexes: [1] })) }),
    extractClaims, verifyRoles })).toBeUndefined();
  expect(extractClaims).toHaveBeenCalledTimes(1); expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('rejects role output beyond its unchanged thousand-review capacity within the original three slots', async () => {
  const base = input('她带两把钥匙。'), verifyRoles = vi.fn(async () => ({ reviews: Array.from({ length: 1001 }, () => ({
    candidateIndex: 0, numbers: [{ numberIndex: 0, ...numericPremise() }], all: noAllPremise })) }));
  await expect(actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] }),
    verifyRoles })).rejects.toThrow('未发布正文');
  expect(verifyRoles).toHaveBeenCalledTimes(3);
});

it.each(['different', 'same', 'ambiguous'] as const)('keeps collection binding per numeral for a same-clause source count and another inventory: %s', async collection => {
  const base = input('本组带两把钥匙，张明带别组的三把钥匙。');
  const correction = await actualProductionQuantityReview({ ...base,
    verifyDisjointWaivers: declaredDisjointQuantityFixture,
    canon: { ...canon, entries: [{ ...canon.entries[0]!, quote: '本组共有3把钥匙，第2把尚未找到。' }] },
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [1] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: [
      { numberIndex: 0, ...numericPremise() }, { numberIndex: 1, ...numericPremise('narrated_fact', 'affirmed_holding', 'scene', 'count', collection) },
    ], all: noAllPremise }] }) });
  if (collection === 'same') expect(correction).toContain('mathematical_contradiction');
  else if (collection === 'ambiguous') { expect(correction).toContain('unresolved_holding_relation'); expect(correction).not.toContain('mathematical_contradiction'); }
  else expect(correction).toBeUndefined();
});

it.each([
  { text: '张明带别组的三把钥匙。', relation: 'affirmed_holding', kind: 'count' },
  { text: '张明带别组的三把钥匙。', relation: 'collection_size', kind: 'count' },
  { text: '张明带别组的第2把钥匙。', relation: 'affirmed_holding', kind: 'member' },
])('never applies a source bound or warm disagreement to a clearly different collection: $text $relation', async test => {
  const correction = await actualProductionQuantityReview({ ...input(test.text),
    verifyDisjointWaivers: declaredDisjointQuantityFixture,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0,
      numbers: [{ numberIndex: 0, ...numericPremise('narrated_fact', test.relation, 'scene', test.kind, 'different') }],
      all: { ...noAllPremise, collection: 'different', relation: 'affirmed_all' } }] }) });
  expect(correction).toBeUndefined();
});

it.each([
  { text: '她想起口袋里的三把钥匙，金属贴在腿边。', voice: 'narrated_fact', time: 'scene', result: 'pending' },
  { text: '她以为口袋里有三把钥匙。', voice: 'attributed_claim', time: 'scene', result: 'allowed' },
  { text: '她想起男人声称她带三把钥匙。', voice: 'attributed_claim', time: 'scene', result: 'allowed' },
  { text: '她想起昨夜口袋里的三把钥匙。', voice: 'narrated_fact', time: 'earlier_history', result: 'allowed' },
])('preserves the independently supplied factual, attributed and earlier-history premises without forcing collection identity: $text', async test => {
  const base = input(test.text), verifyRoles = vi.fn(async () => ({ reviews: [{ candidateIndex: 0,
    numbers: [{ numberIndex: 0, ...numericPremise(test.voice, 'affirmed_holding', test.time, 'count', 'ambiguous') }],
    all: { ...noAllPremise, collection: 'ambiguous' } }] }));
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'current_possessed_count', numberIndexes: [0] }] }] }),
    verifyRoles });
  expect(verifyRoles).toHaveBeenCalledTimes(1);
  if (test.result === 'pending') {
    expect(correction).toContain('unresolved_holding_relation');
    expect(correction).not.toContain('mathematical_contradiction');
  } else expect(correction).toBeUndefined();
});

it('does not certify source collection identity from a noun-only reference', async () => {
  const base = input('她携带三把钥匙。'), verifyRoles = vi.fn(async context => {
    const [candidate] = JSON.parse(context.user).data.candidates;
    expect(candidate.sourceIdentityReference.text).toBe('共有〔数值已遮蔽〕把钥匙，第〔数值已遮蔽〕把仍未找到，不能自行找回。');
    expect(context.system).toContain('没有明确主体/本组等身份指代锚时');
    return { reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0,
      ...numericPremise('narrated_fact', 'affirmed_holding', 'scene', 'count', 'ambiguous') }], all: noAllPremise }] };
  });
  const correction = await actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] }), verifyRoles });
  expect(correction).toContain('unresolved_holding_relation'); expect(correction).not.toContain('mathematical_contradiction');
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it.each([
  { collection: 'same', voice: 'narrated_fact', time: 'scene', relation: 'affirmed_all', result: 'math' },
  { collection: 'different', voice: 'narrated_fact', time: 'scene', relation: 'affirmed_all', result: 'allowed' },
  { collection: 'different', voice: 'ambiguous', time: 'ambiguous', relation: 'ambiguous', result: 'allowed' },
  { collection: 'ambiguous', voice: 'narrated_fact', time: 'scene', relation: 'affirmed_all', result: 'pending' },
  { collection: 'ambiguous', voice: 'narrated_fact', time: 'scene', relation: 'not_affirmed_all', result: 'allowed' },
  { collection: 'ambiguous', voice: 'attributed_claim', time: 'scene', relation: 'affirmed_all', result: 'allowed' },
  { collection: 'ambiguous', voice: 'question', time: 'scene', relation: 'affirmed_all', result: 'allowed' },
  { collection: 'ambiguous', voice: 'hypothetical', time: 'scene', relation: 'affirmed_all', result: 'allowed' },
  { collection: 'ambiguous', voice: 'narrated_fact', time: 'earlier_history', relation: 'affirmed_all', result: 'allowed' },
  { collection: 'ambiguous', voice: 'narrated_fact', time: 'future', relation: 'affirmed_all', result: 'allowed' },
])('uses the all assertion own collection binding without borrowing a numeric or different-group conclusion: %j', async test => {
  const correction = await actualProductionQuantityReview({ ...input('他把钥匙带齐。'),
    verifyDisjointWaivers: declaredDisjointQuantityFixture,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] }),
    verifyRoles: async () => ({ reviews: [{ candidateIndex: 0, numbers: [], all: { collection: test.collection, voice: test.voice,
      time: test.time, relation: test.relation, reason: '独立all集合身份，不借其它数字的结论。' } }] }) });
  if (test.result === 'math') expect(correction).toContain('mathematical_contradiction');
  else if (test.result === 'pending') { expect(correction).toContain('unresolved_holding_relation'); expect(correction).not.toContain('mathematical_contradiction'); }
  else expect(correction).toBeUndefined();
});

it.each(['number_missing', 'all_missing', 'number_invalid'] as const)('strictly rejects missing or invented collection fields through controlled bounded feedback: %s', async mode => {
  const invalid = 'UNTRUSTED_BINDING_AUTHORITY_VALUE', base = input(mode === 'all_missing' ? '本组把钥匙带齐。' : '本组带三把钥匙。');
  const verifyRoles = vi.fn(async context => {
    const wire = JSON.parse(context.user);
    if (wire.formatCorrection) {
      expect(wire.formatCorrection).toContain('collection'); expect(wire.formatCorrection.length).toBeLessThanOrEqual(1500);
      expect(wire.formatCorrection).not.toContain(invalid);
    }
    return { reviews: [{ candidateIndex: 0, numbers: mode === 'all_missing' ? [] : [{ numberIndex: 0,
      ...(mode === 'number_invalid' ? { collection: invalid } : {}), voice: 'narrated_fact', time: 'scene', relation: 'affirmed_holding', kind: 'count', reason: '不得补成same。' }],
    all: mode === 'all_missing' ? { voice: 'narrated_fact', time: 'scene', relation: 'affirmed_all', reason: '不得补成same。' } : noAllPremise }] };
  });
  await expect(actualProductionQuantityReview({ ...base,
    extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] }),
    verifyRoles })).rejects.toThrow('未发布正文');
  expect(verifyRoles).toHaveBeenCalledTimes(3);
});

it('builds source identity only from exact source bytes with detectable number forms masked while focus and neighbors remain original', async () => {
  const quote = '😺本组卡A17共有5张，第4张尚未取得，另记Ⅲ、③、叁和3,000、3e3、两三。';
  const base = input('箱号B204在门边。现在本组带两张卡。门号A17仍在旁边。'), marker = '〔数值已遮蔽〕';
  const verifyRoles = vi.fn(async context => {
    const [candidate] = JSON.parse(context.user).data.candidates;
    expect(candidate.sourceIdentityReference).toEqual({ text: `😺本组卡A${marker}共有${marker}张，第${marker}张尚未取得，另记${marker}、${marker}、${marker}和${marker}、${marker}、${marker}。`,
      sourceQuoteChecksum: createHash('sha256').update(quote).digest('hex') });
    expect(candidate.numberCandidates.map((span: { numberQuote: string; value: number }) => [span.numberQuote, span.value])).toEqual([['两', 2]]);
    expect(candidate.contextClauses.map((clause: { text: string }) => clause.text)).toEqual(['箱号B204在门边。', '门号A17仍在旁边。']);
    expect(candidate.total).toBeUndefined(); expect(candidate.missingOrdinals).toBeUndefined(); expect(candidate.warmCountNumberIndexes).toBeUndefined();
    return { reviews: [{ candidateIndex: 0, numbers: [{ numberIndex: 0, ...numericPremise() }], all: noAllPremise }] };
  });
  expect(await actualProductionQuantityReview({ ...base, canon: { version: 1, throughSequence: 1, entries: [{
    ...canon.entries[0]!, quote }] }, extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '卡', totalNumberIndex: 1, missingOrdinalNumberIndexes: [2] }] }),
    extractClaims: async () => ({ clauses: [{ clauseIndex: 1, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] }), verifyRoles })).toBeUndefined();
  expect(verifyRoles).toHaveBeenCalledTimes(1);
});

it('does not infer identical collection authority from colliding masked numeric identities', async () => {
  const references: Array<{ text: string; sourceQuoteChecksum: string }> = [];
  for (const id of ['A17', 'A18']) {
    const quote = `${id}的这组共有3把钥匙，第2把尚未找到。`, base = input('A18携带三把钥匙。');
    const correction = await actualProductionQuantityReview({ ...base, canon: { version: 1, throughSequence: 1, entries: [{ ...canon.entries[0]!, quote }] },
      extractSets: async () => ({ sets: [{ canonIndex: 0, entityQuote: '钥匙', totalNumberIndex: 1, missingOrdinalNumberIndexes: [2] }] }),
      extractClaims: async () => ({ clauses: [{ clauseIndex: 0, quantities: [{ setIndex: 0, usage: 'ambiguous', numberIndexes: [] }] }] }),
      verifyRoles: async context => {
        const [candidate] = JSON.parse(context.user).data.candidates;
        references.push(candidate.sourceIdentityReference); expect(context.system).toContain('标识不能因同形就推定同人或同组');
        return { reviews: [{ candidateIndex: 0, numbers: [
          { numberIndex: 0, ...numericPremise('unrelated', 'unrelated', 'scene', 'unrelated', 'ambiguous') },
          { numberIndex: 1, ...numericPremise('narrated_fact', 'affirmed_holding', 'scene', 'count', 'ambiguous') },
        ], all: noAllPremise }] };
      } });
    expect(correction).toContain('unresolved_holding_relation'); expect(correction).not.toContain('mathematical_contradiction');
  }
  expect(references[0]!.text).toBe(references[1]!.text); expect(references[0]!.sourceQuoteChecksum).not.toBe(references[1]!.sourceQuoteChecksum);
});
