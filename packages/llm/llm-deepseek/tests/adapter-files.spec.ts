import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { DeepSeekAdapter, resolveAdapterOptions } from '../src/index.ts'

const USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
let testHome: string

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), 'worldline-adapter-files-'))
  vi.stubEnv('WORLDLINE_HOME', testHome)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(testHome, { recursive: true, force: true })
})

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

const requestImage: RequestImageAttachment = {
  variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
  attachment: ref,
  data: Uint8Array.of(1, 2, 3),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  depth: 'uchar',
  space: 'srgb',
  hasAlpha: true,
}

function options(): GenerateOptions {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    messages: [createUserMessage({
      content: [{ type: 'image', attachment: ref }],
      source: { kind: 'plugin', plugin: 'test' },
    })],
  }
}

function sse(): Response {
  const events = [
    '{"choices":[{"delta":{"content":"ok"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    '[DONE]',
  ]
  return new Response(events.map(event => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function uploaded(id: string): Response {
  return new Response(JSON.stringify({
    id,
    object: 'file',
    bytes: 3,
    created_at: 4_000_000_000,
    filename: 'worldline-image.png',
    purpose: 'user_data',
    expires_at: 4_000_604_800,
  }), { status: 200 })
}

function adapter(config: Record<string, unknown> = {}): DeepSeekAdapter {
  const attachments = {
    readImageRequest: vi.fn(() => Promise.resolve(requestImage)),
  } as unknown as AttachmentStore
  return new DeepSeekAdapter({
    options: () => resolveAdapterOptions(config),
    resolveApiKey: () => Promise.resolve('key'),
    resolveUserId: () => USER_ID,
    resolveAttachments: () => attachments,
  })
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of iterable) { /* drain */ }
}

function target(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new TypeError('expected a string request body')
  return init.body
}

describe('DeepSeekAdapter Files API request path', () => {
  it('uploads once, sends file_id, and reuses the indexed upload', async () => {
    let uploads = 0
    const chats: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (target(input).endsWith('/files')) return uploaded(`file-${++uploads}`)
      chats.push(JSON.parse(requestBody(init)))
      return sse()
    }))
    const deepseek = adapter()

    await drain(deepseek.stream(options()))
    await drain(deepseek.stream(options()))

    expect(uploads).toBe(1)
    expect(JSON.stringify(chats)).toContain('"type":"file","file_id":"file-1"')
  })

  it('invalidates a rejected file id and retries the chat exactly once', async () => {
    let uploads = 0
    let chats = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (target(input).endsWith('/files')) return uploaded(`file-${++uploads}`)
      chats += 1
      if (chats === 1) {
        return new Response(JSON.stringify({
          error: { message: 'file_id file-1 expired', code: 'invalid_file_id' },
        }), { status: 400 })
      }
      return sse()
    }))

    await drain(adapter().stream(options()))
    expect(uploads).toBe(2)
    expect(chats).toBe(2)
  })

  it('falls back to inline base64 when Files API is unavailable', async () => {
    const chats: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (target(input).endsWith('/files')) {
        return new Response(JSON.stringify({ error: { message: 'not supported' } }), { status: 404 })
      }
      chats.push(JSON.parse(requestBody(init)))
      return sse()
    }))

    await drain(adapter().stream(options()))
    expect(JSON.stringify(chats)).toContain('data:image/png;base64,AQID')
  })

  it('bounds Files API resolution independently and then uses inline fallback', async () => {
    const chats: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (target(input).endsWith('/files')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason
            reject(reason instanceof Error ? reason : new Error('Files API request aborted'))
          }, { once: true })
        })
      }
      chats.push(JSON.parse(requestBody(init)))
      return Promise.resolve(sse())
    }))

    await drain(adapter({ filesApiTimeoutMs: 10 }).stream(options()))
    expect(JSON.stringify(chats)).toContain('data:image/png;base64,AQID')
  })
})
