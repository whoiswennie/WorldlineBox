/** Persistent reference-channel state and semantic late binding for companion expression. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReferenceAct, ReferenceIntent, VirtualCompanion } from './contracts.ts'

/** Stable per-companion policy inputs for the expression channel. */
export interface ReferenceExpressionStyle {
  readonly spontaneity: number
  readonly reciprocity: number
  readonly escalation: number
  readonly burstiness: number
  readonly repeatWindow: number
  readonly preferredActs: readonly ReferenceAct[]
}

/** Conversation-derived reference state reconstructed exclusively from durable room events. */
export interface ReferenceConversationState {
  readonly mode: 'idle' | 'social' | 'exchange'
  readonly pendingReplyTo?: string
  readonly recentAssetIds: readonly string[]
  readonly recentActs: readonly ReferenceAct[]
  readonly exchangeDepth: number
}

/** Small metadata surface used by the model-free expression ranker. */
export interface ExpressionCandidate {
  readonly id: string
  readonly agentId: string
  readonly title: string
  readonly description: string
  readonly tags: readonly string[]
  readonly transcript: string
  readonly mimeType: string
  readonly usageCount: number
}

const SEMANTIC_CLUSTERS: readonly (readonly string[])[] = [
  ['喜欢', '爱你', '爱心', '比心', '亲亲', '心动', '宠爱', '好喜欢', '眼冒爱心', 'affection', 'love'],
  ['饿', '吃饭', '吃东西', '美食', '好吃', '大吃特吃', '喝奶茶', '吃薯片', '流口水', 'hungry', 'food'],
  ['庆祝', '成功', '胜利', '开心', '好耶', '耶', '跳舞', '激动', 'celebrate', 'congratulations'],
  ['难过', '伤心', '委屈', '哭', '泪眼', '大哭大闹', '安慰', 'sad', 'cry', 'comfort'],
  ['疑惑', '不懂', '什么', '问号', '困惑', '惊讶', '惊到了', '我发现了什么', 'confused', 'surprised'],
  ['拒绝', '不要', '不情愿', '生气', '好气', '嫌弃', '给你一拳', '大咩哟', 'reject', 'angry'],
  ['撒娇', '卖萌', '可爱', '贴贴', '陪伴', '亲昵', 'cute', 'tease'],
  ['道歉', '对不起', '抱歉', '投降', 'sorry', 'apologize'],
  ['困', '睡觉', '困死了', '晚安', 'sleep', 'tired'],
  ['唱歌', '音乐', '歌曲', '跳舞', '打音游', 'music', 'song'],
]

function normalizeExpressionText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function expressionTerms(value: string): Set<string> {
  const normalized = normalizeExpressionText(value)
  const terms = new Set<string>()
  for (const segment of value.normalize('NFKC').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/gu)) {
    if (segment.length >= 2) terms.add(segment)
    if (!/[\p{Script=Han}]/u.test(segment)) continue
    for (let size = 2; size <= Math.min(4, segment.length); size += 1) {
      for (let index = 0; index + size <= segment.length; index += 1) {
        terms.add(segment.slice(index, index + size))
      }
    }
  }
  for (const cluster of SEMANTIC_CLUSTERS) {
    if (!cluster.some(term => normalized.includes(normalizeExpressionText(term)))) continue
    for (const term of cluster) terms.add(normalizeExpressionText(term))
  }
  return terms
}

function expressionScore(candidate: ExpressionCandidate, signal: string, preferredAgentId: string,
  recentAssetIds: readonly string[]): number {
  const title = normalizeExpressionText(candidate.title)
  const tags = candidate.tags.map(normalizeExpressionText)
  const body = normalizeExpressionText([
    candidate.title, candidate.description, candidate.tags.join(' '), candidate.transcript,
  ].join(' '))
  const normalizedSignal = normalizeExpressionText(signal)
  let score = candidate.agentId === preferredAgentId ? 2 : 0
  // Recent use is context for the Agent, not a ban. A small penalty encourages variety while an
  // exact or strongly relevant asset can still win and can always be explicitly selected again.
  if (recentAssetIds.includes(candidate.id)) score -= 12
  if (title !== '' && normalizedSignal.includes(title)) score += 80 + title.length * 4
  for (const term of expressionTerms(signal)) {
    if (term.length < 2 || !body.includes(term)) continue
    score += 2 + Math.min(term.length, 8)
    if (title.includes(term)) score += 8
    if (tags.some(tag => tag.includes(term))) score += 4
  }
  return score
}

/**
 * Rank a small expression shortlist without embeddings. Titles, tags and descriptions provide
 * relevance while recent use remains a soft signal that never makes an asset unavailable.
 * @param candidates - candidates value.
 * @param intent - intent value.
 * @param recentAssetIds - recent asset ids value.
 * @param preferredAgentId - preferred agent id value.
 * @param recentRoomText - recent room text value.
 * @param limit - limit value.
 * @returns The resulting value.
 */
export function rankExpressionCandidates<Candidate extends ExpressionCandidate>(
  candidates: readonly Candidate[],
  intent: ReferenceIntent,
  recentAssetIds: readonly string[],
  preferredAgentId: string,
  recentRoomText: string,
  limit = 5,
): Candidate[] {
  const unique = [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()]
  const signal = [
    intent.assetTitle ?? '', intent.act, intent.query ?? '', ...(intent.preferredTags ?? []),
    intent.target ?? '', recentRoomText,
  ].join(' ')
  const exactTitle = normalizeExpressionText(intent.assetTitle ?? '')
  return unique
    .map((candidate, index) => ({ candidate, index,
      score: expressionScore(candidate, signal, preferredAgentId, recentAssetIds)
        + (exactTitle !== '' && normalizeExpressionText(candidate.title) === exactTitle ? 240 : 0) }))
    .sort((left, right) => right.score - left.score
      || left.candidate.usageCount - right.candidate.usageCount
      || left.index - right.index)
    .slice(0, Math.max(1, Math.min(10, limit)))
    .map(item => item.candidate)
}

/**
 *  Select the leading automatic candidate when the Agent does not request a shortlist first.
 * @param candidates - candidates value.
 * @param intent - intent value.
 * @param recentAssetIds - recent asset ids value.
 * @param preferredAgentId - preferred agent id value.
 * @param recentRoomText - recent room text value.
 * @returns The resulting value.
 */
export function selectExpressionCandidate<Candidate extends ExpressionCandidate>(
  candidates: readonly Candidate[],
  intent: ReferenceIntent,
  recentAssetIds: readonly string[],
  preferredAgentId: string,
  recentRoomText: string,
): Candidate | undefined {
  return rankExpressionCandidates(candidates, intent, recentAssetIds, preferredAgentId, recentRoomText, 1)[0]
}

const DEFAULT_STYLE: ReferenceExpressionStyle = {
  spontaneity: 0.45,
  reciprocity: 0.72,
  escalation: 0.4,
  burstiness: 0.35,
  repeatWindow: 8,
  preferredActs: ['agree', 'comfort', 'tease', 'celebrate'],
}

const BUILT_IN_STYLES: Readonly<Record<string, ReferenceExpressionStyle>> = {
  'yachiyo-runami': {
    spontaneity: 0.72, reciprocity: 0.84, escalation: 0.5, burstiness: 0.55,
    repeatWindow: 10, preferredActs: ['praise', 'comfort', 'celebrate', 'tease', 'affection'],
  },
  'iroha-sakayori': {
    spontaneity: 0.38, reciprocity: 0.76, escalation: 0.35, burstiness: 0.25,
    repeatWindow: 12, preferredActs: ['counter', 'reject', 'confused', 'comfort', 'tease'],
  },
  kaguya: {
    spontaneity: 0.86, reciprocity: 0.95, escalation: 0.82, burstiness: 0.9,
    repeatWindow: 7, preferredActs: ['challenge', 'counter', 'celebrate', 'tease', 'affection'],
  },
}

const USER_REFERENCE = /<user-reference\s+asset-id="([a-z\d-]{1,160})">/giu
const EXCHANGE_CUE = /斗图|接图|回一张|再来一张|用表情|发表情|贴图|meme|sticker/iu
const TASK_SWITCH = /代码|文件|终端|命令|检索资料|分析项目|修复|实现|构建|打包|提交|推送/iu

function userText(event: SessionEvent): string {
  if (event.type !== 'user/message') return ''
  return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function referencesIn(text: string): string[] {
  return [...text.matchAll(USER_REFERENCE)].flatMap(match => match[1] === undefined ? [] : [match[1]])
}

/**
 * Resolve the expression style owned by one companion profile.
 * @param companion - Companion whose built-in or default style is requested.
 * @returns Stable expression-channel style parameters.
 */
export function expressionStyle(companion: VirtualCompanion): ReferenceExpressionStyle {
  return BUILT_IN_STYLES[companion.id] ?? DEFAULT_STYLE
}

/**
 * Rebuild the active media conversation from durable room events; no process-only cooldown exists.
 * @param events - Ordered durable room events.
 * @param style - Companion-specific repetition and exchange policy.
 * @returns Current exchange mode, reply target, and recent-expression window.
 */
export function referenceConversationState(
  events: readonly SessionEvent[],
  style: ReferenceExpressionStyle,
): ReferenceConversationState {
  let explicitExchangeSeq = -1
  let seriousSwitchSeq = -1
  let latestUserReference: { id: string; seq: number } | undefined
  let latestCompanionReferenceSeq = -1
  const assetIds: string[] = []
  const acts: ReferenceAct[] = []
  // Token/reasoning streams can contribute thousands of low-level events per turn. Walking only
  // the last N raw events made a reference from the immediately preceding reply disappear. Scan
  // backwards until the bounded semantic history is complete, with a generous raw safety cap.
  const semanticEvents: SessionEvent[] = []
  let references = 0
  let intents = 0
  let userMessages = 0
  const lowerBound = Math.max(0, events.length - 20_000)
  for (let index = events.length - 1; index >= lowerBound; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'companion/reference') references += 1
    else if (event.type === 'companion/expression-intent') intents += 1
    else if (event.type === 'user/message') userMessages += 1
    else continue
    semanticEvents.push(event)
    if (references >= style.repeatWindow && intents >= 8 && userMessages >= 12) break
  }
  for (const event of semanticEvents.reverse()) {
    const text = userText(event)
    if (text !== '') {
      if (EXCHANGE_CUE.test(text)) explicitExchangeSeq = event.seq
      if (TASK_SWITCH.test(text) && !EXCHANGE_CUE.test(text)) seriousSwitchSeq = event.seq
      const ids = referencesIn(text)
      const id = ids.at(-1)
      if (id !== undefined) latestUserReference = { id, seq: event.seq }
    }
    if (event.type === 'companion/reference') {
      latestCompanionReferenceSeq = event.seq
      assetIds.push(event.data.assetId)
    }
    if (event.type === 'companion/expression-intent') acts.push(event.data.act)
  }
  const pending = latestUserReference !== undefined
    && latestUserReference.seq > latestCompanionReferenceSeq
    ? latestUserReference.id
    : undefined
  const exchangeStartSeq = Math.max(explicitExchangeSeq, latestUserReference?.seq ?? -1)
  const exchange = seriousSwitchSeq < exchangeStartSeq
  return {
    mode: exchange ? 'exchange' : assetIds.length > 0 ? 'social' : 'idle',
    ...(pending === undefined ? {} : { pendingReplyTo: pending }),
    recentAssetIds: assetIds.slice(-style.repeatWindow),
    recentActs: acts.slice(-8),
    exchangeDepth: Math.min(12, acts.length),
  }
}

/**
 * Build a fresh retrieval query only after the actor has chosen an expression intent.
 * @param intent - Semantic expression chosen by the actor.
 * @param recentRoomText - Bounded room text used only to ground late binding.
 * @returns Model-free reference-vault query text.
 */
export function expressionQuery(intent: ReferenceIntent, recentRoomText: string): string {
  return [
    intent.assetTitle ?? '',
    intent.act,
    ...(intent.preferredTags ?? []),
    intent.role ?? 'amplify-text',
    intent.target ?? '',
    intent.query ?? '',
    recentRoomText.slice(-240),
  ].filter(Boolean).join(' ')
}
