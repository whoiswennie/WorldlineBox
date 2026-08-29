import { describe, expect, it } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BUILT_IN_MEMES } from '../src/builtin-memes.ts'
import { rankExpressionCandidates } from '../src/reference-expression.ts'

describe('built-in companion meme manifest', () => {
  it('labels kaguya meme 021 as insufficient balance', () => {
    const meme = BUILT_IN_MEMES.find(item => item.id === 'builtin-kaguya-021')
    expect(meme).toMatchObject({
      title: '余额不足',
      content: '辉夜-余额不足',
      asset: '/worldline-experience/companion-memes/kaguya/021.gif',
    })
  })

  it('ships the Gudug Manbo video as a searchable public built-in resource', () => {
    const resource = BUILT_IN_MEMES.find(item => item.id === 'builtin-public-005')
    expect(resource).toMatchObject({
      scope: 'public',
      title: '孤高曼波',
      asset: '/worldline-experience/companion-memes/public/005.mp4',
      mimeType: 'video/mp4',
      bytes: 5_629_565,
      durationMs: 23_000,
    })
    expect(resource?.tags).toEqual(expect.arrayContaining(['赛马娘', '诗歌剧', '登山', '整活']))
    expect(resource?.transcript).toContain('严肃求助')
  })

  it('ships every declared image and video and recalls every exact title as the leading candidate', () => {
    for (const resource of BUILT_IN_MEMES) {
      const file = join(process.cwd(), 'apps', 'web', 'public', ...resource.asset.split('/').slice(1))
      expect(existsSync(file), `${resource.id} should ship ${file}`).toBe(true)
      expect(statSync(file).size, `${resource.id} should not be empty`).toBeGreaterThan(0)
      const candidates = BUILT_IN_MEMES
        .filter(item => item.scope === resource.scope || item.scope === 'public')
        .map(item => ({
          id: item.id, agentId: item.scope, title: item.title,
          description: item.description ?? item.content, tags: item.tags ?? [],
          transcript: item.transcript ?? '', mimeType: item.mimeType, usageCount: 0,
        }))
      const ranked = rankExpressionCandidates(candidates, {
        act: resource.title, assetTitle: resource.title,
      }, [], resource.scope, '', 5)
      expect(ranked[0]?.id, `${resource.scope}:${resource.title}`).toBe(resource.id)
    }
  })

  it.each([
    ['yachiyo-runami', '比心', ['小南娘比心']],
    ['yachiyo-runami', '饿了，想吃东西喝奶茶', ['吃薯片', '喝奶茶']],
    ['yachiyo-runami', '真棒，肯定和赞美', ['肯定', '你真棒']],
    ['yachiyo-runami', '喜欢你，眼里都是爱心', ['眼冒爱心']],
    ['iroha-sakayori', '困了想睡觉，晚安', ['睡觉', '困死了']],
    ['iroha-sakayori', '疑惑困惑，满头问号', ['问号']],
    ['kaguya', '饿了，想大吃一顿好吃的', ['大吃特吃', '好吃', '好好吃', '流口水']],
    ['kaguya', '成功胜利，一起开心庆祝', ['好耶', '耶', '跳舞', '激动']],
    ['kaguya', '疑惑，不知道发生了什么', ['什么？', '我发现了什么', '你怎么不早说', '惊到了']],
    ['kaguya', '生气拒绝，不要这样', ['不要啊', '不情愿', '给你一拳', '好气']],
    ['public', '荒诞登场，孤高登山曼波压轴', ['孤高曼波']],
    ['yachiyo-runami', '赛马娘诗歌剧 一本正经整活 独自登山 荒诞压轴 视频', ['孤高曼波']],
    ['iroha-sakayori', '赛马娘诗歌剧 一本正经整活 独自登山 荒诞压轴 视频', ['孤高曼波']],
    ['kaguya', '赛马娘诗歌剧 一本正经整活 独自登山 荒诞压轴 视频', ['孤高曼波']],
  ])('keeps %s scene %s within a human-plausible top-five set', (scope, signal, expected) => {
    const candidates = BUILT_IN_MEMES
      .filter(item => item.scope === scope || item.scope === 'public')
      .map(item => ({
        id: item.id, agentId: item.scope, title: item.title,
        description: item.description ?? item.content, tags: item.tags ?? [],
        transcript: item.transcript ?? '', mimeType: item.mimeType, usageCount: 0,
      }))
    const ranked = rankExpressionCandidates(candidates, { act: signal, query: signal }, [], scope, '', 5)
    expect(ranked.map(item => item.title).some(title => expected.includes(title)),
      `${signal}: ${ranked.map(item => item.title).join(', ')}`).toBe(true)
  })
})
