import { describe, expect, it } from 'vitest'
import { encodeReference, referenceSource } from '../src/client/reference-source.ts'

describe('reference draft codec', () => {
  it('serializes each staged chip only when the combined message is submitted', async () => {
    const ref = encodeReference({ id: 'meme-1', title: '你真棒 & 加油' })
    const codec = referenceSource.codec
    expect(codec).toBeDefined()
    expect(codec?.clipboardText(ref)).toBe('[表情：你真棒 & 加油]')
    expect(await codec?.serialize(ref, new AbortController().signal)).toBe(
      '<user-reference asset-id="meme-1">你真棒 &amp; 加油</user-reference>',
    )
  })
})
