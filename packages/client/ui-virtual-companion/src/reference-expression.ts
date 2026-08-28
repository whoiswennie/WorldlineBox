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
  for (const event of events.slice(-160)) {
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
    intent.act,
    ...(intent.preferredTags ?? []),
    intent.role ?? 'amplify-text',
    intent.target ?? '',
    intent.query ?? '',
    recentRoomText.slice(-240),
  ].filter(Boolean).join(' ')
}
