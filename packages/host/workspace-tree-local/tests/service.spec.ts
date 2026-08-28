import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalWorkspaceTree from '../src/index.ts'

const roots: string[] = []

async function temp(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), name))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('LocalWorkspaceTree', () => {
  it('lists directories before files with explicit kinds', async () => {
    const root = await temp('worldline-tree-')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'README.md'), 'hello')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalWorkspaceTree)
    await fiber.await()
    const listing = await ctx.workspaceTree.list(root, root)
    expect(listing.entries).toMatchObject([
      { name: 'src', kind: 'directory' },
      { name: 'README.md', kind: 'file' },
    ])
    await fiber.dispose()
  })

  it('rejects paths outside the registered workspace and skips escaping links', async () => {
    const root = await temp('worldline-tree-root-')
    const outside = await temp('worldline-tree-outside-')
    await writeFile(join(outside, 'secret.txt'), 'private')
    await symlink(outside, join(root, 'outside-link'), 'junction')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalWorkspaceTree)
    await fiber.await()
    await expect(ctx.workspaceTree.list(root, outside)).rejects.toThrow(/outside the registered workspace/)
    expect((await ctx.workspaceTree.list(root, root)).entries).toEqual([])
    await fiber.dispose()
  })

  it('bounds each level and reports truncation', async () => {
    const root = await temp('worldline-tree-bound-')
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalWorkspaceTree, {
      maxEntries: 1,
      maxPreviewBytes: 20 * 1024 * 1024,
      watchDebounceMs: 350,
      maxSearchEntries: 20_000,
      maxSearchResults: 200,
    })
    await fiber.await()
    const listing = await ctx.workspaceTree.list(root, root)
    expect(listing.entries).toHaveLength(1)
    expect(listing.truncated).toBe(true)
    await fiber.dispose()
  })

  it('searches file names and relative paths while skipping generated dependency trees', async () => {
    const root = await temp('worldline-tree-search-')
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'main.ts'), 'export {}')
    await writeFile(join(root, 'src', 'main.test.ts'), 'test()')
    await writeFile(join(root, 'node_modules', 'main.js'), 'ignored')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalWorkspaceTree)
    await fiber.await()

    const listing = await ctx.workspaceTree.search(root, 'main')
    expect(listing.results.map(result => result.relativePath)).toEqual([
      'src/main.test.ts',
      'src/main.ts',
    ])
    expect(listing.scanned).toBeGreaterThan(0)
    expect(listing.truncated).toBe(false)
    await fiber.dispose()
  })

  it('clears every root entry, including hidden and nested content, without deleting the workspace root', async () => {
    const root = await temp('worldline-tree-clear-')
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'child.txt'), 'child')
    await writeFile(join(root, 'visible.txt'), 'visible')
    await writeFile(join(root, '.hidden'), 'hidden')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalWorkspaceTree)
    await fiber.await()

    await expect(ctx.workspaceTree.mutate(root, { operation: 'clear-workspace', path: join(root, 'nested') }))
      .rejects.toThrow(/only the registered workspace root/)
    await expect(ctx.workspaceTree.mutate(root, { operation: 'clear-workspace', path: root })).resolves.toEqual({})
    await expect(ctx.workspaceTree.list(root, root)).resolves.toMatchObject({ entries: [] })
    await fiber.dispose()
  })

  it('returns common media as bounded base64 previews and unknown binary as metadata', async () => {
    const root = await temp('worldline-tree-preview-')
    await writeFile(join(root, 'picture.avif'), Buffer.from([1, 2, 3]))
    await writeFile(join(root, 'sound.opus'), Buffer.from([4, 5, 6]))
    await writeFile(join(root, 'movie.ogv'), Buffer.from([7, 8, 9]))
    await writeFile(join(root, 'archive.zip'), Buffer.from([10, 11, 12]))
    const ctx = new Context()
    const fiber = ctx.plugin(LocalWorkspaceTree)
    await fiber.await()

    await expect(ctx.workspaceTree.preview(root, join(root, 'picture.avif'))).resolves.toMatchObject({ kind: 'image', mimeType: 'image/avif', encoding: 'base64', content: 'AQID' })
    await expect(ctx.workspaceTree.preview(root, join(root, 'sound.opus'))).resolves.toMatchObject({ kind: 'audio', encoding: 'base64', content: 'BAUG' })
    await expect(ctx.workspaceTree.preview(root, join(root, 'movie.ogv'))).resolves.toMatchObject({ kind: 'video', mimeType: 'video/ogg', encoding: 'base64', content: 'BwgJ' })
    const binary = await ctx.workspaceTree.preview(root, join(root, 'archive.zip'))
    expect(binary).toMatchObject({ kind: 'binary', mimeType: 'application/octet-stream' })
    expect('content' in binary).toBe(false)
    await fiber.dispose()
  })
})
