import { describe, expect, it } from 'vitest'
import { BUILT_IN_MEMES } from '../src/builtin-memes.ts'

describe('built-in companion meme manifest', () => {
  it('labels kaguya meme 021 as insufficient balance', () => {
    const meme = BUILT_IN_MEMES.find(item => item.id === 'builtin-kaguya-021')
    expect(meme).toMatchObject({
      title: '余额不足',
      content: '辉夜-余额不足',
      asset: '/worldline-experience/companion-memes/kaguya/021.gif',
    })
  })
})
