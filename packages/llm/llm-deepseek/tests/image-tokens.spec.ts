import { describe, expect, it } from 'vitest'
import { deepSeekImageTokens } from '../src/image-tokens.ts'

describe('DeepSeek v4 image tokens', () => {
  it.each([
    [100, 100, 117],
    [384, 384, 117],
    [640, 480, 209],
    [800, 800, 349],
    [1024, 768, 357],
    [1920, 1080, 369],
    [2000, 2000, 349],
    [5000, 5000, 349],
    [300, 50, 101],
  ])('prices %sx%s as %s tokens', (width, height, expected) => {
    expect(deepSeekImageTokens(width, height)).toBe(expected)
  })

  it('covers the floor, aspect-ratio clamp, tall grid, and convergence branches', () => {
    expect(deepSeekImageTokens(100, 100)).toBe(deepSeekImageTokens(384, 384))
    expect(deepSeekImageTokens(9000, 1)).toBe(113)
    expect(deepSeekImageTokens(16, 8192)).toBe(381)
    expect(deepSeekImageTokens(100, 4036)).toBe(253)
    expect(deepSeekImageTokens(4921, 353)).toBe(289)
    expect(deepSeekImageTokens(97, 7289)).toBe(245)
  })

  it('never exceeds the provider 384-token image cap', () => {
    for (const [width, height] of [[2000, 2000], [5000, 5000], [8192, 8192], [16, 8192]]) {
      expect(deepSeekImageTokens(width!, height!)).toBeLessThanOrEqual(384)
    }
  })
})
