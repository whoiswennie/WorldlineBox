import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import LocalAttachmentStore from '../src/index.ts'

const roots: string[] = []

async function store(config: ConstructorParameters<typeof LocalAttachmentStore>[1] = {}): Promise<LocalAttachmentStore> {
  const worldlineHome = await mkdtemp(join(tmpdir(), 'worldline-normalized-image-'))
  roots.push(worldlineHome)
  return new LocalAttachmentStore(new Context(), { worldlineHome, ...config })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('normalized attachments and request variants', () => {
  it('persists a downscaled metadata-free normalized image and records source dimensions', async () => {
    const service = await store({
      maxImagePixels: 8_000_000,
      maxImageDimension: 4_000,
      normalizedImageMaxPixels: 250_000,
      normalizedImageMaxDimension: 1_000,
      normalizedImageMaxBytes: 200_000,
    })
    const source = new Uint8Array(await sharp({
      create: { width: 1_200, height: 800, channels: 3, background: { r: 12, g: 34, b: 56 } },
    }).withMetadata({ orientation: 1 }).png().toBuffer())

    const ref = await service.saveImage({ data: source, mediaType: 'image/png', name: 'large.png' })
    const stored = await service.readImage(ref)
    const metadata = await sharp(stored.data).metadata()

    expect(ref.originalDimensions).toEqual({ width: 1_200, height: 800 })
    expect(ref.width * ref.height).toBeLessThanOrEqual(250_000)
    expect(metadata.exif).toBeUndefined()
    expect(metadata.orientation).toBeUndefined()
    expect(service.imageHostPath(ref)).toContain(join('attachments', 'v1', 'objects'))
    expect(new Uint8Array(await readFile(service.imageHostPath(ref)))).toEqual(stored.data)
    if (process.platform !== 'win32') expect((await stat(service.imageHostPath(ref))).mode & 0o777).toBe(0o400)
  })

  it('reuses a deterministic request variant and separates different route policies', async () => {
    const service = await store()
    const source = new Uint8Array(await sharp({
      create: { width: 1_600, height: 900, channels: 3, background: { r: 80, g: 120, b: 160 } },
    }).png().toBuffer())
    const ref = await service.saveImage({ data: source, mediaType: 'image/png' })

    const first = await service.readImageRequest(ref, { maxPixels: 160_000, maxBytes: 100_000 })
    const second = await service.readImageRequest(ref, { maxPixels: 160_000, maxBytes: 100_000 })
    const other = await service.readImageRequest(ref, { maxPixels: 80_000, maxBytes: 100_000 })

    expect(second.variantId).toBe(first.variantId)
    expect(second.data).toEqual(first.data)
    expect(first.width * first.height).toBeLessThanOrEqual(160_000)
    expect(first.depth).toBe('uchar')
    expect(first.space).toBe('srgb')
    expect(other.variantId).not.toBe(first.variantId)
    expect(other.width * other.height).toBeLessThanOrEqual(80_000)
  })

  it('keeps an existing 0.2.1 content-addressed object readable without rewriting it', async () => {
    const service = await store()
    const legacy = new Uint8Array(await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer())
    const { createHash } = await import('node:crypto')
    const { mkdir, writeFile } = await import('node:fs/promises')
    const digest = createHash('sha256').update(legacy).digest('hex')
    const object = join(service.root, 'objects', digest.slice(0, 2), digest)
    await mkdir(join(service.root, 'objects', digest.slice(0, 2)), { recursive: true })
    await writeFile(object, legacy)
    const ref = {
      attachmentId: `sha256:${digest}` as never,
      mediaType: 'image/png' as const,
      bytes: legacy.byteLength,
      width: 2,
      height: 2,
      name: 'legacy.png',
    }

    await expect(service.readImage(ref)).resolves.toEqual({ ref, data: legacy })
  })
})
