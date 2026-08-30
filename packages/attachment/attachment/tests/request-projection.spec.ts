import { describe, expect, it } from 'vitest'
import { requestImageDimensions } from '../src/index.ts'

describe('requestImageDimensions', () => {
  it('keeps small images and projects both orientations inside the pixel budget', () => {
    expect(requestImageDimensions(20, 10, 1_000)).toEqual({ width: 20, height: 10 })
    const wide = requestImageDimensions(4_000, 2_000, 640_000)
    const tall = requestImageDimensions(2_000, 4_000, 640_000)
    expect(wide.width * wide.height).toBeLessThanOrEqual(640_000)
    expect(tall.width * tall.height).toBeLessThanOrEqual(640_000)
    expect(wide.width / wide.height).toBeCloseTo(2, 2)
    expect(tall.height / tall.width).toBeCloseTo(2, 2)
  })
})
