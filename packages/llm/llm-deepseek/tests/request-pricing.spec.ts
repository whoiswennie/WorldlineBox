import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { deepSeekImageRequestPricing } from '../src/request-pricing.ts'

const VISION_MODEL = {
  id: 'vision',
  inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
}

function ref(name: string, width: number, height: number, bytes = 1024): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${name.padEnd(64, '0')}`),
    mediaType: 'image/png',
    bytes,
    width,
    height,
    name,
  }
}

function connection(config: Omit<Config, 'models'> = {}): ReturnType<typeof resolveAdapterOptions> {
  return resolveAdapterOptions({ models: [VISION_MODEL], ...config })
}

describe('DeepSeek request-image pricing', () => {
  it('uses deterministic text substitution for unknown and text-only routes', () => {
    const image = ref('photo', 1920, 1080)
    expect(deepSeekImageRequestPricing(connection(), 'unlisted').priceImages([image]))
      .toEqual([{ visualTokens: 0, text: textOnlyImageText(image) }])
    const textOnly = resolveAdapterOptions({ models: [{ id: 'text-only' }] })
    expect(deepSeekImageRequestPricing(textOnly, 'text-only').priceImages([image]))
      .toEqual([{ visualTokens: 0, text: textOnlyImageText(image) }])
  })

  it('prices retained image geometry and low-detail projection exactly', () => {
    const image = ref('photo', 1920, 1080)
    expect(deepSeekImageRequestPricing(connection(), 'vision').priceImages([image])).toEqual([{
      visualTokens: 369,
      text: requestImageHandleText(image, { width: 1066, height: 600 }),
    }])
    const low = resolveAdapterOptions({ models: [{ ...VISION_MODEL, imageDetail: 'low' }] })
    expect(deepSeekImageRequestPricing(low, 'vision').priceImages([ref('square', 4096, 4096)])[0]
      ?.visualTokens).toBe(201)
  })

  it('prices oldest count- and byte-offloaded occurrences as identity-preserving text', () => {
    const images = [ref('first', 800, 800), ref('second', 800, 800), ref('third', 800, 800)]
    const countPrices = deepSeekImageRequestPricing(connection({
      maxImagesPerRequest: 2,
      imageOffloadCountQuantum: 1,
    }), 'vision').priceImages(images)
    expect(countPrices[0]).toEqual({ visualTokens: 0, text: offloadedImageText(images[0]!) })
    expect(countPrices.slice(1).map(price => price.visualTokens)).toEqual([349, 349])

    const oversized = images.map(image => ({ ...image, bytes: 5 * 1024 * 1024 }))
    const bytePrices = deepSeekImageRequestPricing(connection({
      maxRequestFilesBytes: 2 * 1024 * 1024,
      imageOffloadByteQuantum: 1,
    }), 'vision').priceImages(oversized)
    expect(bytePrices.map(price => price.visualTokens)).toEqual([0, 349, 349])
  })

  it('uses current-world read-only access in both retained and omitted descriptions', () => {
    const access = { readonlyPath: '/world/attachments/photo.png' }
    const images = [ref('first', 800, 800), ref('second', 800, 800)]
    const prices = deepSeekImageRequestPricing(connection({
      maxImagesPerRequest: 1,
      imageOffloadCountQuantum: 1,
    }), 'vision', () => access).priceImages(images)
    expect(prices[0]).toEqual({ visualTokens: 0, text: offloadedImageText(images[0]!, access) })
    expect(prices[1]?.text).toContain('/world/attachments/photo.png')
  })
})
