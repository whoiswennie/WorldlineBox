import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CompanionModelError, generateCompanionStructured, type CompanionModelConfig } from './model';
import type { TopicUserCanon } from './topic-user-canon';
import { admitQuantitySourcePremises, buildQuantitySourcePremiseCandidates, quantitySourcePremiseInput,
  quantitySourcePremiseProtocol, quantitySourcePremiseSchema, quantitySourcePremiseSystem, validateQuantitySourcePremises,
  type QuantitySourcePremiseReview, type VerifiedQuantitySourceSet } from './topic-source-quantity-premise';
import { quantityDisjointChecks, quantityDisjointInput, quantityDisjointWaiverSchema, quantityDisjointWaiverSystem, quantityDisjointCapacity,
  validateQuantityDisjointWaivers, admitQuantityDisjointWaivers, quantityAuthorAllProjectionSchema, validateQuantityAuthorAllProjection, quantityAuthorAllProjectionAdmission,
  quantityAuthorNumberProjectionSchema, validateQuantityAuthorNumberProjection, quantityAuthorNumberProjectionAdmission, quantityAuthorProjectionCapacity, quantityNumberHasRisk } from './topic-quantity-disjoint-waiver';

type Infer = (context: { system: string; user: string }, signal?: AbortSignal) => Promise<unknown>;
const numberIndex = z.number().int().nonnegative();
const setSchema = z.strictObject({ canonIndex: z.number().int().nonnegative(), entityQuote: z.string().min(1).max(80), totalNumberIndex: numberIndex,
  missingOrdinalNumberIndexes: z.array(numberIndex).min(1).max(100) });
const setsSchema = z.strictObject({ sets: z.array(setSchema).max(80) });
export const quantityClaimsSchema = z.strictObject({ clauses: z.array(z.strictObject({ clauseIndex: z.number().int().nonnegative(), quantities: z.array(z.object({
  setIndex: z.number().int().nonnegative(),
  usage: z.enum(['current_possessed_count', 'current_possessed_all', 'current_possessed_members', 'missing', 'total', 'planned', 'historical', 'attributed', 'ambiguous']),
  numberIndexes: z.array(numberIndex).max(100) })).max(80) })).max(1000),
  allProjections: z.array(z.strictObject({ clauseIndex: z.number().int().nonnegative(), setIndex: z.number().int().nonnegative(), projection: quantityAuthorAllProjectionSchema })).max(1000),
  numberProjections: z.array(z.strictObject({ clauseIndex: z.number().int().nonnegative(), setIndex: z.number().int().nonnegative(), numberIndex,
    projection: quantityAuthorNumberProjectionSchema })).max(quantityAuthorProjectionCapacity) });
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
  'allProjections', 'numberProjections', 'targetNumberQuote', 'targetOccurrence', 'occurrence', 'projection', 'checkIndex', 'verdict', 'basis', 'evidenceRefs', 'view', 'allProjection', 'statement', 'coverage', 'reviewedFocusRef', 'witnesses', 'role', 'evidenceRef', 'quote',
  'domainScope', 'exhaustivity', 'holding', 'opposition']);
const hostFormatMessages = new Set([
  '全部持有投影须完整唯一覆盖实际clauseIndex和setIndex。', '数字目标不能借用全部持有投影。', '全部持有投影须完整核验本目标实际焦点。', '全部持有投影引文须唯一绑定本目标实际有界原句。',
  '数字持有投影须完整唯一覆盖每个实际clauseIndex、setIndex和numberIndex。', '数字持有投影须绑定本目标实际完整数词及occurrence。', '数字持有投影引文须绑定本目标实际有界原句及occurrence。',
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
        if (purpose.endsWith('_source_premise_verification') || purpose.endsWith('_semantic_exemption_verification') || purpose.endsWith('_actual_claims')) context.system = system;
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
  if (requiredPairs.length > quantityDisjointCapacity) throw new CompanionModelError('INVALID_RESPONSE', kind === 'reply'
    ? '正文数量目标超过单批容量，未发布正文。' : '摘要数量目标超过单批容量，未推进水位。');
  const requiredNumberTargets = requiredPairs.flatMap(pair => actualClauses[pair.clauseIndex]!.numberCandidates.map(number => ({ ...pair, numberIndex: number.numberIndex })));
  const combinedProjectionCount = requiredPairs.length + requiredNumberTargets.length;
  // This disclosed bound covers the full literal grid, never a source-risk
  // subset. It prevents obvious output overflow but cannot guarantee8192tokens.
  if (combinedProjectionCount > quantityAuthorProjectionCapacity) return '作者数量盲投影超过单批容量，无法完整认证；这是容量未决，不是数学矛盾。原提案/水位未推进。\n'
    + JSON.stringify({ diagnosticType: 'unresolved_author_projection_capacity', combinedProjectionCount, capacity: quantityAuthorProjectionCapacity });
  const claimData = { sets: actualSets.map((set, setIndex) => ({ setIndex, entityQuote: set.entityQuote })), requiredPairs,
    requiredNumberTargets, requiredClauseIndexes: [...new Set(requiredPairs.map(pair => pair.clauseIndex))], proposed: kind === 'reply'
      ? { kind: 'reply', text: input.summary } : { summary: input.summary, stage: input.stage }, actualClauses };
  const extracted = await infer(quantityClaimsSchema, purpose('actual_claims'), `只从完整作者拟稿抽取实际数量语法和全称命题，不判断设定对错、不改文本。整个输入没有来源规则/库存数/缺失状态；setIndex只是目标物品短名词的宿主opaque定位键，同名不证明同一库存，也不能因为看不到来源身份就漏掉本句数量角色。clauses完整覆盖每个requiredPair，至少一条quantity；usage依实际原句给current_possessed_count、current_possessed_members、current_possessed_all、missing、total、planned、historical、attributed或ambiguous。count恰一个真实numberIndex，members选本句真实序号；all可无数字。场景实体持有含动作或实际随身容器/贴身状态，不要求作者本人持有或出现当前二字。认知动作不自动消除其对象的事实预设，明确更早库存才historical，普通已完成进展不自动成为过去库存。主体/声部未知可ambiguous，不从来源猜身份。numberIndexes只用本actualClause完整宿主候选，不拆词/自造/改选，value=null只弃权该数值。
另独立返回allProjections，每个required(clauseIndex,setIndex)恰一项，不从quantity usage、数字存在或成员列表推投影，不因无数字或usage ambiguous省略。projection是作者完整focus的单一量化持有IR，不返回statement；最终四态只由宿主派生，不证明现实能否持齐，也不对齐看不到的canon库存。domainScope=whole_collection_candidate表示本句作者所指集合可能是目标库存，不证明与来源同组；explicit_partitive_scope只在原文明确限定已得/在手部分或相对子域时使用，不借隐藏总数证明真子集，也不能只因架上、箱内或换owner等描述性名词就判子域；限制或方向不清为ambiguous。exhaustivity只核支配本目标同一个持有命题的覆盖：exhaustive=作者有穷尽该域的正向算子/构式，explicit_not_exhaustive=作者明确否定或限制整体持有，not_asserted=完整scope未断言穷尽持有，ambiguous=相关范围未定。普通基数/复数/定指名词只确定域，绝不是穷尽算子；不由数字相等、成员名单或名词为集合就推全集。穷尽可由真实量化、分配、无余项或完成结果构式表达，不要求固定全称词。全称属性与普通数量持有即便在同focus也不能拼接：一个量词必须实际作用于正在被审的持有谓词。
holding=affirmed/denied/not_asserted/ambiguous，分别是作者实际肯定持有/明确否定持有/完整scope没有持有命题/持有作用域未知；not_asserted是有原文范围见证的缺席，不是“不知道”。人物声称的命题仍可肯定，声音/时点另行判断，不改变此IR。opposition=none_in_reviewed_scope仅指完整scope没有同目标相关相反整体持有断言；有相关正反为competing_whole_possession_assertions，可能有竞争但作用域未明为unresolved_possible_competition，不借无关轴未知制造冲突。冲突优先，不能选一个安全片段抹掉更广肯定。只要声明本holding的exhaustive_coverage_operator或整体negative出处就不能同时写exhaustivity=not_asserted，不能靠缺另一role解除矛盾；holding=not_asserted不得与holding的算子、持有/否定role或明确exhaustive/explicit_not_exhaustive并存。其它属性的全称不是本holding的算子，不入这两个字段。其余无关domain或holding未知不妨碍有完整scope见证的exhaustivity=not_asserted；无持有命题也可与其它属性的全称共存。整体否定只由真实negative scope支持；子域穷尽不是更广库存的整体否定。未知/弱证据保持未证，不能造数学结论。
每projection coverage=whole_focus，reviewedFocusRef精确绑定本clause。witnesses最多6项，只引用实际focus或前后各一句的连续逐字quote，不生成offset。role分别为domain_reference（名词域，永不单独证明穷尽）、exhaustive_coverage_operator（真实穷尽算子/构式且作用于同一持有谓词）、scoped_possession_predicate（实际持有/取得/取回/携带/可用谓词）、negative_or_limited_scope（真实整体持有否定/限制）、partitive_domain_restriction（真实子域限制，不能代替整体否定）、target_scope（中性完整目标范围）。肯定整体须域+算子+持有谓词，子域穷尽另须子域限制，整体否定须真实negative；强出处至少一项在本focus。算子和域引文可重叠，但普通数量名词不能充算子。没有全称可用target_scope，不捏造不存在的谓词/量词。空见证或缺强role是正常语义未证，不为填齐强造；逐字出处不等同语义证明。不要套有限关键词表或用来源规则修正作者断言。
再独立返回numberProjections，完整唯一覆盖requiredNumberTargets每个(clauseIndex,setIndex,numberIndex)，包括无关ID、近似/不可计算数词和每次重复出现，不能只选usage或猜想有风险的数字。targetNumberQuote与targetOccurrence照本focus宿主numberCandidates逐字绑定；相同字面不同occurrence不是同一目标。只审该数字支配的作者命题，不判断来源库存身份或数学安全。statement四态：affirmative_possession=本目标实际断言角色获得、取回、携带、随身物理在场或当场实际可用的目标物；不要求动词持有。explicit_nonpossession=本目标在被审场景明确被否定、未得或排除在实际持有范围之外；不要求世界全部历史从未持有，也不要求未来永不能获得。no_possession_assertion=完整焦点本目标没有肯定持有断言，可为抽象总量、ID、他物数词、成员引用；不是证明现实不可能持有。ambiguous=该目标命题/否定scope不明。单独未寻获不必强推物理不存在，但不能反向补出肯定持有；以实际完整语境选择negative或无肯定断言，不能要求永不持有。历史否定不擦除当前肯定，先前已得也不改写当前明确未得；同focus相反作用域不明须ambiguous。人物对白中的肯定仍可affirmative，声部/时点留后续独立比较；不要用all或另一数字代答。
每数字projection coverage=whole_focus并绑定reviewedFocusRef。witnesses用本focus或±1实际句，逐字quote，不数offset或引文出现次数；宿主枚举全部匹配并筛选覆盖本目标真实span的匹配，不采用首次匹配；每个非未知投影需本focus的target_scope引文覆盖完整目标数词。affirmative另需scoped_possession_predicate、negative另需negative_scope；实际支配谓词可在focus或±1句，不强迫谓词引文本身包含数字，指代和作用域须真实关联本target而非另一事件。no_possession只需实际focus target_scope。保持最短充分原文且每quote≤300字符。缺强见证或空witness是语义未证，不强造；不按数字角色自动决定持有极性，不把纯编号写成当前肯定持有。`,
    claimData, value => {
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
      const pairKeys = value.allProjections.map(row => row.clauseIndex + ':' + row.setIndex);
      if (pairKeys.length !== requiredPairs.length || new Set(pairKeys).size !== pairKeys.length
        || requiredPairs.some(pair => !pairKeys.includes(pair.clauseIndex + ':' + pair.setIndex)))
        throw new Error('全部持有投影须完整唯一覆盖实际clauseIndex和setIndex。');
      for (const row of value.allProjections) validateQuantityAuthorAllProjection(row.projection, row.clauseIndex, actualClauses);
      const numberKeys = value.numberProjections.map(row => row.clauseIndex + ':' + row.setIndex + ':' + row.numberIndex);
      if (numberKeys.length !== requiredNumberTargets.length || new Set(numberKeys).size !== numberKeys.length
        || requiredNumberTargets.some(target => !numberKeys.includes(target.clauseIndex + ':' + target.setIndex + ':' + target.numberIndex)))
        throw new Error('数字持有投影须完整唯一覆盖每个实际clauseIndex、setIndex和numberIndex。');
      for (const row of value.numberProjections) validateQuantityAuthorNumberProjection(row.projection, row.clauseIndex, row.numberIndex, actualClauses);
    }, input.extractClaims);
  const authorAllInputChecksum = createHash('sha256').update(JSON.stringify(claimData)).digest('hex');
  const authorAllOutputChecksum = createHash('sha256').update(JSON.stringify(extracted)).digest('hex');
  const authorProjectionByPair = new Map(extracted.allProjections.map(row => [row.clauseIndex + ':' + row.setIndex, row.projection]));
  const authorNumbersByPair = new Map(requiredPairs.map(pair => [pair.clauseIndex + ':' + pair.setIndex,
    extracted.numberProjections.filter(row => row.clauseIndex === pair.clauseIndex && row.setIndex === pair.setIndex).map(row => ({ numberIndex: row.numberIndex, projection: row.projection,
      literalWitnessLocations: validateQuantityAuthorNumberProjection(row.projection, row.clauseIndex, row.numberIndex, actualClauses) }))]));
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
      warmCountNumberIndexes: [...warmCountIndexes.get(clause.clauseIndex + ':' + quantity.setIndex) ?? []],
      authorAllProjection: authorProjectionByPair.get(clause.clauseIndex + ':' + quantity.setIndex)!,
      authorNumberProjections: authorNumbersByPair.get(clause.clauseIndex + ':' + quantity.setIndex)!,
      authorAllInputChecksum, authorAllOutputChecksum, authorAllPhase: purpose('actual_claims'), authorAllPair: { clauseIndex: clause.clauseIndex, setIndex: quantity.setIndex },
      authorAllWitnessLocations: validateQuantityAuthorAllProjection(authorProjectionByPair.get(clause.clauseIndex + ':' + quantity.setIndex)!, clause.clauseIndex, actualClauses) }];
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
  const authorDisagreements = roles.reviews.flatMap(review => {
    const candidate = possible[review.candidateIndex]!;
    const all = quantityAuthorAllProjectionAdmission(candidate, review.all).conflictsWithRaw
      ? [{ ...candidate, diagnosticType: 'unresolved_semantic_exemption', target: { kind: 'all' },
        unresolvedReason: 'opposed_raw_author_projection', rawClassification: review.all, protocol: 'quantity_semantic_exemption_v6',
        authorAllReceipt: quantityAuthorAllProjectionAdmission(candidate, review.all).receipt }] : [];
    const numbers = review.numbers.filter(number => quantityNumberHasRisk(candidate, number.numberIndex)
      && quantityAuthorNumberProjectionAdmission(candidate, number).conflictsWithRaw).map(number => ({
      diagnosticType: 'unresolved_semantic_exemption', target: { kind: 'number', numberIndex: number.numberIndex },
      unresolvedReason: 'opposed_raw_author_projection', rawClassification: number, protocol: 'quantity_semantic_exemption_v6',
      authorNumberReceipt: quantityAuthorNumberProjectionAdmission(candidate, number).receipt }));
    return [...all, ...numbers];
  });
  if (authorDisagreements.length) return '作者盲投影与原肯定持有分类不一致，这是独立未决，不是新的数学结论。原提案/水位未推进。\n' + JSON.stringify(authorDisagreements);
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
