import { createHash } from 'node:crypto';
import { z } from 'zod';

export const quantitySourcePremiseProtocol = 'source_quantity_premise_v1_bound_clauses';
export interface QuantitySourceNumberSpan { numberIndex: number; start: number; end: number; value: number | null; ordinal: boolean }
export interface QuantitySourceCanon { canonIndex: number; sourceMessageId: string; sourceChecksum: string; quote: string;
  numberCandidates: readonly QuantitySourceNumberSpan[] }
export interface ProposedQuantitySourceSet { canonIndex: number; entityQuote: string; totalNumberIndex: number; missingOrdinalNumberIndexes: number[] }
interface SourceClause { clauseIndex: number; start: number; end: number; text: string }
export interface QuantitySourcePremiseCandidate { setIndex: number; proposal: ProposedQuantitySourceSet; source: QuantitySourceCanon;
  clauses: SourceClause[]; totalClauseIndex: number; memberClauseIndexes: Map<number, number> }
export const quantitySourcePremiseSchema = z.strictObject({ sets: z.array(z.strictObject({
  setIndex: z.number().int().nonnegative(), totalBinding: z.enum(['supported', 'not_supported', 'ambiguous']),
  totalEvidenceClauseIndex: z.number().int().nonnegative(), reason: z.string().min(1).max(1000),
  members: z.array(z.strictObject({ ordinalNumberIndex: z.number().int().nonnegative(),
    evidenceClauseIndexes: z.array(z.number().int().nonnegative()).min(1).max(3),
    predicateTarget: z.enum(['physical_member', 'member_attribute', 'none', 'ambiguous']),
    memberAvailability: z.enum(['not_possessed', 'present', 'not_stated', 'ambiguous']),
    applicability: z.enum(['current_direct', 'outside_current_inventory', 'attributed_or_conditional', 'ambiguous']),
    reason: z.string().min(1).max(1000) })).min(1).max(100),
})).max(80) });
export type QuantitySourcePremiseReview = z.infer<typeof quantitySourcePremiseSchema>;
export interface VerifiedQuantitySourceSet { canonIndex: number; quote: string; entityQuote: string; total: number;
  missingOrdinals: number[]; unresolvedOrdinals: number[];
  sourcePremiseReceipt: { protocol: string; sourceMessageId: string; sourceChecksum: string; sourceQuoteChecksum: string;
    totalNumberIndex: number; review: QuantitySourcePremiseReview['sets'][number] } }

/** Exact source slices with UTF16 JavaScript positions. The model selects these
 * indexes rather than inventing offsets, and no slice by itself proves absence. */
export function quantitySourceEvidenceClauses(quote: string): SourceClause[] {
  const clauses: SourceClause[] = [];
  for (const match of quote.matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu)) {
    const text = match[0].trim(); if (!text) continue;
    const start = match.index + match[0].indexOf(text);
    clauses.push({ clauseIndex: clauses.length, start, end: start + text.length, text });
  }
  return clauses;
}
export function buildQuantitySourcePremiseCandidates(canon: readonly QuantitySourceCanon[], proposals: readonly ProposedQuantitySourceSet[]): QuantitySourcePremiseCandidate[] {
  const computable = proposals.filter(proposal => {
    const source = canon[proposal.canonIndex], total = source?.numberCandidates[proposal.totalNumberIndex];
    const missing = proposal.missingOrdinalNumberIndexes.map(index => source?.numberCandidates[index]);
    if (!source || !source.quote.includes(proposal.entityQuote) || !total || missing.some(span => !span))
      throw new Error('source premise须绑定实际来源与数字所在原句。');
    if (total.value === null || missing.some(span => span!.value === null)) return false;
    if (total.ordinal || total.value < 1 || new Set(proposal.missingOrdinalNumberIndexes).size !== missing.length
      || new Set(missing.map(span => span!.value)).size !== missing.length
      || missing.some(span => span!.value! < 1 || span!.value! > total.value!))
      throw new Error('source premise须绑定实际来源与数字所在原句。');
    return true;
  });
  return computable.map((proposal, setIndex) => {
    const source = canon[proposal.canonIndex];
    if (!source) throw new Error('source premise须绑定实际来源与数字所在原句。');
    const clauses = quantitySourceEvidenceClauses(source.quote);
    const containing = (numberIndex: number) => {
      const span = source.numberCandidates[numberIndex];
      const clause = span && clauses.find(item => item.start <= span.start && item.end >= span.end);
      if (!span || !clause || source.quote.slice(clause.start, clause.end) !== clause.text)
        throw new Error('source premise须绑定实际来源与数字所在原句。');
      return clause.clauseIndex;
    };
    return { setIndex, proposal, source, clauses, totalClauseIndex: containing(proposal.totalNumberIndex),
      memberClauseIndexes: new Map(proposal.missingOrdinalNumberIndexes.map(index => [index, containing(index)])) };
  });
}
const maskAliases = (text: string) => text.replace(/[\p{N}零壹贰貳弍叁叄參肆伍陆陸柒捌玖拾佰仟萬億兆廿卅卌]+/gu, '〔数值已遮蔽〕');
function spanLabel(index: number) {
  let label = '';
  for (let cursor = index + 1; cursor > 0; cursor = Math.floor((cursor - 1) / 26)) label = String.fromCharCode(65 + (cursor - 1) % 26) + label;
  return '〔候选' + label + '〕';
}
function maskedClause(candidate: QuantitySourcePremiseCandidate, clause: SourceClause) {
  let text = '', cursor = clause.start;
  for (const span of candidate.source.numberCandidates.filter(item => item.start >= clause.start && item.end <= clause.end)) {
    text += maskAliases(candidate.source.quote.slice(cursor, span.start)) + spanLabel(span.numberIndex); cursor = span.end;
  }
  return text + maskAliases(candidate.source.quote.slice(cursor, clause.end));
}
/** No draft, warm label, actual numeric values or computed inventory bound is
 * supplied. Opaque labels identify host spans without exposing their values. */
export function quantitySourcePremiseInput(candidates: readonly QuantitySourcePremiseCandidate[]) {
  return { candidates: candidates.map(candidate => ({ setIndex: candidate.setIndex,
    sourceQuoteChecksum: createHash('sha256').update(candidate.source.quote).digest('hex'),
    actualEntityQuote: maskAliases(candidate.proposal.entityQuote),
    sourceClauses: candidate.clauses.map(clause => ({ clauseIndex: clause.clauseIndex, start: clause.start, end: clause.end, text: maskedClause(candidate, clause) })),
    numberReferences: candidate.source.numberCandidates.map(span => ({ numberIndex: span.numberIndex, reference: spanLabel(span.numberIndex),
      start: span.start, end: span.end, ordinal: span.ordinal })),
    totalReference: { numberIndex: candidate.proposal.totalNumberIndex, clauseIndex: candidate.totalClauseIndex },
    members: [...candidate.memberClauseIndexes].map(([ordinalNumberIndex, memberClauseIndex]) => ({ ordinalNumberIndex, memberClauseIndex })),
  })) };
}
export function validateQuantitySourcePremises(value: QuantitySourcePremiseReview, candidates: readonly QuantitySourcePremiseCandidate[]) {
  const indexes = value.sets.map(set => set.setIndex);
  if (indexes.length !== candidates.length || new Set(indexes).size !== indexes.length || indexes.some(index => !candidates[index]))
    throw new Error('source premise必须完整唯一覆盖每个实际setIndex。');
  for (const set of value.sets) {
    const candidate = candidates[set.setIndex]!;
    if (set.totalEvidenceClauseIndex !== candidate.totalClauseIndex) throw new Error('source premise证据必须选实际宿主原句，且包含所指数字。');
    const members = set.members.map(member => member.ordinalNumberIndex);
    if (members.length !== candidate.memberClauseIndexes.size || new Set(members).size !== members.length
      || members.some(index => !candidate.memberClauseIndexes.has(index))) throw new Error('source premise必须完整唯一覆盖每个候选member数字。');
    for (const member of set.members) {
      if (new Set(member.evidenceClauseIndexes).size !== member.evidenceClauseIndexes.length
        || member.evidenceClauseIndexes.some(index => !candidate.clauses[index])
        || !member.evidenceClauseIndexes.includes(candidate.memberClauseIndexes.get(member.ordinalNumberIndex)!))
        throw new Error('source premise证据必须选实际宿主原句，且包含所指数字。');
    }
  }
}
export function admitQuantitySourcePremises(value: QuantitySourcePremiseReview, candidates: readonly QuantitySourcePremiseCandidate[]): VerifiedQuantitySourceSet[] {
  validateQuantitySourcePremises(value, candidates);
  return value.sets.flatMap(set => {
    const candidate = candidates[set.setIndex]!;
    // An unverified total cannot become either a factual or a hypothetical
    // numerical bound. Unknown attributes and present/damaged objects are not
    // physical unavailability. They are excluded before any arithmetic.
    if (set.totalBinding !== 'supported') return [];
    const totalSpan = candidate.source.numberCandidates[candidate.proposal.totalNumberIndex];
    if (!totalSpan || totalSpan.value === null || totalSpan.ordinal || totalSpan.value < 1) return [];
    const missing: number[] = [], unresolved: number[] = [];
    for (const member of set.members) {
      if (member.predicateTarget !== 'physical_member' || member.memberAvailability === 'present' || member.memberAvailability === 'not_stated'
        || member.applicability === 'outside_current_inventory' || member.applicability === 'attributed_or_conditional') continue;
      const ordinal = candidate.source.numberCandidates[member.ordinalNumberIndex]?.value;
      if (ordinal === null || ordinal === undefined || ordinal < 1 || ordinal > totalSpan.value) continue;
      if (member.memberAvailability === 'not_possessed' && member.applicability === 'current_direct') missing.push(ordinal);
      else if (member.memberAvailability === 'ambiguous' || member.applicability === 'ambiguous') unresolved.push(ordinal);
    }
    if (!missing.length && !unresolved.length) return [];
    return [{ canonIndex: candidate.proposal.canonIndex, quote: candidate.source.quote, entityQuote: candidate.proposal.entityQuote,
      total: totalSpan.value,
      missingOrdinals: [...new Set(missing)], unresolvedOrdinals: [...new Set(unresolved)],
      sourcePremiseReceipt: { protocol: quantitySourcePremiseProtocol, sourceMessageId: candidate.source.sourceMessageId,
        sourceChecksum: candidate.source.sourceChecksum, sourceQuoteChecksum: createHash('sha256').update(candidate.source.quote).digest('hex'),
        totalNumberIndex: candidate.proposal.totalNumberIndex, review: set } }];
  });
}
export const quantitySourcePremiseSystem = '只独立复核来源自己的本体/缺失前提，不读拟稿、不推算库存上界、不替作者改文。每个setIndex完整返回，totalBinding只有候选总数确实是目标物品同一集合的基数才supported；时间、重量、ID、其它集合不支持。members必须逐个完整唯一回答实际ordinalNumberIndex，evidenceClauseIndexes只选宿主真实sourceClauses，并包含成员数字所在句，可加相邻真实句说明谓语辖域，禁止自写offset或引文。predicateTarget独立判断未得/缺失谓语指物品本体physical_member，还是现有物品的名字/颜色/文字/可辨性等属性member_attribute，或none/ambiguous。memberAvailability独立判断该物品本体未取得/不在相应库存not_possessed、明确在场present、根本没陈述本体可用性not_stated或ambiguous。属性未知、照片文字不清、物品在场但损坏不等于缺这个物体；不要把“未知/不可辨认/失联”任意字眼变成缺物。applicability只有来源直接陈述其当前适用库存状态才current_direct；明确更早/别处库存outside_current_inventory，人物声称/条件/计划attributed_or_conditional，不清ambiguous。只有physical_member+not_possessed+current_direct可支持物理缺失。确认谓语指物体但是否未得/适用库存尚不明确可保ambiguous；没有物体缺失证据应none或not_stated，不为凑上界猜缺失。数字值均已遮蔽，字面候选标签只定位来源，不证明本体/持有/真值；数值性身份被遮蔽后不能因同形猜同人同组。只据原句关系判断，理由不能覆盖结构化前提。';
