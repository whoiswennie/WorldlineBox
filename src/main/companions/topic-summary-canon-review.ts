import { z } from 'zod';
import { CompanionModelError, generateCompanionStructured, type CompanionModelConfig } from './model';
import { topicCanonSourceProjection, type TopicUserCanon } from './topic-user-canon';
import { reviewTopicSummaryQuantities } from './topic-summary-quantity-review';

type Infer = (context: { system: string; user: string }, signal?: AbortSignal) => Promise<unknown>;
const claimSchema = z.strictObject({ claimQuote: z.string().min(1).max(3000), reason: z.string().min(1).max(1000) });
const auditSchema = z.strictObject({ checks: z.array(z.strictObject({ canonIndex: z.number().int().nonnegative(),
  status: z.enum(['consistent', 'not_asserted', 'contradiction', 'ambiguous']), contradictions: z.array(claimSchema).max(3) })).max(80),
  clauses: z.array(z.strictObject({ clauseIndex: z.number().int().nonnegative(), status: z.enum(['compatible', 'unrelated', 'contradiction', 'ambiguous']),
    canonIndexes: z.array(z.number().int().nonnegative()).max(80) })).max(1000) });
const decisionSchema = z.strictObject({ decisions: z.array(z.strictObject({ issueIndex: z.number().int().nonnegative(),
  decision: z.enum(['upheld', 'rejected', 'ambiguous']), reason: z.string().min(1).max(1000) })).max(240) });
interface Options { canon: TopicUserCanon; summary: string; stage: string; config: CompanionModelConfig; signal?: AbortSignal;
  fetchFn?: typeof fetch; audit?: Infer; adjudicate?: Infer; scope?: { ownerId: string; conversationId: string; topicId: string } }

/** Exact host passages force examination of every actual assertion, including
 * later text after an initially correct constraint list. Splits do not assert
 * authorship; the reviewer still receives the complete proposed text. */
export function topicSummaryClauses(summary: string, stage: string) {
  const text = [summary, stage].join('\n'), result: Array<{ clauseIndex: number; start: number; end: number; text: string }> = [];
  let start = 0; const closers: string[] = [], pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '(': ')', '（': '）' };
  const append = (end: number) => {
    const span = text.slice(start, end), trimmed = span.trim(), offset = span.indexOf(trimmed);
    if (trimmed) result.push({ clauseIndex: result.length, start: start + offset, end: start + offset + trimmed.length, text: trimmed });
    start = end;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (closers.at(-1) === char) closers.pop(); else if (pairs[char]) closers.push(pairs[char]!);
    if (char === '\n' || !closers.length && /[。！？；;]/u.test(char)) append(index + 1);
  }
  append(text.length); return result;
}

/** Summary-specific semantic check. Complete canon coverage prevents a correct
 * hard-fact list from concealing an incompatible free sentence elsewhere.
 * Quotes/indexes prove provenance only; a second narrow review decides whether
 * each alleged contradiction is actually entailed. No rewritten prose is made. */
export async function reviewTopicSummaryCanon(input: Options): Promise<string | undefined> {
  if (!input.canon.entries.length) return undefined;
  const source = topicCanonSourceProjection(input.canon), proposed = { summary: input.summary, stage: input.stage };
  const text = [input.summary, input.stage].join('\n');
  const clauses = topicSummaryClauses(input.summary, input.stage);
  const quantityCorrection = await reviewTopicSummaryQuantities({ ...input, clauses });
  if (quantityCorrection) return quantityCorrection;
  const infer = (context: { system: string; user: string }, schema: z.ZodType, alternate?: Infer) => alternate ? alternate(context, input.signal)
    : generateCompanionStructured(context, input.config, input.signal, { fetchFn: input.fetchFn, timeoutMs: 120000, responseSchema: schema,
      repairPreserveCollections: schema === auditSchema
        ? [{ path: ['checks'], fields: ['canonIndex', 'status', 'contradictions'] }, { path: ['clauses'], fields: ['clauseIndex', 'status', 'canonIndexes'] }]
        : [{ path: ['decisions'], fields: ['issueIndex', 'decision'] }] });
  const data = { purpose: 'topic_summary_canon_audit', canon: source.entries.map((entry, canonIndex) => ({ canonIndex, ...entry })), proposed, actualClauses: clauses,
    outputSchema: z.toJSONSchema(auditSchema) };
  let audit: z.infer<typeof auditSchema> | undefined, feedback: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      audit = auditSchema.parse(await infer({ system: '你只审查一份有界工作摘要与独立逐字用户约束的语义一致性，不写摘要、不提出新规则。两套检查都必须完整：checks对每条canon一个，canonIndex精确完整唯一覆盖；clauses对每个actualClauses一个，clauseIndex精确完整唯一覆盖。先逐片段核它本身的断言：compatible=涉及canon且相符；unrelated=不涉及canon；ambiguous=歧义不能证明违反；contradiction=本片段与相关canon不能同时为真，canonIndexes填实际相关的约束编号。不得拿其它片段中正确的规则替本片段作答；一处正确写总数，不豁免后来将它写成实际带齐。完整proposed用于核说话者和语境，片段切分不是新的事实归属。checks的consistent=拟稿相关断言相符；not_asserted=未重复该规则且无冲突；contradiction=拟稿有实际冲突；ambiguous=不足以证实。仅checks的contradiction带非空contradictions，其余为空。区分数量的本体/总数/目前持有/缺失/已用/预留，计划与实际、未来承诺与履行、未知与已知，以及人物对白或猜测与叙述者确定事实；不能把某人声称的数字升级为实际持有。明确归属于人物的话语不等于叙述事实，不仅因说法与canon有异就拒。claimQuote逐字连续来自拟稿。不可因新创作未在canon出现或摘要没有全文重复canon而拒绝，歧义不可猜成矛盾。',
        user: JSON.stringify({ ...data, ...(feedback ? { formatCorrection: feedback } : {}) }) }, auditSchema, input.audit));
      const indexes = audit.checks.map(check => check.canonIndex);
      if (indexes.length !== source.entries.length || new Set(indexes).size !== indexes.length || indexes.some(index => !source.entries[index])) throw new Error('checks必须完整且唯一覆盖实际canonIndex。');
      for (const check of audit.checks) {
        if ((check.status === 'contradiction') !== (check.contradictions.length > 0)) throw new Error('只有contradiction状态带非空矛盾列表。');
        if (check.contradictions.some(issue => !text.includes(issue.claimQuote))) throw new Error('claimQuote不是拟稿逐字连续引文。');
      }
      const clauseIndexes = audit.clauses.map(check => check.clauseIndex);
      if (clauseIndexes.length !== clauses.length || new Set(clauseIndexes).size !== clauseIndexes.length || clauseIndexes.some(index => !clauses[index])) throw new Error('clauses必须完整且唯一覆盖实际clauseIndex，不能漏掉后文。');
      for (const check of audit.clauses) if (check.canonIndexes.some(index => !source.entries[index])
        || check.status === 'contradiction' && !check.canonIndexes.length) throw new Error('片段的相关canonIndexes必须真实，contradiction不可缺其实际约束来源。');
      break;
    } catch (error) {
      if (error instanceof CompanionModelError && error.diagnostic === 'structured_repair_exhausted') throw error;
      if (input.signal?.aborted || !(error instanceof z.ZodError || error instanceof Error && !(error instanceof CompanionModelError)
        || error instanceof CompanionModelError && error.code === 'INVALID_RESPONSE')) throw error;
      if (attempt === 2) throw new CompanionModelError('INVALID_RESPONSE', '工作摘要canon审查无法形成完整来源绑定结果，未推进水位。');
      feedback = error instanceof Error ? error.message : '无效审查结构'; audit = undefined;
    }
  }
  if (!audit) throw new Error('工作摘要canon审查缺失，未推进水位。');
  const fromCanon = audit.checks.flatMap(check => check.contradictions.map(issue => ({ canonIndex: check.canonIndex,
    canonQuote: source.entries[check.canonIndex]!.quote, sourceMessageId: source.entries[check.canonIndex]!.sourceMessageId,
    ...issue })));
  const fromClauses = audit.clauses.filter(check => check.status === 'contradiction').flatMap(check => check.canonIndexes.map(canonIndex => ({
    canonIndex, canonQuote: source.entries[canonIndex]!.quote, sourceMessageId: source.entries[canonIndex]!.sourceMessageId,
    claimQuote: clauses[check.clauseIndex]!.text, reason: '对本片段独立分类为与该canon不能并存，须逐字复核其实际断言。' })));
  const issues = [...new Map([...fromCanon, ...fromClauses].map(issue => [JSON.stringify([issue.canonIndex, issue.claimQuote]), issue])).values()];
  if (!issues.length) return undefined;
  let decision: z.infer<typeof decisionSchema> | undefined; feedback = undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      decision = decisionSchema.parse(await infer({ system: '你独立复核已经提出的工作摘要矛盾，不能新增问题、创作正文或改变用户规则。只根据给定逐字canonQuote、拟稿全文与实际claimQuote判定该问题是否成立。返回每个issueIndex一次完整decision。upheld=拟稿有清楚断言与该用户原句不能并存；rejected=没有矛盾；ambiguous=依赖未获给定证据的猜测。特别核数量的总量与目前持有/缺失不能偷换，计划不等于完成，对白明确归属不等于叙述者事实。摘要其他地方正确抄规则，仍不能抵消另一句的实际冲突。允许合法省略独立canon的重复和新创作，不以未写即禁止。不给替代句，只说明已有问题是否有证据。',
        user: JSON.stringify({ purpose: 'topic_summary_canon_issue_adjudication', proposed, issues: issues.map((issue, issueIndex) => ({ issueIndex, ...issue })),
          outputSchema: z.toJSONSchema(decisionSchema), ...(feedback ? { formatCorrection: feedback } : {}) }) }, decisionSchema, input.adjudicate));
      const indexes = decision.decisions.map(item => item.issueIndex);
      if (indexes.length !== issues.length || new Set(indexes).size !== indexes.length || indexes.some(index => !issues[index])) throw new Error('decisions必须完整且唯一覆盖实际issueIndex。');
      break;
    } catch (error) {
      if (error instanceof CompanionModelError && error.diagnostic === 'structured_repair_exhausted') throw error;
      if (input.signal?.aborted || !(error instanceof z.ZodError || error instanceof Error && !(error instanceof CompanionModelError)
        || error instanceof CompanionModelError && error.code === 'INVALID_RESPONSE')) throw error;
      if (attempt === 2) throw new CompanionModelError('INVALID_RESPONSE', '工作摘要canon矛盾复核无法完整对应原问题，未推进水位。');
      feedback = error instanceof Error ? error.message : '无效复核结构'; decision = undefined;
    }
  }
  const upheld = decision!.decisions.filter(item => item.decision === 'upheld').map(item => ({ ...issues[item.issueIndex], reviewReason: item.reason }));
  return upheld.length ? '当前工作摘要存在与逐字用户约束不能并存的实际断言；请在同一来源重新整合，保留其它正确状态，不把人物对白/总数/计划升级为实际事实。上一份未提交，水位未推进。\n' + JSON.stringify(upheld) : undefined;
}
