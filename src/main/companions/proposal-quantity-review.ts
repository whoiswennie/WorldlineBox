import { z } from 'zod';
import { createHash } from 'node:crypto';
import { topicQuantityNumberCandidates } from './topic-summary-quantity-review';
import { topicSummaryClauses } from './topic-summary-canon-review';
import { CompanionModelError, generateCompanionStructured, type CompanionModelConfig, type CompanionModelOptions } from './model';

type Document = 'proposal' | 'adopted_plan';
export interface ProposalQuantityOperand {
  id: string; document: Document; path: string; kind: 'number' | 'text_number' | 'array_length'; value: number;
  numberIndex?: number; quote?: string; start?: number; end?: number;
}
const ref = z.string().min(1).max(80);
const relation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('equal'), left: ref, right: ref }),
  z.strictObject({ kind: z.literal('sum'), terms: z.array(ref).min(1).max(100), total: ref }),
  z.strictObject({ kind: z.literal('allocation'), pool: ref, recipients: ref, perRecipient: ref.optional(), reserved: z.array(ref).max(100) }),
]);
export const proposalQuantityRelationsSchema = z.strictObject({ claims: z.array(z.strictObject({
  disposition: z.enum(['asserted', 'adopted', 'alternative', 'quoted', 'unknown']),
  evidence: z.strictObject({ path: z.string().max(4096), quote: z.string().min(1).max(4000).optional() }),
  planEvidencePath: z.string().max(4096).optional(), relation: relation.nullable(),
})).max(100), coverage: z.array(z.strictObject({ clauseId: ref,
  classification: z.enum(['relation', 'quantity_only', 'alternative', 'quoted', 'unrelated', 'unknown']),
  claimIndexes: z.array(z.number().int().nonnegative()).max(100),
})).max(500) });
export type ProposalQuantityRelations = z.infer<typeof proposalQuantityRelationsSchema>;
const pointer = (path: string, key: string | number) => path + '/' + String(key).replace(/~/gu, '~0').replace(/\//gu, '~1');
function atPath(document: unknown, path: string): { found: boolean; value?: unknown } {
  if (!path) return { found: true, value: document };
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) return { found: false };
  let value = document;
  for (const token of path.slice(1).split('/')) {
    const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return { found: false };
    value = (value as Record<string, unknown>)[key];
  }
  return { found: true, value };
}
function excludedNumericRanges(text: string) {
  return [...text.matchAll(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b|\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{4}年\d{1,2}月\d{1,2}日|\b\d{1,2}:\d{2}(?::\d{2})?\b/giu)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}
function documentPaths(document: unknown): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (paths.length >= 2000) throw new Error('提案路径超过核验容量，不能省略路径后声称完整核验。');
    paths.push(path);
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, pointer(path, key));
  };
  visit(document, ''); return paths;
}
/** Only exact current document locations are operands. Context and inferred
 * totals never enter this catalog; an array's length is measured by the host. */
export function enumerateProposalQuantities(proposal: unknown, adoptedPlan?: unknown): ProposalQuantityOperand[] {
  const operands: ProposalQuantityOperand[] = [], seen = new Set<object>();
  const add = (operand: Omit<ProposalQuantityOperand, 'id'>) => operands.push({ id: 'q' + operands.length, ...operand });
  const visit = (value: unknown, path: string, document: Document, depth: number) => {
    if (depth > 40 || operands.length >= 2000) throw new Error('当前提案数量位置超过核验容量，不能截取后声称全部一致。');
    if (typeof value === 'number') { if (Number.isSafeInteger(value) && value >= 0) add({ document, path, kind: 'number', value }); return; }
    if (typeof value === 'string') {
      const excluded = excludedNumericRanges(value);
      for (const number of topicQuantityNumberCandidates(value)) {
        if (number.value === null || number.ordinal || excluded.some(range => number.start < range.end && number.end > range.start)
          || /[A-Za-z_]/u.test(value[number.start - 1] ?? '') || /[A-Za-z_]/u.test(value[number.end] ?? '')) continue;
        add({ document, path, kind: 'text_number', value: number.value, numberIndex: number.numberIndex,
          quote: number.numberQuote, start: number.start, end: number.end });
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) throw new Error('数量核验只接受无循环的原始提案。');
    seen.add(value);
    if (Array.isArray(value)) add({ document, path, kind: 'array_length', value: value.length });
    for (const [key, child] of Object.entries(value)) visit(child, pointer(path, key), document, depth + 1);
    seen.delete(value);
  };
  visit(proposal, '', 'proposal', 0);
  if (adoptedPlan !== undefined) visit(adoptedPlan, '', 'adopted_plan', 0);
  return operands;
}
export interface ProposalQuantityClause { id: string; document: Document; path: string; text?: string; start?: number; end?: number;
  operandIds: string[]; explicitRelationSyntax: boolean }
const relationSyntax = /[=＝≠<>]|等于|相等|正好|对(?:得)?上|一一|合计|总计|对应|一人一|每(?:人|位|项|个)|\bequals?\b|\bone[- ]to[- ]one\b|\beach\b|same (?:number|count|length)/iu;
const naturalText = (value: string) => !!value.trim() && !/^[A-Za-z0-9_/:.-]+$/u.test(value.trim());
/** Natural-language subclauses are independent coverage obligations. Raw
 * structure is an object-level candidate only when that document has no text. */
export function enumerateProposalQuantityClauses(proposal: unknown, adoptedPlan?: unknown): ProposalQuantityClause[] {
  const operands = enumerateProposalQuantities(proposal, adoptedPlan), clauses: ProposalQuantityClause[] = [];
  const add = (value: Omit<ProposalQuantityClause, 'id'>) => {
    if (clauses.length >= 500) throw new Error('提案片段超过数量核验容量，不能省略后文。');
    clauses.push({ id: 'c' + clauses.length, ...value });
  };
  const visitText = (value: unknown, path: string, document: Document) => {
    if (typeof value === 'string' && naturalText(value)) {
      for (const sentence of topicSummaryClauses(value, '')) {
        let start = sentence.start;
        const boundaries = [...sentence.text.matchAll(/[，,](?!\d{3}(?:\D|$))/gu)].map(match => sentence.start + match.index + 1);
        for (const end of [...boundaries, sentence.end]) {
          const text = value.slice(start, end), local = operands.filter(operand => operand.document === document && operand.path === path
            && operand.kind === 'text_number' && operand.start! >= start && operand.end! <= end);
          if (text.trim()) add({ document, path, start, end, text, operandIds: local.map(operand => operand.id), explicitRelationSyntax: relationSyntax.test(text) });
          start = end;
        }
      }
      return;
    }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visitText(child, pointer(path, key), document);
  };
  const visitStructure = (value: unknown, path: string, document: Document) => {
    if (!value || typeof value !== 'object') return;
    const direct = operands.filter(operand => operand.document === document && operand.kind !== 'text_number'
      && (operand.path.slice(0, operand.path.lastIndexOf('/')) === path || !path && operand.path === ''));
    if (direct.length && (!Array.isArray(value) || !path))
      add({ document, path, operandIds: direct.map(operand => operand.id), explicitRelationSyntax: false });
    for (const [key, child] of Object.entries(value)) visitStructure(child, pointer(path, key), document);
  };
  const visitDocument = (value: unknown, document: Document) => {
    const before = clauses.length;
    visitText(value, '', document);
    if (clauses.length === before) visitStructure(value, '', document);
  };
  visitDocument(proposal, 'proposal'); if (adoptedPlan !== undefined) visitDocument(adoptedPlan, 'adopted_plan');
  return clauses;
}
const relationIds = (value: z.infer<typeof relation>) => value.kind === 'equal' ? [value.left, value.right]
  : value.kind === 'sum' ? [...value.terms, value.total] : [value.pool, value.recipients, ...(value.perRecipient ? [value.perRecipient] : []), ...value.reserved];
/** Semantic decisions bind relationships and modality only. Every numeric
 * operand is resolved again from this host-built immutable proposal catalog. */
export function validateProposalQuantityRelations(input: { proposal: unknown; adoptedPlan?: unknown }, raw: unknown): { allowed: boolean; reason?: string } {
  const review = proposalQuantityRelationsSchema.parse(raw), operands = enumerateProposalQuantities(input.proposal, input.adoptedPlan);
  const byId = new Map(operands.map(operand => [operand.id, operand]));
  if (review.claims.some(claim => !['asserted', 'adopted'].includes(claim.disposition) && claim.relation !== null))
    throw new Error('备选、引用与未知关系不能冒充当前实际数量等式。');
  const clauses = enumerateProposalQuantityClauses(input.proposal, input.adoptedPlan);
  const adopted = review.claims.filter(claim => claim.disposition === 'adopted').map(claim => claim.planEvidencePath);
  const required = clauses.filter(clause => clause.document === 'proposal' || adopted.some(path => path !== undefined
    && (!path || clause.path === path || clause.path.startsWith(path + '/'))));
  const covered = new Set<string>();
  for (const item of review.coverage) {
    const clause = clauses.find(value => value.id === item.clauseId);
    if (!clause || covered.has(item.clauseId)) throw new Error('coverage必须唯一定位宿主实际clauseId，不能重复或自造片段。');
    covered.add(item.clauseId);
    if (item.claimIndexes.some(index => !review.claims[index])) throw new Error('coverage引用的claimIndexes必须存在。');
    if (!required.some(value => value.id === clause.id)) continue;
    if (item.classification === 'unknown') return { allowed: false, reason: `当前提案片段${clause.id}数量关系尚未核清，不能把未知当成分配一致；请自行明确本次断言或修订方案，未执行。` };
    if (item.classification === 'relation') {
      if (!item.claimIndexes.length) throw new Error('关系片段必须指向实际完整数量关系。');
      const referenced = item.claimIndexes.map(index => review.claims[index]!);
      if (referenced.some(claim => !claim.relation || !['asserted', 'adopted'].includes(claim.disposition))) throw new Error('关系覆盖不能用引用、备选或空关系替代实际断言。');
      const used = new Set(referenced.flatMap(claim => claim.relation ? relationIds(claim.relation) : []));
      if (clause.text !== undefined && clause.operandIds.some(id => !used.has(id))) throw new Error(`片段${clause.id}的实际数字未被其关系引用；前文正确等式不能豁免本片段。`);
      if (clause.text === undefined && !clause.operandIds.some(id => used.has(id))) throw new Error('结构化关系覆盖必须引用该实际对象内的数量，不能借无关对象的等式代替。');
    } else if (item.claimIndexes.length) throw new Error('非关系分类不能附上其它片段的关系冒充本片段已核验。');
    if (item.classification === 'quantity_only' && clause.explicitRelationSyntax && clause.operandIds.length)
      throw new Error(`片段${clause.id}含明确等同/分配关系语法，不能只标纯数量后跳过。`);
    if (item.classification === 'unrelated' && clause.explicitRelationSyntax && clause.operandIds.length)
      throw new Error(`片段${clause.id}含明确等同/分配关系语法，不能标无关后跳过。`);
  }
  if (required.some(clause => !covered.has(clause.id))) throw new Error('coverage必须完整覆盖每个当前提案片段以及本次实际采用的旧计划范围，不能遗漏后半句。');
  for (const claim of review.claims) {
    const witness = atPath(input.proposal, claim.evidence.path);
    if (!witness.found || claim.evidence.quote !== undefined && (typeof witness.value !== 'string' || !witness.value.includes(claim.evidence.quote)))
      throw new Error('数量关系必须定位当前提案真实路径及逐字原文，不接受自写证据。');
    if (!['asserted', 'adopted'].includes(claim.disposition)) {
      if (claim.relation !== null) throw new Error('备选、引用与未知关系不能冒充当前实际数量等式。');
      continue;
    }
    // An asserted scalar fact need not declare an equation. It cannot cover a
    // relational clause (checked above), and adoption still needs a relation.
    if (!claim.relation) {
      if (claim.disposition === 'adopted') throw new Error('采用旧安排的数量关系必须完整绑定，不能用空关系表示核验通过。');
      continue;
    }
    if (typeof witness.value === 'string' && !claim.evidence.quote) throw new Error('文本数量断言须绑定当前提案逐字引文。');
    if (claim.disposition === 'adopted' && (!(typeof witness.value === 'string' || witness.value !== null && typeof witness.value === 'object')
      || claim.planEvidencePath === undefined || input.adoptedPlan === undefined || !atPath(input.adoptedPlan, claim.planEvidencePath).found))
      throw new Error('采用旧计划须有当前提案实际结构化证据或逐字文本证据和候选计划路径；旧状态不是执行事实。');
    const current = claim.relation;
    const ids = relationIds(current);
    const bound = ids.map(id => { const operand = byId.get(id); if (!operand) throw new Error('数量操作数不存在，禁止审核器自写或替换数字。'); return operand; });
    if (claim.disposition === 'asserted' && bound.some(operand => operand.document !== 'proposal')) throw new Error('旧计划数量只能在当前提案明确采用时参与验算。');
    for (const operand of bound) {
      // The exact predicate and the exact numeric premises have independent
      // provenance. A pronoun may refer to an earlier sentence/JSON field.
      // Only adoption restricts premises to a selected old-plan subtree.
      if (operand.document === 'proposal') continue;
      const anchor = claim.planEvidencePath!;
      if (anchor && operand.path !== anchor && !operand.path.startsWith(anchor + '/')) throw new Error('数量操作数必须落在该断言实际选定的证据范围内。');
    }
    if (new Set(ids).size !== ids.length) throw new Error('同一数字位置不能重复充当分项、总数或预留量。');
    const number = (id: string) => byId.get(id)!.value;
    const left = current.kind === 'equal' ? number(current.left) : current.kind === 'sum' ? current.terms.reduce((sum, id) => sum + number(id), 0) : number(current.pool);
    const right = current.kind === 'equal' ? number(current.right) : current.kind === 'sum' ? number(current.total)
      : number(current.recipients) * (current.perRecipient ? number(current.perRecipient) : 1) + current.reserved.reduce((sum, id) => sum + number(id), 0);
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new Error('数量关系运算超出可准确计算的整数范围。');
    if (left !== right) return { allowed: false, reason: `当前提案数量关系不一致（${current.kind}，${bound.map(item => `${item.document}:${item.path || '/'}${item.numberIndex === undefined ? '' : '#number' + item.numberIndex}`).join('、')}）：宿主按原值计算为 ${left} 与 ${right}。请自行核对同一集合、分配人数/每人数量及明确预留项后修订完整提案；未执行，不自动改数或替参与者决定。` };
  }
  return { allowed: true };
}
const system = `只识别exactProposal本次明确断言的数量关系，不替作者计算、补数、修改规则或执行行动。operands由宿主从真实JSON整数、原文完整数词和实际数组长度枚举，关系只能引用其id，不能自写数字。检查sum分项与总数、equal相等声明，以及allocation完整分配：pool=recipients*perRecipient+所有明确reserved；未填perRecipient仅表示原文明确一对一，每人一项，不是任意默认。只把实际同一集合、同时点、同单位、互斥且完整的分项关联起来；不能把主持人数/群成员总数自动当分配人数，也不能把任意相邻数字拼等式。存在明确备用、弃置、未分配项须引用相应reserved操作数；没有原句证据不能猜备用项来圆数。
coverage须完整唯一覆盖actualClauses中每个proposal片段，以及本次adopted关系实际采用的planEvidencePath下旧计划片段。逐个分类：relation必须用claimIndexes引用本片段实际关系；文本关系须引用本分句所有operandIds，前半正确sum不能替后半等量分配作答。纯结构对象只须实际关系引用本对象内数量，不要把所有独立字段强等。有自然语言时只枚举文本片段，不把重复JSON数值叶另当关系。纯列数但未声称任何关系才quantity_only；有明确等同/完整分配谓语且有数量不能标纯数量或无关。引用反驳/备选分别quoted/alternative，非数量片段及‘一起’等不表达实际数量的词汇数词可unrelated，真不能核清unknown不能冒充已核验一致。非relation的claimIndexes=[]。完整原文始终提供，片段切分不改变引用、条件、人物或分支归属。当前无数字但明确采用旧安排时也要给adopted关系并覆盖所采用旧计划的真实关系片段；没有采用则不必核无关旧片段。
每项evidence只选当前exactProposal的真实JSON pointer；字符串断言附逐字连续quote，结构化关系可选实际包含该关系的对象路径。只明确断言用asserted；备选/未来尚未决定、引用他人错话或用于反驳的旧数字、未知关系分别alternative/quoted/unknown且relation=null。候选方案若自身直接断言一个求和等式，可只核其内部等式，不能跨不同候选方案强等或把建议当已实现。同一个原始数字位置只引用一次，不能拿总数又充当分项。每个确定的关系给完整relation；没有关系时claims=[]，不能仅因出现数字就建立关系。
candidateAdoptedPlan若存在只是可修订的旧模型计划，不是真人硬约束、当前事实或授权。只有exactProposal本次明确表示实际继续采用它的那份安排时用adopted，并给当前提案真实证据路径及planEvidencePath（候选旧计划的真实路径）：文本证据必须逐字quote；真实结构化写入可选实际object路径，不伪造采用文本，也不默认每项私人笔记或结构化写入都采用旧计划。才可引用adopted_plan操作数核该被采用安排的内在关系。只是讨论、否定或修订旧计划不采用；不能因旧状态里有数字就强等所有历史数量。无需本提案再次写出数字才能识别明确采用旧安排。只按outputSchema输出，reason不需要也不能自写替代数量。`;
// Exact mathematical classifications only, including contradictions. Source
// ACL, current versions and execution authority remain each caller's checks.
const relationCache = new Map<string, ProposalQuantityRelations>();

export async function reviewCompanionProposalQuantities(input: { proposal: unknown; adoptedPlan?: unknown }, config: CompanionModelConfig,
  signal?: AbortSignal, options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs'> & {
    infer?(context: { system: string; user: string }, signal?: AbortSignal): Promise<unknown>;
  } = {}): Promise<{ allowed: boolean; reason?: string }> {
  const operands = enumerateProposalQuantities(input.proposal, input.adoptedPlan);
  if (operands.length < 2) return { allowed: true };
  const clauses = enumerateProposalQuantityClauses(input.proposal, input.adoptedPlan);
  const structuredCandidate = input.adoptedPlan !== undefined && input.proposal !== null && typeof input.proposal === 'object' && !Array.isArray(input.proposal);
  if (!clauses.length || !structuredCandidate && !operands.some(operand => operand.document === 'proposal' && operand.kind !== 'array_length')
    && !clauses.some(clause => clause.document === 'proposal' && clause.text)) return { allowed: true };
  const proposalPaths = documentPaths(input.proposal), planPaths = input.adoptedPlan === undefined ? [] : documentPaths(input.adoptedPlan);
  const claimSchema = proposalQuantityRelationsSchema.shape.claims.element;
  const requestedClaim = claimSchema.extend({ evidence: claimSchema.shape.evidence.extend({ path: z.enum(proposalPaths as [string, ...string[]]) }),
    planEvidencePath: planPaths.length ? z.enum(planPaths as [string, ...string[]]).optional() : z.never().optional() });
  const requestedSchema = z.strictObject({ claims: z.array(requestedClaim).max(100), coverage: proposalQuantityRelationsSchema.shape.coverage
    .element.extend({ clauseId: z.enum(clauses.map(clause => clause.id) as [string, ...string[]]) }).array().max(500) });
  const cacheKey = options.infer ? undefined : createHash('sha256').update(JSON.stringify(['clause_coverage_v2', config.apiFormat, config.baseUrl,
    config.model, input.proposal, input.adoptedPlan])).digest('hex');
  const cached = cacheKey ? relationCache.get(cacheKey) : undefined;
  if (cached) { relationCache.delete(cacheKey!); relationCache.set(cacheKey!, cached); return validateProposalQuantityRelations(input, cached); }
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const context = { system, user: JSON.stringify({ purpose: 'proposal_quantity_relations', exactProposal: input.proposal,
        ...(input.adoptedPlan === undefined ? {} : { candidateAdoptedPlan: input.adoptedPlan }),
        actualClauses: clauses,
        evidencePathContract: { proposalPaths, candidatePlanPaths: planPaths,
          proposalRootType: Array.isArray(input.proposal) ? 'array' : typeof input.proposal,
          instruction: '路径相对于各实际文档本身，不能加exactProposal/candidateAdoptedPlan传输信封前缀。字符串根只有空字符串路径，不是/、/summary或/exactProposal。',
          ...(typeof input.proposal === 'string' ? { proposalRootEvidenceExample: { path: '', quote: input.proposal.slice(0, 4000) } } : {}) },
        operands: operands.map(({ value: _value, ...reference }) => { void _value; return reference; }),
        outputSchema: z.toJSONSchema(requestedSchema), ...(feedback ? { formatCorrection: feedback } : {}) }) };
      const raw = options.infer ? await options.infer(context, signal) : await generateCompanionStructured(context, config, signal, options);
      const result = validateProposalQuantityRelations(input, requestedSchema.parse(raw));
      if (cacheKey) { relationCache.set(cacheKey, proposalQuantityRelationsSchema.parse(raw));
        if (relationCache.size > 32) relationCache.delete(relationCache.keys().next().value!); }
      return result;
    } catch (error) {
      if (signal?.aborted || error instanceof CompanionModelError && error.code !== 'INVALID_RESPONSE') throw error;
      feedback = (error instanceof Error ? error.message : '数量关系格式或证据未通过宿主核验。')
        + ` 当前proposal类型=${typeof input.proposal}，evidence.path只可从${JSON.stringify(proposalPaths)}选；planEvidencePath只可从${JSON.stringify(planPaths)}选。不得归一化或添加文档信封前缀。`;
      if (attempt === 2) throw new CompanionModelError('INVALID_RESPONSE', '当前提案数量关系无法准确核验，未执行。' + feedback);
    }
  }
  throw new Error('数量关系审核缺失。');
}
