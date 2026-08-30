import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmImageRequestPricing,
  Message,
  StreamChunk,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import { canonicalHeader, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { estimateContent, estimateMessage } from '../src/estimate.ts'

class PricingAdapter extends LlmAdapter {
  constructor(private readonly pricing: (model: string) => LlmImageRequestPricing | undefined) {
    super()
  }

  override imageRequestPricing(_provider: string, model: string): LlmImageRequestPricing | undefined {
    return this.pricing(model)
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('pricing test adapter does not stream')
  }
}

const VISUAL_TOKENS = 100
const HANDLE_TEXT = 'Image handle text'
const fixedPricing: LlmImageRequestPricing = {
  priceImages: images => images.map(() => ({ visualTokens: VISUAL_TOKENS, text: HANDLE_TEXT })),
}

function imageRef(name: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${name.padEnd(64, '0')}`),
    mediaType: 'image/png',
    bytes: 2048,
    width: 800,
    height: 800,
    name,
  }
}

function imageMessage(name: string): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', attachment: imageRef(name) },
    ],
    source: { kind: 'user' },
  })
}

async function harness(
  pricing: (model: string) => LlmImageRequestPricing | undefined,
): Promise<{ meter: TokenMeter; session: Session }> {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  const llm = new LlmRuntime(ctx)
  llm.registerAdapter(['mock'], new PricingAdapter(pricing))
  return { meter: new TokenMeter(ctx), session: Session.create(SessionId('route-priced')) }
}

function routedMessageTokens(message: Message): number {
  const imageFree = estimateMessage({
    ...message,
    content: message.content.filter(block => block.type !== 'image'),
  })
  return imageFree + VISUAL_TOKENS + estimateContent([{ type: 'text', text: HANDLE_TEXT }])
}

describe('route-aware image pricing', () => {
  it('prices a multimodal surface with routed visual tokens and preserves its heuristic', async () => {
    const { meter, session } = await harness(() => fixedPricing)
    const message = imageMessage('photo')
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', {
      header: canonicalHeader({ config: { provider: 'mock', model: 'vision' } }),
      reason: 'initial',
    })
    const measurement = meter.measure(session)
    expect(measurement.nodes[0]).toEqual({
      seq: 0,
      tokens: routedMessageTokens(message),
      heuristicTokens: estimateMessage(message),
    })
    expect(measurement.surfaceTokens).toBe(routedMessageTokens(message))
  })

  it('reprices the same durable surface for a text-only request route', async () => {
    const placeholder = '[image omitted for this text-only route]'
    const substitution: LlmImageRequestPricing = {
      priceImages: images => images.map(() => ({ visualTokens: 0, text: placeholder })),
    }
    const { meter, session } = await harness(model => model === 'vision' ? fixedPricing : substitution)
    const message = imageMessage('photo')
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', {
      header: canonicalHeader({ config: { provider: 'mock', model: 'vision' } }),
      reason: 'initial',
    })
    const textOnly = meter.measure(
      session,
      canonicalHeader({ config: { provider: 'mock', model: 'text-only' } }),
    )
    const imageFree = estimateMessage({
      ...message,
      content: message.content.filter(block => block.type !== 'image'),
    })
    expect(textOnly.nodes[0]?.tokens)
      .toBe(imageFree + estimateContent([{ type: 'text', text: placeholder }]))
  })

  it('retains heuristic pricing without a route declaration and rejects bad occurrence counts', async () => {
    const missing = await harness(() => undefined)
    const message = imageMessage('photo')
    missing.session.append('user/message', message, { surfaceOp: 'append' })
    missing.session.append('request/header', {
      header: canonicalHeader({ config: { provider: 'mock', model: 'vision' } }),
      reason: 'initial',
    })
    expect(missing.meter.measure(missing.session).nodes[0]?.tokens).toBe(estimateMessage(message))

    const broken = await harness(() => ({ priceImages: () => [] }))
    broken.session.append('user/message', imageMessage('photo'), { surfaceOp: 'append' })
    broken.session.append('request/header', {
      header: canonicalHeader({ config: { provider: 'mock', model: 'vision' } }),
      reason: 'initial',
    })
    expect(() => broken.meter.measure(broken.session))
      .toThrow('route image pricing answered 0 prices for 1 occurrences')
  })
})
