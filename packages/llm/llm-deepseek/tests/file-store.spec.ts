import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileStore } from '../src/file-store.ts'
import { DeepSeekUploadIndex } from '../src/upload-index.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function store(fetchImpl: typeof fetch, now = 1_000_000): Promise<DeepSeekFileStore> {
  const dir = await mkdtemp(join(tmpdir(), 'worldline-file-store-'))
  cleanups.push(dir)
  return new DeepSeekFileStore({
    index: new DeepSeekUploadIndex(join(dir, 'files-v3.json')),
    fetch: fetchImpl,
    now: () => now,
  })
}

function version(): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    },
    data: Uint8Array.of(1, 2, 3),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
  }
}

const connection = { baseURL: 'https://api.deepseek.com', apiKey: 'key' }
const policy = { expiresAfterSeconds: 3_600, refreshMarginSeconds: 60, quotaCleanupBatch: 2 }

function uploaded(id = 'file-api-one'): Response {
  return new Response(JSON.stringify({
    id,
    object: 'file',
    bytes: 3,
    created_at: 1_000,
    filename: 'worldline-image.png',
    purpose: 'user_data',
    expires_at: 4_600,
  }), { status: 200 })
}

describe('DeepSeekFileStore', () => {
  it('uploads once and reuses the durable variant mapping', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(uploaded())) as typeof fetch
    const files = await store(fetchImpl)
    await expect(files.ensureUploaded(version(), connection, policy)).resolves.toMatchObject({
      uploaded: true,
      record: { fileId: 'file-api-one' },
    })
    await expect(files.ensureUploaded(version(), connection, policy)).resolves.toMatchObject({
      uploaded: false,
      record: { fileId: 'file-api-one' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('shares one concurrent upload for the same endpoint and variant', async () => {
    let resolveUpload!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveUpload = resolve })
    const fetchImpl = vi.fn(() => pending) as typeof fetch
    const files = await store(fetchImpl)
    const first = files.ensureUploaded(version(), connection, policy)
    const second = files.ensureUploaded(version(), connection, policy)
    resolveUpload(uploaded())
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('removes only Worldline-owned files before one quota retry', async () => {
    let uploads = 0
    const deleted: string[] = []
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/files?')) {
        return Promise.resolve(new Response(JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'foreign', object: 'file', bytes: 1, created_at: 1,
              filename: 'other.png', purpose: 'user_data', expires_at: 4_600,
            },
            {
              id: 'owned', object: 'file', bytes: 1, created_at: 2,
              filename: 'worldline-old.png', purpose: 'user_data', expires_at: 4_600,
            },
          ],
          has_more: false,
        }), { status: 200 }))
      }
      if (init?.method === 'DELETE') {
        const id = url.split('/').at(-1) as string
        deleted.push(id)
        return Promise.resolve(new Response(JSON.stringify({ id, object: 'file', deleted: true }), {
          status: 200,
        }))
      }
      uploads += 1
      if (uploads === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 'file_quota', message: 'storage quota exceeded' },
        }), { status: 400 }))
      }
      return Promise.resolve(uploaded('file-after-cleanup'))
    }) as typeof fetch
    const files = await store(fetchImpl)

    await expect(files.ensureUploaded(version(), connection, policy)).resolves.toMatchObject({
      record: { fileId: 'file-after-cleanup' },
    })
    expect(uploads).toBe(2)
    expect(deleted).toEqual(['owned'])
  })

  it('invalidates an exact stale mapping so the next request uploads again', async () => {
    let uploads = 0
    const fetchImpl = vi.fn(() => Promise.resolve(uploaded(`file-${++uploads}`))) as typeof fetch
    const files = await store(fetchImpl)
    const first = await files.ensureUploaded(version(), connection, policy)
    await files.invalidate(version(), first.record.fileId, connection)
    const second = await files.ensureUploaded(version(), connection, policy)
    expect(second.record.fileId).toBe('file-2')
    expect(uploads).toBe(2)
  })
})
