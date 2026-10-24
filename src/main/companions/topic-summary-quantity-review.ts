import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CompanionModelError, generateCompanionStructured, type CompanionModelConfig } from './model';
import type { TopicUserCanon } from './topic-user-canon';
import { admitQuantitySourcePremises, buildQuantitySourcePremiseCandidates, quantitySourcePremiseInput,
  quantitySourcePremiseProtocol, quantitySourcePremiseSchema, quantitySourcePremiseSystem, validateQuantitySourcePremises,
  type QuantitySourcePremiseReview, type VerifiedQuantitySourceSet } from './topic-source-quantity-premise';
import { quantityDisjointChecks, quantityDisjointInput, quantityDisjointWaiverSchema, quantityDisjointWaiverSystem, quantityDisjointCapacity,
  validateQuantityDisjointWaivers, admitQuantityDisjointWaivers } from './topic-quantity-disjoint-waiver';

type Infer = (context: { system: string; user: string }, signal?: AbortSignal) => Promise<unknown>;
const numberIndex = z.number().int().nonnegative();
const setSchema = z.strictObject({ canonIndex: z.number().int().nonnegative(), entityQuote: z.string().min(1).max(80), totalNumberIndex: numberIndex,
  missingOrdinalNumberIndexes: z.array(numberIndex).min(1).max(100) });
const setsSchema = z.strictObject({ sets: z.array(setSchema).max(80) });
const claimsSchema = z.strictObject({ clauses: z.array(z.strictObject({ clauseIndex: z.number().int().nonnegative(), quantities: z.array(z.object({
  setIndex: z.number().int().nonnegative(),
  usage: z.enum(['current_possessed_count', 'current_possessed_all', 'current_possessed_members', 'missing', 'total', 'planned', 'historical', 'attributed', 'ambiguous']),
  numberIndexes: z.array(numberIndex).max(100) })).max(80) })).max(1000) });
const voiceSchema = z.enum(['narrated_fact', 'attributed_claim', 'question', 'hypothetical', 'ambiguous']);
const numberVoiceSchema = z.enum([...voiceSchema.options, 'unrelated']);
const timeSchema = z.enum(['scene', 'earlier_history', 'future', 'ambiguous']);
const collectionSchema = z.enum(['same', 'different', 'ambiguous']);
const rolesSchema = z.strictObject({ reviews: z.array(z.strictObject({ candidateIndex: z.number().int().nonnegative(),
  numbers: z.array(z.strictObject({ numberIndex, collection: collectionSchema, voice: numberVoiceSchema, time: timeSchema,
    relation: z.enum(['affirmed_holding', 'collection_size', 'missing', 'unrelated', 'ambiguous']),
    kind: z.enum(['count', 'member', 'unrelated', 'ambiguous']), reason: z.string().min(1).max(1000) })).max(1000),
  all: z.strictObject({ collection: collectionSchema, voice: voiceSchema, time: timeSchema,
    relation: z.enum(['affirmed_all', 'not_affirmed_all', 'ambiguous']), reason: z.string().min(1).max(1000) }) })).max(1000) });
type QuantitySet = VerifiedQuantitySourceSet;
const cache = new Map<string, { sets: QuantitySet[]; receipt: QuantitySourcePremiseReview }>();
const formatPathKeys = new Set(['sets', 'canonIndex', 'entityQuote', 'totalNumberIndex', 'missingOrdinalNumberIndexes', 'clauses', 'clauseIndex',
  'quantities', 'setIndex', 'usage', 'numberIndexes', 'reviews', 'candidateIndex', 'numbers', 'numberIndex', 'collection', 'voice', 'time', 'relation', 'kind', 'reason', 'all',
  'totalBinding', 'totalEvidenceClauseIndex', 'members', 'ordinalNumberIndex', 'evidenceClauseIndexes', 'predicateTarget', 'memberAvailability', 'applicability',
  'checkIndex', 'verdict', 'basis', 'evidenceRefs', 'view']);
const hostFormatMessages = new Set([
  '数字索引必须对应本原句宿主枚举的完整可计算整数；不得自造引文、截取部分数字或猜不支持的数值。',
  'entityQuote须仅含原句逐字物品本体名词，不含数字或整句。', '来源数字索引必须存在且明确缺失成员不能重复。',
  '总数须是实际基数，明确缺失序号必须是有效且不重复的实际成员。', 'clauses必须完整唯一覆盖实际clauseIndex。',
  'clauses须唯一引用实际clauseIndex，且不得出现伪造或重复行。',
  '必须完整覆盖每个requiredPair的真实clauseIndex和setIndex；没有明确数量命题可返回ambiguous和空numberIndexes，不能省略目标。',
  'setIndex必须是实际来源绑定集合。', 'numberIndexes必须唯一且仅选本actualClause宿主枚举的数字索引。', '实际持有数量/成员的数字索引不完整。',
  'reviews必须完整唯一覆盖实际candidateIndex。', 'numbers必须完整唯一覆盖本候选所有宿主numberIndex，不能漏外层数字、重复或用另一数字代答。',
  '无关数字voice=unrelated仅能与relation=unrelated且kind=unrelated同时使用，不能覆盖实际数量或成员命题。',
  'count必须对应正在被问的实际基数，不能把第N成员序号当数量；请核本数字为member或ambiguous，不能改选其它索引。',
  'source premise须绑定实际来源与数字所在原句。', 'source premise必须完整唯一覆盖每个实际setIndex。',
  'source premise证据必须选实际宿主原句，且包含所指数字。', 'source premise必须完整唯一覆盖每个候选member数字。',
  '数量语义豁免须完整唯一覆盖实际checkIndex。', '数量语义豁免证据须引用本目标实际有界原句。',
  '数量语义豁免目标须绑定实际焦点数词位置。',
]);
function quantityFormatFeedback(error: unknown) {
  if (error instanceof z.ZodError) return ('响应结构不符outputSchema：' + error.issues.slice(0, 12).map(issue => {
    const code = /^[a-z_]+$/u.test(issue.code) ? issue.code : 'invalid_structure';
    const path = issue.path.slice(0, 8).map(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0
      ? String(part) : typeof part === 'string' && formatPathKeys.has(part) ? part : '?').join('.');
    return code + '@' + (path || '$');
  }).join('；') + '。请按schema提交完整对象，不要加入额外键或省略实际索引。').slice(0, 1500);
  return error instanceof Error && hostFormatMessages.has(error.message) ? error.message
    : '响应未通过outputSchema或宿主来源索引校验，请重新提交完整合法对象。';
}
const literalNumber = (quote: string) => {
  if (/^\d+$/u.test(quote)) return Number(quote);
  if (!/^[零〇一二两三四五六七八九十百千]+$/u.test(quote)) return NaN;
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百千]/u.test(quote)) {
    // A zero-separated digit spelling can express a year/identifier. Adjacent
    // nonzero Chinese digits such as 两三 can be an approximation, not 23.
    if (quote.length > 1 && !/[零〇]/u.test(quote) || quote.length > 1 && quote.includes('两')) return NaN;
    return Number([...quote].map(character => digits[character]).join(''));
  }
  let total = 0, pending = 0, previousUnit = Infinity, hasPending = false;
  for (const character of quote) {
    const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[character];
    if (unit) {
      if (unit >= previousUnit || hasPending && !pending) return NaN;
      total += (hasPending ? pending : 1) * unit; pending = 0; hasPending = false; previousUnit = unit;
    } else {
      if (hasPending && pending !== 0) return NaN;
      pending = digits[character] ?? NaN; hasPending = true;
    }
  }
  return total + pending;
};
export interface TopicQuantityNumberCandidate { numberIndex: number; numberQuote: string; start: number; end: number;
  occurrence: number; value: number | null; ordinal: boolean }
/** Offsets are UTF-16 JavaScript indexes into this exact string. Enumeration
 * certifies literal numerals only, never their owner, collection or modality. */
export function topicQuantityNumberCandidates(text: string): TopicQuantityNumberCandidate[] {
  const result: TopicQuantityNumberCandidate[] = [], occurrences = new Map<string, number>();
  for (const match of text.matchAll(/[-−负]?(?:\d+(?:,\d{3})+|[\d零〇一二两三四五六七八九十百千万亿兆]+)(?:[.．点][\d零〇一二两三四五六七八九十百千万亿兆]+)*(?:[eE][+−-]?\d+)?/gu)) {
    const numberQuote = match[0], start = match.index, value = literalNumber(numberQuote), occurrence = occurrences.get(numberQuote) ?? 0;
    occurrences.set(numberQuote, occurrence + 1);
    result.push({ numberIndex: result.length, numberQuote, start, end: start + numberQuote.length, occurrence,
      value: Number.isSafeInteger(value) && value >= 0 ? value : null, ordinal: /第\s*$/u.test(text.slice(0, start)) });
  }
  return result;
}
/** Identity context preserves original nonnumeric text, never an invented owner
 * description. Masking detectable number forms is not a proof that all language
 * can express no numeric meaning, and can erase meaningful identity distinctions. */
function quantityIdentityReference(quote: string) {
  const marker = '〔数值已遮蔽〕';
  let cursor = 0, text = '';
  for (const span of topicQuantityNumberCandidates(quote)) {
    text += quote.slice(cursor, span.start) + marker; cursor = span.end;
  }
  text += quote.slice(cursor);
  return { text: text.replace(/[\p{N}零壹贰貳弍叁叄參肆伍陆陸柒捌玖拾佰仟萬億兆廿卅卌]+/gu, marker),
    sourceQuoteChecksum: createHash('sha256').update(quote).digest('hex') };
}
function boundNumber(candidates: readonly TopicQuantityNumberCandidate[], index: number) {
  const candidate = candidates[index];
  if (!candidate || candidate.value === null) throw new Error('数字索引必须对应本原句宿主枚举的完整可计算整数；不得自造引文、截取部分数字或猜不支持的数值。');
  return candidate.value;
}
export interface TopicSourceQuantityReviewOptions { canon: TopicUserCanon; clauses: readonly { clauseIndex: number; text: string; start?: number; end?: number }[]; summary: string; stage: string;
  config: CompanionModelConfig; signal?: AbortSignal; fetchFn?: typeof fetch; extractSets?: Infer; verifySourcePremises?: Infer; extractClaims?: Infer; verifyRoles?: Infer; verifyDisjointWaivers?: Infer;
  scope?: { ownerId: string; conversationId: string; topicId: string }; kind?: 'summary' | 'reply' }

/** Semantic extraction identifies one actual collection and sentence modality.
 * Only after exact numeric provenance succeeds does host arithmetic reject an
 * impossible possession. It never treats every numeral as inventory. */
export async function reviewTopicSourceQuantities(input: TopicSourceQuantityReviewOptions): Promise<string | undefined> {
  if (!input.canon.entries.length) return undefined;
  const kind = input.kind ?? 'summary', purpose = (phase: string) => `topic_${kind}_quantity_${phase}`;
  const infer = async <T>(schema: z.ZodType<T>, purpose: string, system: string, data: unknown, validate: (value: T) => void, alternate?: Infer) => {
    let feedback: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const context = { system: system + '\n宿主numberCandidates.value=null只证明完整字面数词存在，尚不能可靠换算整数；不得拆词、猜数或把它当已知数量。来源总数/缺失序号不可计算时不能建立set；拟稿实际关系/数值不明确可用ambiguous弃权。明确count必须有一个实际数字索引，不能用空count代替弃权。actualEntityQuote/actualEntitySpans若存在，只核这些实际字面物品，不能用同句其它物品的数量代答，主体或集合无法明确对应应ambiguous。第1、3这样的序号列表也不能把末位3当基数数量，即使宿主ordinal只标了显式第N。',
          user: JSON.stringify({ purpose, data, outputSchema: z.toJSONSchema(schema), ...(feedback ? { formatCorrection: feedback } : {}) }) };
        if (purpose.endsWith('_source_premise_verification') || purpose.endsWith('_semantic_exemption_verification')) context.system = system;
        const value = schema.parse(alternate ? await alternate(context, input.signal)
          : await generateCompanionStructured(context, input.config, input.signal, { fetchFn: input.fetchFn, timeoutMs: 120000 })); validate(value); return value;
      } catch (error) {
        if (input.signal?.aborted || error instanceof CompanionModelError && error.code !== 'INVALID_RESPONSE') throw error;
        if (attempt === 2) throw new CompanionModelError('INVALID_RESPONSE', kind === 'reply'
          ? '正文数量来源/实际片段分类不能完整核验，未发布正文。' : '摘要数量来源/实际片段分类不能完整核验，未推进水位。');
        feedback = quantityFormatFeedback(error);
      }
    }
    throw new Error('数量审查缺失');
  };
  const canon = input.canon.entries.map((entry, canonIndex) => ({ canonIndex, sourceMessageId: entry.sourceMessageId, sourceChecksum: entry.sourceChecksum,
    quote: entry.quote, numberCandidates: topicQuantityNumberCandidates(entry.quote) }));
  const actualClauses = input.clauses.map(clause => ({ ...clause, numberCandidates: topicQuantityNumberCandidates(clause.text) }));
  const fullProposedText = [input.summary, input.stage].join('\n');
  const key = createHash('sha256').update(JSON.stringify(['source_bound_quantity_v6_relative_inventory_contract', quantitySourcePremiseProtocol, input.scope, input.config.model, input.config.apiFormat, input.config.baseUrl, canon])).digest('hex');
  // No owner/room/topic host scope means no cache reuse, rather than inferring
  // authority from a quote or assuming a global source id is sufficient.
  let sets = input.extractSets || input.verifySourcePremises || !input.scope ? undefined : cache.get(key)?.sets;
  if (!sets) {
    const extracted = await infer(setsSchema, purpose('source_sets'), '只从用户原句识别同一集合的总数与明确尚未得到的成员序号。只收有两者且同一实际集合明确的原句；日期、时刻、ID、计划、人物对白、跨集合、主体或本体不清全部弃权，不猜库存。每个set返回实际canonIndex、原句逐字entityQuote、总数的totalNumberIndex与所有明确缺失成员的missingOrdinalNumberIndexes。数字只选择该canon宿主已列numberCandidates.numberIndex，不能自写数字引文或从完整数字中截取；第N原文的数字也已枚举，ordinal标记只说明字面序号、不说明是否持有。entityQuote仅物品本体的短名词，禁止包含数字、数量词短语、谓词或整句，不要返回完整规则。不得把序号当缺失数量，也不自行算上限。只看每个候选自己的原句，不借其它来源补缺。没有明确这种集合则sets=[]。',
      { canon }, value => {
        for (const set of value.sets) {
          const source = canon[set.canonIndex]; if (!source || !source.quote.includes(set.entityQuote)
            || /[\d零〇一二两三四五六七八九十百千。，；：、！？]/u.test(set.entityQuote)) throw new Error('entityQuote须仅含原句逐字物品本体名词，不含数字或整句。');
          const indexes = [set.totalNumberIndex, ...set.missingOrdinalNumberIndexes];
          if (indexes.some(index => !source.numberCandidates[index]) || new Set(set.missingOrdinalNumberIndexes).size !== set.missingOrdinalNumberIndexes.length) throw new Error('来源数字索引必须存在且明确缺失成员不能重复。');
          if (indexes.some(index => source.numberCandidates[index]!.value === null)) continue;
          const total = boundNumber(source.numberCandidates, set.totalNumberIndex), missing = set.missingOrdinalNumberIndexes.map(index => boundNumber(source.numberCandidates, index));
          if (source.numberCandidates[set.totalNumberIndex]!.ordinal || total < 1 || missing.some(ordinal => ordinal < 1 || ordinal > total)
            || new Set(missing).size !== missing.length || new Set(set.missingOrdinalNumberIndexes).size !== set.missingOrdinalNumberIndexes.length) throw new Error('总数须是实际基数，明确缺失序号必须是有效且不重复的实际成员。');
        }
      }, input.extractSets);
    const proposals = extracted.sets.filter(set => ![set.totalNumberIndex, ...set.missingOrdinalNumberIndexes]
      .some(index => canon[set.canonIndex]!.numberCandidates[index]!.value === null));
    // A raw proposal, including a raw empty extraction, is never cached as a
    // mathematical authority. Exact source-only semantic receipts precede bounds.
    if (!proposals.length) return undefined;
    const sourceCandidates = buildQuantitySourcePremiseCandidates(canon, proposals);
    if (!sourceCandidates.length) return undefined;
    const receipt = await infer(quantitySourcePremiseSchema, purpose('source_premise_verification'), quantitySourcePremiseSystem,
      quantitySourcePremiseInput(sourceCandidates), value => validateQuantitySourcePremises(value, sourceCandidates), input.verifySourcePremises);
    sets = admitQuantitySourcePremises(receipt, sourceCandidates);
    if (!input.extractSets && !input.verifySourcePremises && input.scope) {
      cache.set(key, { sets, receipt }); if (cache.size > 128) cache.delete(cache.keys().next().value!);
    }
  }
  if (!sets.length) return undefined;
  const actualSets = sets;
  const requiredPairs = actualClauses.flatMap(clause => actualSets.flatMap((set, setIndex) => clause.text.includes(set.entityQuote)
    ? [{ clauseIndex: clause.clauseIndex, setIndex }] : []));
  if (!requiredPairs.length) return undefined;
  const extracted = await infer(claimsSchema, purpose('actual_claims'), '只抽取拟稿每个实际片段的数量角色，不判断它对不对、不修改正文。宿主requiredPairs逐字列出了必须独立核查的每个clauseIndex/setIndex。clauses必须完整覆盖每个requiredPair，至少一条该set的quantity；尚无明确数量命题或主体/集合有疑问时可usage=ambiguous且numberIndexes=[]，不能省略目标或返回空quantities。没有任何目标物品名词的非required实际clause可以不返回，也允许返回原完整clause列表；所有返回clauseIndex必须真实唯一。只核sets对应同一集合、实际主体明确的片段；跨主体/同名不同集合/不确定则ambiguous，不能仅数字相同就绑集合。逐项分类：current_possessed_count=叙述事实肯定句中角色在本句所述场景携带/持有多少个；实际携带可以由动作谓词表达，也可以由名词短语断言物品当场在角色穿戴或随身携带的容器中、或贴身的实体位置/接触状态表达，不要求出现持有动词。认知或回忆动作不能抹掉其对象被叙述的物理状态。不是作者或旁白本人拥有，不要求出现“当前”二字，也不要求全部；current_possessed_all=叙述事实肯定句中角色在该场景带齐目标集合/全部在手；current_possessed_members=实际断言当前携带哪些序号；missing=明确未得/缺失，不是持有；total=仅集合总数；planned=将来或计划；historical=有明确比当前叙事层更早的回忆或曾经库存时间锚；已完成进展的摘要、第三人称或普通过去式本身不自动成为historical；attributed=明确归属人物的对白/声称/猜测，不等于叙述事实；ambiguous=不确定。仅从本片段实际语法及完整proposed的作者归属和时间归属判断，不因为用户约束写了缺失就把正文实际“带N个”的措辞改读为总数。心理活动本身不自动改变所指状态的叙事时点，明确更早历史的库存也不能当成本句场景库存。numberIndexes只选择本actualClause宿主numberCandidates的numberIndex，禁止自写数字引文/occurrence或拆分完整数字；count恰一个，members给实际序号的索引，all可空。宿主数字标记仅证明逐字来源，不证明持有。不得代算或替稿子修错。',
    { sets: actualSets.map((set, setIndex) => ({ setIndex, canonIndex: set.canonIndex, quote: set.quote,
      entityQuote: set.entityQuote, total: set.total, missingOrdinals: set.missingOrdinals, unresolvedOrdinals: set.unresolvedOrdinals })), requiredPairs,
      requiredClauseIndexes: [...new Set(requiredPairs.map(pair => pair.clauseIndex))], proposed: kind === 'reply'
      ? { kind: 'reply', text: input.summary } : { summary: input.summary, stage: input.stage }, actualClauses }, value => {
      const indexes = value.clauses.map(clause => clause.clauseIndex);
      if (new Set(indexes).size !== indexes.length || indexes.some(index => !input.clauses[index])) throw new Error('clauses须唯一引用实际clauseIndex，且不得出现伪造或重复行。');
      if (requiredPairs.some(pair => !value.clauses.some(clause => clause.clauseIndex === pair.clauseIndex
        && clause.quantities.some(quantity => quantity.setIndex === pair.setIndex)))) throw new Error('必须完整覆盖每个requiredPair的真实clauseIndex和setIndex；没有明确数量命题可返回ambiguous和空numberIndexes，不能省略目标。');
      for (const clause of value.clauses) for (const quantity of clause.quantities) {
        const set = actualSets[quantity.setIndex], actual = actualClauses[clause.clauseIndex]!, text = actual.text;
        if (!set) throw new Error('setIndex必须是实际来源绑定集合。');
        if (new Set(quantity.numberIndexes).size !== quantity.numberIndexes.length || quantity.numberIndexes.some(index => !actual.numberCandidates[index])) throw new Error('numberIndexes必须唯一且仅选本actualClause宿主枚举的数字索引。');
        // An elliptical clause with no literal object is not host-provable
        // possession. Abstain instead of guessing its antecedent or blocking it.
        if (!text.includes(set.entityQuote)) continue;
        if (quantity.usage === 'current_possessed_count' && quantity.numberIndexes.length !== 1
          || quantity.usage === 'current_possessed_members' && !quantity.numberIndexes.length) throw new Error('实际持有数量/成员的数字索引不完整。');
      }
    }, input.extractClaims);
  // Retain the warm count's exact host indexes for a narrowly scoped unresolved
  // relationship check. They are never sent to the independent cold reader.
  const warmCountIndexes = new Map<string, Set<number>>();
  for (const clause of extracted.clauses) for (const quantity of clause.quantities) if (quantity.usage === 'current_possessed_count') {
    const identity = clause.clauseIndex + ':' + quantity.setIndex, indexes = warmCountIndexes.get(identity) ?? new Set<number>();
    for (const index of quantity.numberIndexes) indexes.add(index);
    warmCountIndexes.set(identity, indexes);
  }
  const proposedCandidates = extracted.clauses.flatMap(clause => clause.quantities.flatMap(quantity => {
    const set = actualSets[quantity.setIndex]!, upperBound = set.total - set.missingOrdinals.length, text = input.clauses[clause.clauseIndex]!.text;
    if (!text.includes(set.entityQuote)) return [];
    // The independent reader receives every host numeric span in the actual
    // clause, including an outer count omitted by the warm extractor.
    const numberSpans = actualClauses[clause.clauseIndex]!.numberCandidates;
    const actualEntitySpans: Array<{ start: number; end: number }> = [];
    for (let start = text.indexOf(set.entityQuote); start >= 0; start = text.indexOf(set.entityQuote, start + set.entityQuote.length))
      actualEntitySpans.push({ start, end: start + set.entityQuote.length });
    // A low incidental number cannot rule out an explicit all claim. Every
    // literal-noun candidate receives one deduplicated cold review, including
    // warm uncertainty. A shared noun is a candidate, not proof of identity.
    return [{ clauseIndex: clause.clauseIndex, setIndex: quantity.setIndex, canonIndex: set.canonIndex, canonQuote: set.quote, claimQuote: text, actualNumbers: numberSpans.map(span => span.value),
      numberSpans, actualEntityQuote: set.entityQuote, actualEntitySpans,
      total: set.total, missingOrdinals: set.missingOrdinals, availableUpperBound: upperBound, unresolvedSourceOrdinals: set.unresolvedOrdinals,
      warmCountNumberIndexes: [...warmCountIndexes.get(clause.clauseIndex + ':' + quantity.setIndex) ?? []] }];
  }));
  const possible = [...new Map(proposedCandidates.map(candidate => [candidate.clauseIndex + ':' + candidate.setIndex, candidate])).values()];
  if (!possible.length) return undefined;
  // Arithmetic requires a sound semantic premise. Independently re-read every
  // actual candidate's number roles before computing, never ask a critic to waive an
  // established mathematical contradiction. Parenthetical missing members are
  // not part of an adjacent list of held members.
  const roles = await infer(rolesSchema, purpose('role_verification'), '独立核实际局部文本的语法，不判断设定对错、不修正措辞。每个candidateIndex一次，numbers完整唯一覆盖每个宿主numberIndex；每项只答该数字，不改选其它数字。每个numbers项和all各自必填collection：same=有清楚原字关系证明它属于sourceIdentityReference所指同一实际集合；different=明确别组、另一套或其它角色的独立集合；ambiguous=身份不足以判定。sourceIdentityReference仅来自真实来源原句，字面数值已用固定marker遮蔽，不是宿主生成的主体摘要；其中数值性身份也可能丢失，A后被遮蔽的标识不能因同形就推定同人或同组。没有明确主体/本组等身份指代锚时，不得仅凭同名物品猜same。实际持有别组物品可以同时collection=different且relation=affirmed_holding，不矛盾；身份与持有关系是独立轴。每个数字与all都独立判断，不得把另一个数字、all或自由reason的结论当作本项collection。分开其余四轴：voice是支配这个数量命题的声音，不是作者写下了说话动作这件事。narrated_fact=旁白直接作为事实叙述句中角色的状态；带事实预设的觉察、注意到或想起所指实体状态，不因认知动作本身就自动成为人物声称。attributed_claim=这个数量持有命题本身被直接或间接归属为人物声称、对白、猜测或未被旁白确认的信念，例如人物以为、误信或推测的内容；不是一切人物认知对象。认知动作的事实与其对象的事实预设要分开判断：旁白独立给出的随身容器位置或贴身接触状态，不能因同句出现认知动作就一并降成人物信念。反之，回忆中嵌套他人声称仍是被归属的命题，不能由外层想起变成旁白事实；明确更早事件的库存仍按time=earlier_history，不由认知动词擅改场景时点。question=询问；hypothetical=假设、条件、计划或意图；ambiguous=不清。仅数字项还可voice=unrelated，表示ID等无关数字没有目标数量命题声部，此时relation与kind也必须同时为unrelated，不能用于count/member；all不接受此voice。作者叙述某人说了什么不让被转述的内容成为旁白事实；无引号的“她说自己带着”也可为attributed_claim。引号本身也不自动让命题成为人物声称，“她带着某个加引号的物品名词”仍可由外层叙述实际持有。relation独立判断本数字与actualEntityQuote目标物品的关系：affirmed_holding=本句明确肯定目标物在该角色本场景携带、持有或到手；可以由动作谓词表达，也可以由名词短语断言物品当场在角色穿戴或随身携带的容器里、或贴身的实体位置/接触状态表达，不要求出现持有动词。不是任意容器或附近位置都代表随身，仍需真实角色与容器关系；collection_size=仅抽象整组总量，原句没有断言本场景随身子集或上述实体位置/接触状态，不是一切集合的基数。随身容器内的实体数也能形成集合，但这里relation仍是affirmed_holding，基数由kind=count表达，不能因它说明某集合大小就降为collection_size；missing=否定、未得或缺失；unrelated=ID、时刻或其它物品；ambiguous=不清。仅提到数量、成员、归谁所有、控制或可寻找，不足以推定实际持有；不是否定、不是计划，也不等于存在肯定持有。time独立给scene=本句角色被述事件的场景时点，含本故事已完成进展的回顾，不要求作者本人拥有或文字有“当前”；earlier_history=明确切换到比当前叙事层更早事件的库存；认知或回忆动作发生的时间不等于所想到物品状态的时间，不能只因想起一词便把贴身物理状态、当前拿持或邻句当时状态判为更早历史。contextClauses是前后各一个真实原句，只帮助核本focus的声音、指代和物品状态时间，不是新的数量target；numbers仍只覆盖本focus的numberCandidates，不能输出邻句数字或借省略名词新造集合。future=未来；ambiguous=不清。kind只读正在被问数字本身：count基数数量、member成员序号、unrelated或ambiguous。基数持有不要求全部；成员存在不推已持有，第N或序号列表末项不能当count。外层基数与括号成员分别审，不能用正确成员列表覆盖外层基数断言。数字是基数不能把携带关系降成collection_size。每candidate另独立给all对象自己的voice/time/relation/reason，relation只有明确断言该角色把目标集合全部实际持有才affirmed_all，其余not_affirmed_all或ambiguous。all的voice/time不可从某数字或整个句子继承：同句可以混旁白、对白、提问和假设；不得由空数字或成员列表推定全部。句中角色的持有不要求旁白/作者本人持有。仅使用原句、目标物品逐字位置和宿主数字，没有用户规则或上界。同名物品不证明同一集合；原文明确另一套、别组或另一角色的独立集合可以relation=unrelated，all相应not_affirmed_all。主体或集合身份无法明确对应时保留ambiguous，不能凭同noun猜出持有关系或授权。不能猜主体、集合、数量或答案。',
    { candidates: possible.map((candidate, candidateIndex) => ({ candidateIndex,
      clauseIndex: candidate.clauseIndex, actualClause: candidate.claimQuote,
      sourceIdentityReference: quantityIdentityReference(candidate.canonQuote),
      // Neighbors explain reference, voice and event time. Only focus numbers
      // remain targets; a noun omitted in a neighbor creates no new collection.
      contextClauses: actualClauses.slice(Math.max(0, candidate.clauseIndex - 1), candidate.clauseIndex + 2)
        .filter(clause => clause.clauseIndex !== candidate.clauseIndex).map(clause => ({
          clauseIndex: clause.clauseIndex, relative: clause.clauseIndex < candidate.clauseIndex ? 'before' : 'after', text: clause.text,
          ...(typeof clause.start === 'number' && Number.isSafeInteger(clause.start) && clause.start >= 0
            && typeof clause.end === 'number' && Number.isSafeInteger(clause.end) && clause.end >= clause.start
            && fullProposedText.slice(clause.start, clause.end) === clause.text ? { start: clause.start, end: clause.end } : {}) })),
      actualEntityQuote: candidate.actualEntityQuote, actualEntitySpans: candidate.actualEntitySpans,
      numberCandidates: candidate.numberSpans })) }, value => {
      const indexes = value.reviews.map(review => review.candidateIndex);
      if (indexes.length !== possible.length || new Set(indexes).size !== indexes.length || indexes.some(index => !possible[index])) throw new Error('reviews必须完整唯一覆盖实际candidateIndex。');
      for (const review of value.reviews) {
        const candidate = possible[review.candidateIndex]!, numberIndexes = review.numbers.map(number => number.numberIndex);
        if (numberIndexes.length !== candidate.numberSpans.length || new Set(numberIndexes).size !== numberIndexes.length
          || numberIndexes.some(index => !candidate.numberSpans[index])) throw new Error('numbers必须完整唯一覆盖本候选所有宿主numberIndex，不能漏外层数字、重复或用另一数字代答。');
        for (const number of review.numbers) {
          if (number.voice === 'unrelated' && (number.relation !== 'unrelated' || number.kind !== 'unrelated')) throw new Error('无关数字voice=unrelated仅能与relation=unrelated且kind=unrelated同时使用，不能覆盖实际数量或成员命题。');
          if (number.voice === 'narrated_fact' && number.relation === 'affirmed_holding' && number.time === 'scene' && number.kind === 'count'
            && candidate.numberSpans[number.numberIndex]!.ordinal) throw new Error('count必须对应正在被问的实际基数，不能把第N成员序号当数量；请核本数字为member或ambiguous，不能改选其它索引。');
        }
      }
    }, input.verifyRoles);
  // Original mathematics and unresolved premises take precedence. A later
  // independent exemption can never overrule an already rejected whole draft.
  const effectiveReviews = roles.reviews, checkedCandidates = possible;
  const failures = effectiveReviews.flatMap(review => {
    const candidate = checkedCandidates[review.candidateIndex]!, members: number[] = [];
    const errors: Array<{ numberIndex?: number; value?: number; verifiedUsage: string; roleVerificationReason: string }> = [];
    for (const number of review.numbers) {
      if (number.collection !== 'same' || number.voice !== 'narrated_fact' || number.relation !== 'affirmed_holding' || number.time !== 'scene' || number.kind === 'unrelated' || number.kind === 'ambiguous') continue;
      const actual = candidate.numberSpans[number.numberIndex]!.value;
      // Unknown mathematical premises abstain only for this individual item;
      // they never waive a different known count or the independent all claim.
      if (actual === null) continue;
      if (number.kind === 'member') members.push(actual);
      const contradiction = number.kind === 'count' ? actual > candidate.availableUpperBound
        : actual < 1 || actual > candidate.total || candidate.missingOrdinals.includes(actual);
      if (contradiction) errors.push({ numberIndex: number.numberIndex, value: actual, verifiedUsage: number.kind, roleVerificationReason: number.reason });
    }
    if (new Set(members).size > candidate.availableUpperBound) errors.push({ verifiedUsage: 'members', roleVerificationReason: '实际肯定持有的不同成员数超出来源上界。' });
    if (review.all.collection === 'same' && review.all.voice === 'narrated_fact' && review.all.relation === 'affirmed_all' && review.all.time === 'scene' && candidate.missingOrdinals.length) errors.push({ verifiedUsage: 'all', roleVerificationReason: review.all.reason });
    return errors.map(error => ({ ...candidate, ...error, diagnosticType: 'mathematical_contradiction' }));
  });
  if (failures.length) return '宿主对已来源绑定且分类为实际持有的同一集合计算：总数减明确缺失成员数为可持有上界；拟稿超上界或声称持有明确缺失成员。此数学矛盾不能用其它地方正确重抄规则抵消。请同槽自行改正实际断言，'
    + (kind === 'reply' ? '原提案未正式发布。\n' : '原文/水位未推进。\n') + JSON.stringify(failures);
  const unresolved = effectiveReviews.flatMap(review => {
    const candidate = checkedCandidates[review.candidateIndex]!;
    const numeric = review.numbers.flatMap(number => {
      const span = candidate.numberSpans[number.numberIndex]!;
      if (number.collection !== 'different' && number.voice === 'narrated_fact' && number.time === 'scene' && number.kind === 'count' && number.relation === 'collection_size'
        && candidate.warmCountNumberIndexes.includes(number.numberIndex) && !span.ordinal && span.value !== null && span.value > candidate.availableUpperBound
      ) return [{ ...candidate, diagnosticType: 'unresolved_holding_relation', unresolvedReason: 'count_holding_vs_total', numberIndex: number.numberIndex,
        value: span.value, roleVerificationReason: number.reason }];
      const eligible = number.collection !== 'different' && (number.voice === 'narrated_fact' || number.voice === 'ambiguous') && (number.time === 'scene' || number.time === 'ambiguous')
        && (number.relation === 'affirmed_holding' || number.relation === 'ambiguous') && number.kind !== 'unrelated';
      const hasAmbiguousPremise = [number.collection, number.voice, number.time, number.relation, number.kind].includes('ambiguous');
      const memberRisk = span.value !== null && (span.value < 1 || span.value > candidate.total || candidate.missingOrdinals.includes(span.value));
      const countRisk = span.value !== null && !span.ordinal && span.value > candidate.availableUpperBound;
      const mathRisk = number.kind === 'member' ? memberRisk : number.kind === 'count' ? countRisk
        : number.kind === 'ambiguous' && (span.ordinal ? memberRisk : countRisk);
      return eligible && hasAmbiguousPremise && mathRisk ? [{ ...candidate, diagnosticType: 'unresolved_holding_relation',
        unresolvedReason: 'ambiguous_numeric_premise', numberIndex: number.numberIndex, value: span.value,
        roleVerificationReason: number.reason }] : [];
    });
    const all = review.all.collection !== 'different' && (review.all.relation === 'affirmed_all' || review.all.relation === 'ambiguous')
      && [review.all.collection, review.all.voice, review.all.time, review.all.relation].includes('ambiguous') && (review.all.voice === 'narrated_fact' || review.all.voice === 'ambiguous')
      && (review.all.time === 'scene' || review.all.time === 'ambiguous') && candidate.missingOrdinals.length
      ? [{ ...candidate, diagnosticType: 'unresolved_holding_relation', unresolvedReason: 'ambiguous_all_relation', roleVerificationReason: review.all.reason }] : [];
    return [...numeric, ...all];
  });
  const unresolvedSource = effectiveReviews.flatMap(review => {
    const candidate = checkedCandidates[review.candidateIndex]!;
    if (!candidate.unresolvedSourceOrdinals.length) return [];
    // This number is a possible conflict under unresolved physical-member
    // availability, never a factual count bound. Clear negative source verdicts
    // have already been excluded, and explicit non-possession semantics stay free.
    const possibleRiskThreshold = candidate.total - new Set([...candidate.missingOrdinals, ...candidate.unresolvedSourceOrdinals]).size;
    const numbers = review.numbers.filter(number => {
      const span = candidate.numberSpans[number.numberIndex]!;
      if (number.collection === 'different' || !['narrated_fact', 'ambiguous'].includes(number.voice)
        || !['scene', 'ambiguous'].includes(number.time) || !['affirmed_holding', 'ambiguous'].includes(number.relation)
        || span.value === null || number.kind === 'unrelated') return false;
      return number.kind === 'member' || number.kind === 'ambiguous' && span.ordinal
        ? candidate.unresolvedSourceOrdinals.includes(span.value)
        : !span.ordinal && span.value > possibleRiskThreshold;
    }).map(number => ({ ...candidate, diagnosticType: 'unresolved_source_premise', numberIndex: number.numberIndex,
      unresolvedReason: 'physical_member_availability_not_confirmed', roleVerificationReason: number.reason }));
    const all = review.all.collection !== 'different' && ['narrated_fact', 'ambiguous'].includes(review.all.voice)
      && ['scene', 'ambiguous'].includes(review.all.time) && ['affirmed_all', 'ambiguous'].includes(review.all.relation)
      ? [{ ...candidate, diagnosticType: 'unresolved_source_premise', unresolvedReason: 'all_with_unconfirmed_physical_member', roleVerificationReason: review.all.reason }] : [];
    return [...numbers, ...all];
  });
  const pending = [...unresolved, ...unresolvedSource];
  if (pending.length) return '来源相关的持有前提未决，尚不能认证安全，也不等于已证明的数学矛盾。请同槽澄清目标主体、集合和场景时点，以及是集合总量还是当场携带量，'
    + (kind === 'reply' ? '原提案未正式发布。\n' : '原文/水位未推进。\n') + JSON.stringify(pending);
  const checks = quantityDisjointChecks(possible, roles.reviews);
  if (checks.length > quantityDisjointCapacity) throw new CompanionModelError('INVALID_RESPONSE', kind === 'reply'
    ? '正文语义豁免目标超过单批容量，未发布正文。' : '摘要语义豁免目标超过单批容量，未推进水位。');
  if (!checks.length) return undefined;
  const data = quantityDisjointInput(checks, possible, actualClauses, text => quantityIdentityReference(text).text);
  const waiver = await infer(quantityDisjointWaiverSchema, purpose('semantic_exemption_verification'), quantityDisjointWaiverSystem,
    data, value => validateQuantityDisjointWaivers(value, data), input.verifyDisjointWaivers);
  const admitted = admitQuantityDisjointWaivers(roles.reviews, waiver, data, {
    scope: input.scope, evidence: possible.map((candidate, candidateIndex) => ({ candidateIndex,
      sourceQuoteChecksum: createHash('sha256').update(candidate.canonQuote).digest('hex'),
      focusChecksum: createHash('sha256').update(candidate.claimQuote).digest('hex') })),
  }, possible);
  return admitted.pending.length ? '风险数量的语义豁免尚无一致且有原句依据的认证；这是独立未决，不等于已证明的数学矛盾。请同槽澄清该目标的实际声音、时点、集合和数量角色，'
    + (kind === 'reply' ? '原提案未正式发布。\n' : '原文/水位未推进。\n')
    + JSON.stringify(admitted.pending.map(item => ({ ...possible[item.candidateIndex], ...item }))) : undefined;
}

/** Existing summary callers retain their purpose names and output contract. */
export function reviewTopicSummaryQuantities(input: Omit<TopicSourceQuantityReviewOptions, 'kind'>): Promise<string | undefined> {
  return reviewTopicSourceQuantities({ ...input, kind: 'summary' });
}
