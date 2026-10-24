import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanionReplyInput } from './context';
import { CompanionModelError, generateCompanionStructured, type CompanionModelConfig } from './model';
import { companionTopicLatestPublication } from './topic-publication-reference';

type Frame = Pick<CompanionReplyInput, 'companion' | 'conversation' | 'topic' | 'messages' | 'topicPublicationReference'>;
type Infer = (context: { system: string; user: string }, signal?: AbortSignal) => Promise<unknown>;
const candidateSchema = z.object({ sourceMessageId: z.string().min(1), subjectName: z.string().min(1).max(80),
  quote: z.string().min(1).max(1600), referencePronoun: z.enum(['他', '她']), referenceOccurrence: z.number().int().min(0).max(80),
  decision: z.enum(['accept', 'ambiguous', 'reject']) });
const extractionSchema = z.object({ references: z.array(candidateSchema).max(6) });
const reviewSchema = z.object({ decisions: z.array(z.object({ index: z.number().int().nonnegative(),
  decision: z.enum(['accept', 'ambiguous', 'reject']), reason: z.string().min(1).max(800) })).max(6) });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const REFERENCE_PROTOCOL = 'verbatim_unquoted_passages_v3_local_subject_candidate_windows';
export interface TopicNarrativeReference {
  subjectName: string; sourceMessageId: string; sourceChecksum: string; sourceSequence: number;
  quote: string; quoteStart: number; quoteEnd: number; nameStart: number; nameEnd: number;
  referenceStart: number; referenceEnd: number; sourcePronoun: '他' | '她';
  bindingMethod: 'extraction_and_independent_source_only_semantic_review';
}
export interface TopicNarrativeReferences {
  status: 'no_formal_source' | 'reviewed' | 'abstained';
  scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger';
  selectedSources: Array<{ id: string; checksum: string; sequence: number }>;
  references: TopicNarrativeReference[];
  conflicts: Array<{ subjectName: string; sourceMessageIds: string[] }>;
  /** Literal candidate evidence only. These entries never bind an identity. */
  diagnostics?: Array<{ candidateSubjectName: string; sourceMessageId: string; sourceChecksum: string; quote: string;
    referenceStart: number; literalPronoun: '他' | '她'; reason: string }>;
  diagnosticRule?: string;
}
const cache = new Map<string, TopicNarrativeReferences>();

/** Literal offsets authenticate evidence only. Coreference remains a semantic
 * approximation, independently reviewed; uncertainty produces no declaration. */
export async function prepareTopicNarrativeReferences(input: { frame: Frame; config: CompanionModelConfig; signal?: AbortSignal;
  fetchFn?: typeof fetch; extract?: Infer; review?: Infer }): Promise<TopicNarrativeReferences> {
  const { frame } = input;
  const latest = companionTopicLatestPublication(frame);
  const selected = frame.topic?.kind !== 'story' || frame.topic.status !== 'active' || frame.topic.conversationId !== frame.conversation.id
    || !frame.topic.participantIds.includes(frame.companion.id) ? [] : frame.messages.filter(message => message.conversationId === frame.conversation.id
      && message.topicId === frame.topic!.id && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft
      && message.authorId !== 'user' && message.authorId !== 'system').sort((a, b) => a.sequence - b.sequence).slice(-3);
  if (latest) {
    const previous = selected.filter(message => message.id !== latest.id).slice(-2);
    selected.splice(0, selected.length, ...previous, latest);
  }
  const base = { scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger' as const,
    selectedSources: selected.map(message => ({ id: message.id, checksum: hash(message.content), sequence: message.sequence })), references: [], conflicts: [],
    diagnosticRule: '只有references是已核对的实际指代候选；diagnostics和conflicts是未确证/冲突的原句诊断，不能拿candidateSubjectName和literalPronoun组合成任何确定人物身份或性别规则。独立用户明确身份约束仍以原始canon为准。' };
  if (!selected.length) return { ...base, status: 'no_formal_source' };
  const passages = new Map(selected.map(source => [source.id, [...source.content.matchAll(/[^\r\n]+/gu)]
    .filter(match => /[他她]/u.test(match[0]) && !/[“”「」『』‘’"]/u.test(match[0]))
    .map(match => ({ start: match.index!, end: match.index! + match[0].length, text: match[0] }))]));
  const keyFor = (source: typeof selected[number]) => hash(JSON.stringify([REFERENCE_PROTOCOL, frame.companion.id, frame.conversation.id, frame.topic!.id,
    input.config.apiFormat, input.config.model, input.config.baseUrl, source.id, hash(source.content), source.sequence, passages.get(source.id)]));
  const useCache = !input.extract && !input.review;
  const previous = useCache ? selected.flatMap(source => cache.get(keyFor(source))?.references ?? []) : [];
  const previousDiagnostics = useCache ? selected.flatMap(source => cache.get(keyFor(source))?.diagnostics ?? []) : [];
  const sources = useCache ? selected.filter(source => !cache.has(keyFor(source))) : selected;
  const combine = (fresh: TopicNarrativeReference[], diagnostics: NonNullable<TopicNarrativeReferences['diagnostics']> = []): TopicNarrativeReferences => {
    const references = [...previous, ...fresh].sort((a, b) => a.sourceSequence - b.sourceSequence || a.quoteStart - b.quoteStart);
    const conflicts = [...new Set(references.map(item => item.subjectName))].flatMap(subjectName => new Set(references.filter(item => item.subjectName === subjectName).map(item => item.sourcePronoun)).size > 1
      ? [{ subjectName, sourceMessageIds: [...new Set(references.filter(item => item.subjectName === subjectName).map(item => item.sourceMessageId))] }] : []);
    const uncertain = new Set(conflicts.map(conflict => conflict.subjectName));
    const active = references.filter(reference => !uncertain.has(reference.subjectName));
    return { ...base, status: active.length ? 'reviewed' : 'abstained', references: active, conflicts,
      diagnostics: [...previousDiagnostics, ...diagnostics, ...references.filter(reference => uncertain.has(reference.subjectName)).map(reference => ({
        candidateSubjectName: reference.subjectName, sourceMessageId: reference.sourceMessageId, sourceChecksum: reference.sourceChecksum,
        quote: reference.quote, referenceStart: reference.referenceStart, literalPronoun: reference.sourcePronoun,
        reason: '实际来源候选互相冲突，不能选择其中一个当作确定人物指代。' }))] };
  };
  if (!sources.length) return structuredClone(combine([]));
  const infer = (context: { system: string; user: string }, transport?: Infer) => transport ? transport(context, input.signal)
    : generateCompanionStructured(context, input.config, input.signal, { fetchFn: input.fetchFn, timeoutMs: 120000 });
  const save = (result: TopicNarrativeReferences) => {
    if (useCache) {
      for (const source of sources) cache.set(keyFor(source), structuredClone({ ...result,
        selectedSources: base.selectedSources.filter(item => item.id === source.id), references: result.references.filter(item => item.sourceMessageId === source.id), conflicts: [],
        diagnostics: result.diagnostics?.filter(item => item.sourceMessageId === source.id) }));
      while (cache.size > 128) cache.delete(cache.keys().next().value!);
    }
    return combine(result.references, result.diagnostics);
  };
  // Candidate selection is deliberately not entity resolution. The extractor
  // sees small verbatim narrative passages; the independent reviewer still
  // checks each candidate against its own full source before it can be used.
  const extractionSources = sources.map(source => ({ id: source.id, sequence: source.sequence,
    candidatePassages: (passages.get(source.id) ?? []).flatMap(passage => {
      const cuts = [...new Set([0, ...[...passage.text.matchAll(/[。！？；;]/gu)].map(match => match.index! + 1), passage.text.length])];
      return cuts.slice(0, -1).flatMap((_cut, index) => {
        const start = cuts[Math.max(0, index - 1)]!, end = cuts[index + 1]!, text = passage.text.slice(start, end);
        // Candidate qualification is not entity resolution. Keep original
        // offsets and let the independent reader inspect the full source.
        if (!/(?:^|[。！？；;，,])\s*[他她]/u.test(text) || /他/u.test(text) && /她/u.test(text)) return [];
        return [{ start: passage.start + start, end: passage.start + end, text }];
      });
    }) }));
  if (extractionSources.every(source => source.candidatePassages.length === 0)) return save({ ...base, status: 'abstained' });
  try {
    input.signal?.throwIfAborted();
    const raw = await infer({ system: `从实际小说原文选择人物代词回指候选，不判断生物性别，不写小说。每条source优先反复出现的实名人物，勿只选衣着描述的配角。同一实名人物存在多个不同用字或歧义候选时保留它们，不以第一句覆盖后文明确指代；全部仍至多6项。返回JSON outputSchema。
每项：sourceMessageId、具名subjectName、同一candidatePassage中同时含名字和代词的逐字连续quote、原字referencePronoun（他/她）、该字在quote中从0起的referenceOccurrence、decision。候选段只是实际原文筛选，并未证明语法关系；不跨候选段拼句，不借别条source消歧。
具名人物的动作/身体动作接续清楚可accept，如“甲没有上前。他举灯。”、“甲握灯的手一紧。他的戒指暗了。”。原文其它位置有人物不自动否定局部绑定。
名字与代词之间换主语则不能绑回原人：“甲停下。短斗篷没动。他站着”不绑甲；“甲看向乙，他…”有受事歧义。引语、假设、叙述者切换或多个可能所指均ambiguous/reject。名字与唯一他/她同现不是绑定证据。无可靠项返回空数组。`,
      user: JSON.stringify({ purpose: 'topic_narrative_reference_extract', sources: extractionSources,
        outputSchema: z.toJSONSchema(extractionSchema, { io: 'input' }) }) }, input.extract);
    const parsed = extractionSchema.safeParse(raw);
    if (!parsed.success) return save({ ...base, status: 'abstained' });
    const candidates = parsed.data.references.filter(item => item.decision !== 'reject').flatMap(item => {
      const source = sources.find(message => message.id === item.sourceMessageId);
      if (!source) return [];
      const quoteStart = source.content.indexOf(item.quote), nameOffset = item.quote.indexOf(item.subjectName);
      const pronouns = [...item.quote.matchAll(new RegExp(item.referencePronoun, 'gu'))];
      if (quoteStart < 0 || source.content.lastIndexOf(item.quote) !== quoteStart || nameOffset < 0
        || item.quote.lastIndexOf(item.subjectName) !== nameOffset || !pronouns[item.referenceOccurrence]) return [];
      const referenceStart = quoteStart + pronouns[item.referenceOccurrence]!.index!;
      const nameStart = quoteStart + nameOffset, nameEnd = nameStart + item.subjectName.length;
      if (/^[我你他她它您咱]+$/u.test(item.subjectName) || referenceStart < nameEnd && referenceStart + 1 > nameStart) return [];
      if (!passages.get(source.id)?.some(passage => quoteStart >= passage.start && quoteStart + item.quote.length <= passage.end)) return [];
      return [{ subjectName: item.subjectName, sourceMessageId: source.id, sourceChecksum: hash(source.content), sourceSequence: source.sequence,
        quote: item.quote, quoteStart, quoteEnd: quoteStart + item.quote.length, nameStart,
        nameEnd, referenceStart, referenceEnd: referenceStart + 1,
        sourcePronoun: item.referencePronoun, bindingMethod: 'extraction_and_independent_source_only_semantic_review' as const }];
    }).filter((candidate, index, all) => !all.slice(0, index).some(item => item.sourceMessageId === candidate.sourceMessageId
      && item.nameStart === candidate.nameStart && item.referenceStart === candidate.referenceStart));
    if (!candidates.length) return save({ ...base, status: 'abstained' });
    const confirmed = reviewSchema.safeParse(await infer({ system: `你独立核对候选名字与代词的真实语法/动作指代绑定，只读完整原小说消息，不看旧摘要、用户canon解释或抽取者理由。返回每个候选index的accept/ambiguous/reject和reason。
只有名字是该他/她唯一明确所指才accept；只确认实际字面指代，不要求证明人物生物性别。offset/逐字引用只能证明字面存在，不能证明语法正确。具名主体到候选代词之间若有另一人物/那人/短斗篷成为主语，代词应随新主语，不能绑回原名字；原文其它位置另有人物不自动否定局部绑定。“甲看向乙，他……”有受事先行词歧义，应ambiguous；直接引语、假设、叙述层切换、回忆换人或无法排除多个所指都ambiguous/reject。相邻句同主体无换人且动作/身体接续清楚才可accept，例如“甲没有上前。他举灯。”或“甲握灯的手一紧。他的戒指暗了。”。每个候选只用自己source单条原文核对，不借其它source消歧。不能为了必须提供锚而猜。`,
      user: JSON.stringify({ purpose: 'topic_narrative_reference_review', candidates: candidates.map(candidate => ({
        sourceMessageId: candidate.sourceMessageId, subjectName: candidate.subjectName, quote: candidate.quote, sourcePronoun: candidate.sourcePronoun,
        quoteStart: candidate.quoteStart, quoteEnd: candidate.quoteEnd, nameStart: candidate.nameStart, nameEnd: candidate.nameEnd,
        referenceStart: candidate.referenceStart, referenceEnd: candidate.referenceEnd })),
        sources: sources.map(message => ({ id: message.id, sequence: message.sequence, content: message.content })), outputSchema: z.toJSONSchema(reviewSchema) }) }, input.review));
    if (!confirmed.success || confirmed.data.decisions.length !== candidates.length || new Set(confirmed.data.decisions.map(item => item.index)).size !== candidates.length
      || confirmed.data.decisions.some(item => item.index >= candidates.length)) return save({ ...base, status: 'abstained' });
    const diagnostics: NonNullable<TopicNarrativeReferences['diagnostics']> = [];
    const references = candidates.filter((item, index) => {
      const decision = confirmed.data.decisions.find(review => review.index === index)!;
      // Mixed third-person wording is a complex source binding, not a host
      // grammar proof. Two agreeing models still cannot make that uncertainty
      // an absolute identity constraint. Clear single-reference candidates for
      // the same named person remain available and are independently reviewed.
      const beforeReference = item.quote.slice(0, item.referenceStart - item.quoteStart);
      const localLead = beforeReference.slice(Math.max(...['。', '！', '？', '；', ';', '，', ','].map(mark => beforeReference.lastIndexOf(mark))) + 1).trim();
      // A pronoun buried in an object/possessive phrase is not a host-qualified
      // subject anchor (e.g. '甲看了他一眼'). This only withholds an identity
      // inference; it does not claim that punctuation proves coreference.
      const complex = /他/u.test(item.quote) && /她/u.test(item.quote) || localLead.length > 0;
      if (decision.decision === 'accept' && !complex) return true;
      diagnostics.push({ candidateSubjectName: item.subjectName, sourceMessageId: item.sourceMessageId, sourceChecksum: item.sourceChecksum,
        quote: item.quote, referenceStart: item.referenceStart, literalPronoun: item.sourcePronoun,
        reason: complex ? '同一候选包含不同第三人称或主体视点切换，保留原句但不确立人物指代。' : '独立来源语义复核未确认唯一指代：' + decision.reason });
      return false;
    });
    return save({ ...base, status: references.length ? 'reviewed' : 'abstained', references, conflicts: [], diagnostics });
  } catch (error) {
    if (error instanceof CompanionModelError && error.code === 'INVALID_RESPONSE' && !input.signal?.aborted) return save({ ...base, status: 'abstained' });
    throw error;
  }
}
