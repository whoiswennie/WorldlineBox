import { describe, expect, it, vi } from 'vitest'
import { userAgent } from '@deepseek-ai/dsh-llm'
import { DeepSeekFileId } from '../src/file-id.ts'
import {
  DeepSeekFilesClient,
  isFilesQuotaError,
  MAX_FILE_UPLOAD_BYTES,
} from '../src/files-api.ts'

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-api-one',
    object: 'file',
    bytes: 3,
    created_at: 1_700_000_000,
    filename: 'image.png',
    purpose: 'user_data',
    expires_at: 1_700_604_800,
    ...overrides,
  }
}

describe('DeepSeekFilesClient', () => {
  it('uploads multipart bytes with attribution and an explicit expiry', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(url)).toBe('https://api.deepseek.com/files')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer key')
      expect(headers.get('user-agent')).toBe(userAgent())
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect(form.get('purpose')).toBe('user_data')
      expect(form.get('expires_after[seconds]')).toBe('604800')
      expect((form.get('file') as Blob).size).toBe(3)
      return new Response(JSON.stringify(file()), { status: 200 })
    }) as typeof fetch
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com/',
      apiKey: 'key',
      fetch: fetchImpl,
    })

    await expect(client.upload({
      data: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png',
      filename: 'image.png',
      expiresAfterSeconds: 604_800,
    })).resolves.toMatchObject({ id: 'file-api-one', bytes: 3, expiresAt: 1_700_604_800 })
  })

  it('validates list, retrieve, and delete responses', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = requestUrl(url)
      if (target.includes('?')) {
        return new Response(JSON.stringify({
          object: 'list',
          data: [file()],
          first_id: 'file-api-one',
          last_id: 'file-api-one',
          has_more: false,
        }), { status: 200 })
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({
          id: 'file-api-one', object: 'file', deleted: true,
        }), { status: 200 })
      }
      return new Response(JSON.stringify(file()), { status: 200 })
    }) as typeof fetch
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com', apiKey: 'key', fetch: fetchImpl,
    })

    await expect(client.list({ limit: 20, order: 'desc' })).resolves.toMatchObject({
      data: [{ id: 'file-api-one' }], hasMore: false,
    })
    await expect(client.retrieve(DeepSeekFileId('file-api-one'))).resolves.toMatchObject({
      id: 'file-api-one',
    })
    await expect(client.delete(DeepSeekFileId('file-api-one'))).resolves.toBeUndefined()
  })

  it('classifies quota failures and retains their provider detail', async () => {
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'key',
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({
        error: {
          message: 'user storage quota exceeded',
          type: 'invalid_request_error',
          code: 'file_quota',
        },
      }), { status: 400 }))),
    })
    const error = await client.upload({
      data: Uint8Array.of(1),
      mediaType: 'image/png',
      filename: 'image.png',
      expiresAfterSeconds: 3_600,
    }).catch((caught: unknown) => caught)
    expect(isFilesQuotaError(error)).toBe(true)
  })

  it('preserves cancellation and wraps other transport failures', async () => {
    const transport = new Error('socket closed')
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'key',
      fetch: vi.fn(() => Promise.reject(transport)),
    })
    await expect(client.retrieve(DeepSeekFileId('one'))).rejects.toMatchObject({
      code: 'TRANSPORT', cause: transport,
    })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(client.retrieve(DeepSeekFileId('one'), controller.signal)).rejects.toBe(transport)
  })

  it('rejects oversized uploads before transport', async () => {
    const fetchImpl = vi.fn() as typeof fetch
    const client = new DeepSeekFilesClient({
      baseURL: 'https://api.deepseek.com', apiKey: 'key', fetch: fetchImpl,
    })
    await expect(client.upload({
      data: { byteLength: MAX_FILE_UPLOAD_BYTES + 1 } as Uint8Array,
      mediaType: 'image/png',
      filename: 'image.png',
      expiresAfterSeconds: 3_600,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
