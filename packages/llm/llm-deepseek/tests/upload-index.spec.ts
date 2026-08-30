import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId } from '../src/file-id.ts'
import { deepSeekFileScope, DeepSeekUploadIndex } from '../src/upload-index.ts'
import type { DeepSeekUploadRecord } from '../src/upload-index.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function index(): Promise<{ index: DeepSeekUploadIndex; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'worldline-files-index-'))
  cleanups.push(dir)
  const path = join(dir, 'nested', 'files-v3.json')
  return { index: new DeepSeekUploadIndex(path), path }
}

function record(overrides: Partial<DeepSeekUploadRecord> = {}): DeepSeekUploadRecord {
  return {
    scope: deepSeekFileScope('https://api.deepseek.com', 'secret-key'),
    attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    fileId: DeepSeekFileId('file-api-one'),
    bytes: 3,
    createdAt: 1_000,
    expiresAt: 20_000,
    ...overrides,
  }
}

describe('DeepSeekUploadIndex', () => {
  it('persists reusable mappings without persisting API keys', async () => {
    const fixture = await index()
    const candidate = record()
    await expect(fixture.index.commit(candidate, 2_000, 1_000)).resolves.toEqual({
      record: candidate, accepted: true,
    })
    await expect(fixture.index.get(candidate.scope, candidate.variantId, 2_000, 1_000))
      .resolves.toEqual(candidate)
    const stored = await readFile(fixture.path, 'utf8')
    expect(stored).not.toContain('secret-key')
    expect(JSON.parse(stored)).toMatchObject({ formatVersion: 3 })
  })

  it('does not reuse a mapping inside its refresh margin', async () => {
    const fixture = await index()
    const candidate = record({ expiresAt: 5_000 })
    await fixture.index.commit(candidate, 1_000, 500)
    await expect(fixture.index.get(candidate.scope, candidate.variantId, 4_600, 500))
      .resolves.toBeUndefined()
  })

  it('keeps the first reusable concurrent winner', async () => {
    const fixture = await index()
    const first = record({ fileId: DeepSeekFileId('file-first') })
    const second = record({ fileId: DeepSeekFileId('file-second') })
    const results = await Promise.all([
      fixture.index.commit(first, 2_000, 1_000),
      fixture.index.commit(second, 2_000, 1_000),
    ])
    expect(results.filter(result => result.accepted)).toHaveLength(1)
    expect(results[0]?.record.fileId).toBe(results[1]?.record.fileId)
  })

  it('recovers safely from a truncated index', async () => {
    const fixture = await index()
    await writeFile(fixture.path, '{"formatVersion":3,"records":', { flag: 'wx' }).catch(async () => {
      // Parent creation is intentionally exercised through a first commit.
      const seed = record()
      await fixture.index.commit(seed, 1_000, 0)
      await writeFile(fixture.path, '{"formatVersion":3,"records":')
    })
    const candidate = record({ fileId: DeepSeekFileId('file-after-recovery') })
    await expect(fixture.index.commit(candidate, 2_000, 0)).resolves.toMatchObject({ accepted: true })
    await expect(fixture.index.get(candidate.scope, candidate.variantId, 2_000, 0))
      .resolves.toMatchObject({ fileId: 'file-after-recovery' })
  })

  it('removes only an exact mapping and can clear one endpoint scope', async () => {
    const fixture = await index()
    const first = record()
    const other = record({
      scope: deepSeekFileScope('https://other.example', 'other-key'),
      fileId: DeepSeekFileId('file-other'),
    })
    await fixture.index.commit(first, 1_000, 0)
    await fixture.index.commit(other, 1_000, 0)
    await fixture.index.remove(first.scope, first.variantId, DeepSeekFileId('wrong'))
    await expect(fixture.index.get(first.scope, first.variantId, 1_000, 0)).resolves.toEqual(first)
    await fixture.index.clear(first.scope)
    await expect(fixture.index.get(first.scope, first.variantId, 1_000, 0)).resolves.toBeUndefined()
    await expect(fixture.index.get(other.scope, other.variantId, 1_000, 0)).resolves.toEqual(other)
  })
})
