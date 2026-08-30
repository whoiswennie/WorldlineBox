import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import {
  CallId,
  createUserMessage,
  offloadedImageText,
  offloadedImagePrefixCount,
  offloadRequestImagesWithPolicy,
  projectImagesForTextModel,
  requestImageHandleText,
} from '../src/index.ts'
import type { ContentBlock, Message } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }
const OMITTED = '[omitted]'

function offloadBase64(messages: readonly Message[], maxBytes: number): readonly Message[] {
  return offloadRequestImagesWithPolicy(messages, {
    representation: 'base64',
    maxBytes,
    byteQuantum: 1,
    placeholder: () => OMITTED,
  })
}

function image(bytes: number): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
    },
  }
}

describe('base64 request-image offload', () => {
  it('preserves the original request when its base64 payload fits exactly', () => {
    const messages = [createUserMessage({ content: [image(3), image(3)], source })]
    expect(offloadBase64(messages, 8)).toBe(messages)
  })

  it('keeps five 3 MiB images at 20 MiB and offloads the oldest after one more raw byte', () => {
    const rawImageBytes = 3 * 1024 * 1024
    const maxRequestImageBytes = 20 * 1024 * 1024
    const exact = [createUserMessage({
      content: Array.from({ length: 5 }, () => image(rawImageBytes)),
      source,
    })]
    expect(offloadBase64(exact, maxRequestImageBytes)).toBe(exact)

    const over = [createUserMessage({
      content: [image(rawImageBytes + 1), ...Array.from({ length: 4 }, () => image(rawImageBytes))],
      source,
    })]
    expect(offloadBase64(over, maxRequestImageBytes)[0]?.content).toEqual([
      { type: 'text', text: OMITTED },
      ...Array.from({ length: 4 }, () => image(rawImageBytes)),
    ])
  })

  it('replaces the oldest nested occurrences without mutating durable messages', () => {
    const shared = image(3)
    const messages = [
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('shot'),
          content: [shared],
        }],
        source,
      }),
      createUserMessage({ content: [shared, image(3)], source }),
    ]

    const fitted = offloadBase64(messages, 8)
    expect(fitted).not.toBe(messages)
    expect(fitted[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('shot'),
      content: [{ type: 'text', text: OMITTED }],
    }])
    expect(fitted[1]?.content).toEqual([shared, image(3)])
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool-result', content: [shared] })
  })

  it('replaces a single image that cannot fit', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    expect(offloadBase64(messages, 8)[0]?.content)
      .toEqual([{ type: 'text', text: OMITTED }])
  })

  it('keeps unchanged nested content while replacing a later image', () => {
    const nested = {
      type: 'tool-result' as const,
      toolCallId: CallId('text-only'),
      content: [{ type: 'text' as const, text: 'kept' }],
    }
    const messages = [createUserMessage({ content: [nested, image(3)], source })]
    expect(offloadBase64(messages, 1)[0]?.content).toEqual([
      nested,
      { type: 'text', text: OMITTED },
    ])
  })
})

describe('quantized request-image offload', () => {
  it('rounds count and byte excesses up to whole policy quanta', () => {
    const lengths = [4, 4, 4, 4]
    expect(offloadedImagePrefixCount(lengths, {})).toBe(0)
    expect(offloadedImagePrefixCount([...lengths, 4], { maxImages: 4, countQuantum: 2 })).toBe(2)
    expect(offloadedImagePrefixCount([...lengths, 1], { maxBytes: 16, byteQuantum: 5 })).toBe(2)
  })

  it('uses route-projected byte lengths and a per-image placeholder', () => {
    const first = image(100)
    const second = image(100)
    first.attachment = { ...first.attachment, name: 'first.png' }
    second.attachment = { ...second.attachment, name: 'second.png' }
    const messages = [createUserMessage({ content: [first, second], source })]
    expect(offloadRequestImagesWithPolicy(messages, {
      representation: 'raw',
      maxBytes: 3,
      byteLength: () => 2,
      placeholder: ref => `omitted:${ref.name}`,
    })[0]?.content).toEqual([{ type: 'text', text: 'omitted:first.png' }, second])
  })
})

describe('model-facing image access', () => {
  const attachment = {
    attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
    mediaType: 'image/png' as const,
    bytes: 4_000,
    width: 2_048,
    height: 1_536,
    name: 'source "map".png',
  }

  it('describes a request preview and ephemeral read-only normalized path', () => {
    const version = {
      variantId: ImageVariantId(`sha256:${'c'.repeat(64)}`),
      attachment,
      data: Uint8Array.of(1),
      mediaType: 'image/png' as const,
      bytes: 1,
      width: 923,
      height: 692,
      depth: 'uchar' as const,
      space: 'srgb' as const,
      hasAlpha: true,
    }
    const text = requestImageHandleText(
      attachment,
      version,
      { readonlyPath: 'C:\\temp\\object' },
    )
    expect(text).toContain(`Image "source \\"map\\".png" (${attachment.attachmentId})`)
    expect(text).toContain('request preview 923x692px')
    expect(text).toContain('Normalized copy (read-only; may be resized or re-encoded)')
    expect(text).toContain('Copy to a writable path ending in .png before editing')
  })

  it('keeps image identity when a request budget omits the bytes', () => {
    expect(offloadedImageText(attachment, { readonlyPath: 'C:\\temp\\object' })).toContain(
      `[image omitted to fit request image limits; "source \\"map\\".png" (${attachment.attachmentId})`,
    )
    expect(offloadedImageText(attachment)).toContain('No local normalized image path is available')
  })
})

describe('text-only image projection', () => {
  it('replaces direct and nested images without mutating durable messages', () => {
    const plain = createUserMessage({ content: [{ type: 'text', text: 'plain' }], source })
    const visual = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('nested'),
        content: [image(3)],
      }],
      source,
    })
    const projected = projectImagesForTextModel([plain, visual])
    expect(projected[0]).toBe(plain)
    expect(projected[1]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('nested'),
      content: [{
        type: 'text',
        text: '[image omitted because this model accepts text only; attachment sha256:aaaaaaaa]',
      }],
    }])
    expect(visual.content[0]).toMatchObject({ type: 'tool-result', content: [image(3)] })
  })
})
