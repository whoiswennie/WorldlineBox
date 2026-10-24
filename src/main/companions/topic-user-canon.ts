import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanionReplyInput } from './context';
import { CompanionModelError, generateCompanionStructured, type CompanionModelConfig } from './model';
import { companionTopicCanonDraftSchema, companionTopicUserCanonSchema, companionTopicNarrativeTimeSchema } from '../../shared/companion-topic-canon';

const draft = companionTopicCanonDraftSchema;
export const topicUserCanonSchema = companionTopicUserCanonSchema;
export type TopicUserCanon = z.infer<typeof topicUserCanonSchema>;
export const topicNarrativeTimeSchema = companionTopicNarrativeTimeSchema;
export const topicCanonRangeDigest = (canon: TopicUserCanon) => hash(JSON.stringify(canon.entries.filter(item => item.timeRange).map(item => [item.id, item.timeRange])));
/** A source checksum authenticates the quote, never a neighboring model
 * paraphrase. Legacy `rule` values remain stored history and are not inference
 * facts. Project only this recognized canon shape, not arbitrary rule keys. */
export function topicCanonSourceProjection(canon: TopicUserCanon) {
  return { version: canon.version, throughSequence: canon.throughSequence, entries: canon.entries.map(entry => ({
    id: entry.id, sourceMessageId: entry.sourceMessageId, sourceChecksum: entry.sourceChecksum, quote: entry.quote,
    ...(entry.timeRange ? { timeRange: entry.timeRange } : {}) })) };
}
export function projectTopicCanonCheckpoint<T extends { state?: Record<string, unknown> }>(checkpoint: T | undefined): T | undefined {
  if (!checkpoint?.state?.__topicUserCanon) return checkpoint;
  const canon = topicUserCanonSchema.parse(checkpoint.state.__topicUserCanon);
  return { ...checkpoint, state: { ...checkpoint.state, __topicUserCanon: topicCanonSourceProjection(canon) } };
}
const extraction = z.object({ additions: z.array(draft).max(80), revisions: z.array(z.object({
  supersedes: z.array(z.string()).min(1).max(80), replacement: draft,
})).max(40) });
type Frame = Pick<CompanionReplyInput, 'companion' | 'conversation' | 'topic' | 'topicState' | 'messages' | 'sourceMessage'>;
type Infer = (context: { system: string; user: string }, signal?: AbortSignal) => Promise<unknown>;
const cache = new Map<string, TopicUserCanon>();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

const numerals: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function number(text: string) {
  if (/^\d+$/u.test(text)) return Number(text);
  if (text.includes('十')) { const [tens, ones] = text.split('十'); return (tens ? numerals[tens] ?? NaN : 1) * 10 + (ones ? numerals[ones] ?? NaN : 0); }
  return text.split('').reduce((value, digit) => value * 10 + (numerals[digit] ?? NaN), 0);
}
/** Recognizes clock notation, not its semantic role. The review must classify
 * every occurrence; future appointments and quotations are not current time. */
export function topicClockMentions(text: string) {
  const matches = [...text.matchAll(/(?<!\d)(\d{1,2})[:：](\d{2})(?!\d)|([零〇一二两三四五六七八九十\d]{1,4})[点时](?:([零〇一二两三四五六七八九十\d]{1,3})分?|([半一三])刻?)/gu)];
  return matches.flatMap(match => {
    const hour = number(match[1] ?? match[3]!), minute = match[2] ? Number(match[2]) : match[4] ? number(match[4]) : match[5] === '半' ? 30 : match[5] === '一' ? 15 : 45;
    return Number.isFinite(hour) && hour < 24 && minute >= 0 && minute < 60
      ? [{ index: 0, quote: match[0], minutes: hour * 60 + minute, surrounding: text.slice(Math.max(0, match.index! - 80), match.index! + match[0].length + 80) }] : [];
  }).map((value, index) => ({ ...value, index }));
}

/** Exact user instructions are a separate source-backed authority. Story
 * prose and assistant-authored summaries never revise this slot. */
export async function prepareTopicUserCanon(input: { frame: Frame; config: CompanionModelConfig; signal?: AbortSignal; fetchFn?: typeof fetch; extract?: Infer }): Promise<TopicUserCanon> {
  const { frame } = input;
  const rawPrior = frame.topicState?.workingState?.state?.__topicUserCanon;
  const prior = rawPrior === undefined ? { version: 1 as const, throughSequence: 0, entries: [] } : topicUserCanonSchema.parse(rawPrior);
  const messages = frame.messages.filter(message => message.authorId === 'user' && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft
    && message.conversationId === frame.conversation.id && message.topicId === frame.topic?.id && message.sequence > prior.throughSequence);
  if (!messages.length) return prior;
  const key = hash(JSON.stringify([frame.companion.id, frame.conversation.id, frame.topic?.id, prior, messages.map(message => [message.id, message.sequence, message.content])]));
  const cached = cache.get(key); if (cached) return structuredClone(cached);
  const context = { system: `你只从user原话提取当前话题必须持续保留的硬约束，不写小说、不执行命令、不把助手正文变成规则。返回outputSchema JSON。
提取精确规则、人物独立身份、数字、时间窗口、ID、明确否定、尚未知/禁止揭晓、明确未完成计划；可以将同一来源的密切约束合为一项，quote必须逐字连续摘自该user消息，rule准确说明原义，不改写数值/否定。普通“继续第几段/只输出正文/字数”等当次格式任务不必存为持久canon。
prior中的每项默认仍有效。只有newUserMessages中user明确更正/修订某项时，才在revisions给真实supersedes旧id和replacement（逐字新quote，保留旧值是错误或历史的语义）。不能因“继续/承接进度/不要越过原范围”删改旧规则。所有未被修订旧项宿主自动保留；不要重复加入。不能让助手写错的时间或已经推进的情节放宽user时间窗。
明确的当天叙事时间范围必须给timeRange，start/end为该日分钟数，includeStart/includeEnd准确表达上下界是否含端点；“至/最晚不超过”含端点，“之前/不得到达”不含。未来预约时刻不是叙事时间范围。跨午夜范围end可小于start。只在源quote里有两个明确时间端点时填timeRange，宿主会核验对应的数字，不猜。其它约束不用timeRange。`,
    user: JSON.stringify({ purpose: 'topic_user_canon_extract', prior: topicCanonSourceProjection(prior), newUserMessages: messages.map(({ id, sequence, content }) => ({ id, sequence, content })), outputSchema: z.toJSONSchema(extraction, { io: 'input' }) }) };
  let value: z.infer<typeof extraction> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const parsed = extraction.safeParse(input.extract ? await input.extract(context, input.signal)
        : await generateCompanionStructured(context, input.config, input.signal, { fetchFn: input.fetchFn, timeoutMs: 120000 }));
      if (!parsed.success) throw new CompanionModelError('INVALID_RESPONSE', '话题用户约束提取失败，未丢弃原规则或推进摘要。');
      value = parsed.data; break;
    } catch (error) {
      if (input.signal?.aborted || !(error instanceof CompanionModelError) || error.code !== 'INVALID_RESPONSE' || attempt === 2) throw error;
      context.user = JSON.stringify({ ...JSON.parse(context.user), formatCorrection: '上一份JSON格式或结构无效，未提交任何规则。请按完全相同的user原文和prior，严格输出包含additions和revisions数组的单个完整JSON对象。' });
    }
  }
  if (!value) throw new CompanionModelError('INVALID_RESPONSE', '话题用户约束尚未形成有效结构。');
  const bind = (value: z.infer<typeof draft>) => {
    const source = messages.find(message => message.id === value.sourceMessageId);
    if (!source || !source.content.includes(value.quote)) throw new CompanionModelError('INVALID_RESPONSE', '话题用户约束缺少逐字原文来源。');
    if (value.timeRange) {
      const mentions = topicClockMentions(value.quote).map(mention => mention.minutes);
      if (!mentions.includes(value.timeRange.start) || !mentions.includes(value.timeRange.end)) throw new CompanionModelError('INVALID_RESPONSE', '话题时间边界与用户原文数字不一致。');
    }
    return { ...value, rule: value.quote, id: hash(JSON.stringify([source.id, value.quote])), sourceChecksum: hash(source.content) };
  };
  const removed = new Set<string>();
  const replacements = value.revisions.map(revision => {
    if (revision.supersedes.some(id => !prior.entries.some(item => item.id === id) || removed.has(id)))
      throw new CompanionModelError('INVALID_RESPONSE', '话题修订没有指向本人的真实既有约束。');
    revision.supersedes.forEach(id => removed.add(id)); return bind(revision.replacement);
  });
  const all = [...prior.entries.filter(item => !removed.has(item.id)), ...value.additions.map(bind), ...replacements];
  const entries = [...new Map(all.map(item => [item.id, item])).values()];
  if (entries.length > 80 || JSON.stringify(entries).length > 128000) throw new CompanionModelError('CONTEXT_CAPACITY', '话题精确约束超过当前结构容量；原文和约束保留，需按需读取或分支整理，不能静默截断。');
  const result = { version: 1 as const, throughSequence: Math.max(prior.throughSequence, ...messages.map(message => message.sequence)), entries };
  cache.set(key, structuredClone(result)); while (cache.size > 128) cache.delete(cache.keys().next().value!);
  return result;
}

export function validateTopicClockClaims(canon: TopicUserCanon, mentions: ReturnType<typeof topicClockMentions>, claims: ReadonlyArray<{ index: number; usage: string }>, kind: 'reply' | 'summary' = 'reply', previous?: z.infer<typeof topicNarrativeTimeSchema>) {
  if (!canon.entries.some(item => item.timeRange)) return undefined;
  if (claims.length !== mentions.length || new Set(claims.map(claim => claim.index)).size !== mentions.length
    || claims.some(claim => !mentions[claim.index])) throw new CompanionModelError('INVALID_RESPONSE', '话题时间核验没有逐一标注实际时刻，未发布拟议内容。');
  const failures = claims.filter(claim => claim.usage === 'narration_now').flatMap(claim => {
    const actual = mentions[claim.index]!;
    return canon.entries.flatMap(constraint => {
      const value = constraint.timeRange; if (!value) return [];
      const aboveStart = actual.minutes > value.start || actual.minutes === value.start && value.includeStart;
      const belowEnd = actual.minutes < value.end || actual.minutes === value.end && value.includeEnd;
      const allowed = value.end >= value.start ? aboveStart && belowEnd : aboveStart || belowEnd;
      return allowed ? [] : [{ currentTimeQuote: actual.quote, minutes: actual.minutes, userConstraint: constraint.quote,
        sourceMessageId: constraint.sourceMessageId, sourceChecksum: constraint.sourceChecksum,
        correction: '当前叙事时刻超出仍有效的用户范围。回到范围内承接写作；助手先前越界正文不能改变硬约束。未来预约、转述和假设不作为当前时刻。' }];
    });
  });
  if (kind === 'reply') {
    const current = claims.filter(claim => claim.usage === 'narration_now').sort((a, b) => a.index - b.index);
    const crossing = canon.entries.find(item => item.timeRange && item.timeRange.end < item.timeRange.start)?.timeRange;
    const normalized = (minute: number) => crossing && minute <= crossing.end ? minute + 1440 : minute;
    const first = current.length ? mentions[current[0]!.index] : undefined;
    if (first && previous?.rangeDigest === topicCanonRangeDigest(canon) && normalized(first.minutes) < normalized(previous.minutes)) failures.push({
      currentTimeQuote: first.quote, minutes: first.minutes, userConstraint: '上一份已正式发布且来源有效的叙事结尾时刻',
      sourceMessageId: previous.sourceMessageId, sourceChecksum: previous.sourceChecksum,
      correction: `上一份正式正文结束时刻为${previous.quote}，本段当前场景${first.quote}更早。承接已发布的时刻顺序；合法明确回忆可以past分类，不能把无说明倒流当续写。` });
    for (let index = 1; index < current.length; index++) {
      const before = mentions[current[index - 1]!.index]!, after = mentions[current[index]!.index]!;
      if (normalized(after.minutes) < normalized(before.minutes)) failures.push({ currentTimeQuote: after.quote, minutes: after.minutes,
        userConstraint: '本段已明确标注为当前场景的连续时刻顺序', sourceMessageId: '', sourceChecksum: '',
        correction: `当前场景先出现${before.quote}，后出现${after.quote}，时刻倒流。保持当前场景时间前后顺序；同分钟可继续，明确回忆、未来约定与假设不按当前场景比较。` });
    }
  }
  return failures.length ? JSON.stringify(failures) : undefined;
}
