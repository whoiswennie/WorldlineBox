import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReferenceIntent, VirtualCompanion } from '../src/contracts.ts'
import {
  expressionQuery,
  expressionStyle,
  rankExpressionCandidates,
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

  it('retains recent references across thousands of low-level streaming events', () => {
    const noise: SessionEvent[] = Array.from({ length: 2_400 }, (_, index) => ({
      type: 'assistant/chunk', seq: index + 3, time: index + 3,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '字' } },
    }))
    const state = referenceConversationState([
      user(0, '发一张表情'),
      ...expression(1, 'celebrate', 'recent-celebration'),
      ...noise,
    ], expressionStyle(companion('kaguya')))
    expect(state.recentAssetIds).toContain('recent-celebration')
  })

  it.each([
    ['向我比心，表达喜欢', '好喜欢'],
    ['有点饿，想吃好吃的', '大吃特吃'],
    ['终于成功了，一起庆祝', '好耶'],
    ['受了委屈很难过', '委屈'],
    ['疑惑，不知道发生了什么', '什么？'],
    ['生气地拒绝，不要这样', '不要啊'],
    ['可爱地撒娇贴贴', '撒娇'],
  ])('ranks human-like candidates for semantic scene %s', (signal, expected) => {
    const titles = ['好喜欢', '大吃特吃', '好耶', '委屈', '什么？', '不要啊', '撒娇', '无语']
    const candidates = titles.map((title, index) => ({
      id: `asset-${String(index)}`, agentId: 'kaguya', title,
      description: title, tags: [title, '表情包'], transcript: '', mimeType: 'image/gif', usageCount: 0,
    }))
    const ranked = rankExpressionCandidates(candidates, { act: signal, query: signal }, [], 'kaguya', '', 5)
    expect(ranked[0]?.title).toBe(expected)
    expect(ranked).toHaveLength(5)
  })

  it('keeps a recently used asset available while gently preferring an equally relevant alternative', () => {
    const candidates = ['celebrate-0', 'celebrate-1'].map(id => ({
      id, agentId: 'kaguya', title: '好耶',
      description: '开心庆祝成功', tags: ['庆祝', '开心'], transcript: '', mimeType: 'image/gif', usageCount: 0,
    }))
    const ranked = rankExpressionCandidates(candidates, { act: '开心庆祝成功' }, ['celebrate-0'], 'kaguya', '', 5)
    expect(ranked.map(item => item.id)).toEqual(['celebrate-1', 'celebrate-0'])
  })
})
