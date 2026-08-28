import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReferenceIntent, VirtualCompanion } from '../src/contracts.ts'
import {
  expressionQuery,
  expressionStyle,
  referenceConversationState,
} from '../src/reference-expression.ts'

const companion = (id: string): VirtualCompanion => ({
  id, name: id, handle: id, avatar: '', portrait: '', status: '', description: '',
  persona: '', style: '', speakingStyle: '', behaviorLogic: '', builtIn: true,
  createdAt: 1, updatedAt: 1,
})

const user = (seq: number, text: string): SessionEvent => ({
  type: 'user/message', seq, time: seq,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
} as SessionEvent)

const expression = (seq: number, act: ReferenceIntent['act'], assetId: string): SessionEvent[] => [{
  type: 'companion/expression-intent', seq, time: seq,
  data: { companionId: 'kaguya', act, assetId, intensity: 0.8 },
}, {
  type: 'companion/reference', seq: seq + 1, time: seq + 1,
  data: { companionId: 'kaguya', assetId, title: act, mimeType: 'image/gif', url: '/meme.gif' },
}] as SessionEvent[]

describe('reference expression channel', () => {
  it('keeps a user-started battle active after one reply and closes it on a serious task switch', () => {
    const style = expressionStyle(companion('kaguya'))
    const opening = referenceConversationState([
      user(1, '<user-reference asset-id="user-meme-1">挑衅</user-reference>'),
    ], style)
    expect(opening).toMatchObject({
      mode: 'exchange', pendingReplyTo: 'user-meme-1', exchangeDepth: 0,
    })

    const continued = referenceConversationState([
      user(1, '<user-reference asset-id="user-meme-1">挑衅</user-reference>'),
      ...expression(2, 'counter', 'builtin-meme-1'),
    ], style)
    expect(continued).toMatchObject({ mode: 'exchange', exchangeDepth: 1 })
    expect(continued.pendingReplyTo).toBeUndefined()
    expect(continued.recentAssetIds).toEqual(['builtin-meme-1'])

    expect(referenceConversationState([
      user(1, '<user-reference asset-id="user-meme-1">挑衅</user-reference>'),
      ...expression(2, 'counter', 'builtin-meme-1'),
      user(5, '现在请分析项目并修复代码。'),
    ], style).mode).toBe('social')
  })

  it('uses companion-specific expression styles and late-binds semantic intent to a fresh query', () => {
    expect(expressionStyle(companion('kaguya')).reciprocity)
      .toBeGreaterThan(expressionStyle(companion('iroha-sakayori')).reciprocity)
    expect(expressionQuery({
      act: 'challenge', role: 'reply', intensity: 3, target: '房主',
      replyTo: 'user-meme-1', query: '不服再来',
    }, '刚刚说要继续斗图')).toContain('challenge reply 房主 不服再来')
  })
})
