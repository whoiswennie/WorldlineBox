import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ProjectId, Revision } from '@deepseek-ai/dsh-worldline-standard'
import LocalWorldlineProjects from '../src/index.ts'
import type { TransferJob } from '@deepseek-ai/dsh-worldline-project'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'worldline-projects-'))
  roots.push(path)
  return path
}

async function waitForTransfer(ctx: Context, initial: TransferJob): Promise<TransferJob> {
  let current = initial
  for (let attempt = 0; attempt < 100 && (current.state === 'queued' || current.state === 'running'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    current = await ctx.worldlineProjects.transfer(initial.id)
  }
  return current
}

async function start(root: string): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalWorldlineProjects, {
    root,
    maxEntries: 5000,
    maxSearchFiles: 50_000,
  })
  await fiber.await()
  return { ctx, dispose: () => fiber.dispose() }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('LocalWorldlineProjects', () => {
  it('imports project entries as bounded durable streams without buffering the whole file', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Streaming', template: 'blank' })
    async function * bytes(): AsyncIterable<Uint8Array> {
      yield Uint8Array.from([0, 1])
      yield Uint8Array.from([2, 3, 4])
    }

    const imported = await runtime.ctx.worldlineProjects.importEntry({
      projectId: project.manifest.id,
      path: 'assets/pixel.bin',
      expectedBytes: 5,
    }, bytes())

    expect(imported.path).toBe('assets/pixel.bin')
    expect(await readFile(join(project.path, imported.path))).toEqual(Buffer.from([0, 1, 2, 3, 4]))
    await expect(runtime.ctx.worldlineProjects.importEntry({
      projectId: project.manifest.id,
      path: 'assets/truncated.bin',
      expectedBytes: 6,
    }, bytes())).rejects.toThrow('stream ended')
    await expect(readFile(join(project.path, 'assets', 'truncated.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    await runtime.dispose()
  })

  it('creates a portable file-source project and discovers it after a cold rescan', async () => {
    const root = await temporaryRoot()
    const first = await start(root)
    await first.ctx.worldlineProjects.create({ name: '苍穹纪事', template: 'world-encyclopedia' })
    const page = await first.ctx.worldlineProjects.library()
    expect(page.projects).toHaveLength(1)
    expect(page.projects[0]).toMatchObject({
      manifest: { name: '苍穹纪事', template: 'world-encyclopedia' },
      health: 'ready',
    })
    const manifest = await readFile(join(page.projects[0]!.path, 'worldline.toml'), 'utf8')
    expect(manifest).toContain('format = "0.1.0"')
    expect(manifest).not.toContain('apiKey')
    await first.dispose()

    const second = await start(root)
    await expect(second.ctx.worldlineProjects.library()).resolves.toMatchObject({ total: 1 })
    await second.dispose()
  })

  it('preserves document identity across edits and moves while rejecting stale autosaves', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Identity', template: 'blank' })
    const projectId = project.manifest.id
    const created = await runtime.ctx.worldlineProjects.write({
      projectId,
      path: 'characters/alice.md',
      content: '# Alice\n\nFirst version.',
      createParents: true,
      tags: ['lead'],
      objectKind: 'character',
    })
    const updated = await runtime.ctx.worldlineProjects.write({
      projectId,
      path: created.path,
      content: '# Alice\n\nSecond version.',
      expectedRevision: created.revision,
    })
    await expect(runtime.ctx.worldlineProjects.write({
      projectId,
      path: created.path,
      content: 'stale overwrite',
      expectedRevision: created.revision,
    })).rejects.toMatchObject({ code: 'revision-conflict' })
    const moved = await runtime.ctx.worldlineProjects.move({
      projectId,
      source: created.path,
      destination: 'characters/archived/alice.md',
      expectedRevision: updated.revision,
    })
    expect(moved.id).toBe(created.id)
    await expect(runtime.ctx.worldlineProjects.read({ projectId, path: moved.path }))
      .resolves.toMatchObject({ id: created.id, tags: ['lead'], objectKind: 'character' })
    await runtime.dispose()
  })

  it('records restorable history and provides project search and backlinks', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'History', template: 'blank' })
    const projectId = project.manifest.id
    const first = await runtime.ctx.worldlineProjects.write({
      projectId,
      path: 'lore/source.md',
      content: '# Source\n\nThe silver gate opens at dawn.',
      createParents: true,
    })
    const second = await runtime.ctx.worldlineProjects.write({
      projectId,
      path: first.path,
      content: '# Source\n\nThe silver gate is sealed.',
      expectedRevision: first.revision,
    })
    await runtime.ctx.worldlineProjects.write({
      projectId,
      path: 'lore/reference.md',
      content: `# Reference\n\nSee ${first.id} and ${first.path}.`,
      createParents: true,
    })
    await expect(runtime.ctx.worldlineProjects.history({ projectId, path: first.path }))
      .resolves.toMatchObject([{ revision: first.revision }])
    await expect(runtime.ctx.worldlineProjects.search({ projectId, query: 'silver gate' }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id })]))
    await expect(runtime.ctx.worldlineProjects.backlinks({ projectId, path: first.path }))
      .resolves.toHaveLength(2)
    const restored = await runtime.ctx.worldlineProjects.restoreRevision({
      projectId,
      path: first.path,
      revision: first.revision,
      expectedRevision: second.revision,
    })
    expect(restored.content).toContain('opens at dawn')
    await runtime.dispose()
  })

  it('uses recoverable trash for entries and whole projects', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Trash', template: 'blank' })
    const projectId = project.manifest.id
    const document = await runtime.ctx.worldlineProjects.write({
      projectId,
      path: 'notes/keep.md',
      content: 'recover me',
      createParents: true,
    })
    const trashed = await runtime.ctx.worldlineProjects.trashEntry({
      projectId,
      path: document.path,
      expectedRevision: document.revision,
    })
    await expect(runtime.ctx.worldlineProjects.read({ projectId, path: document.path }))
      .rejects.toMatchObject({ code: 'entry-not-found' })
    await runtime.ctx.worldlineProjects.restoreEntry({ projectId, trashId: trashed.trashId })
    await expect(runtime.ctx.worldlineProjects.read({ projectId, path: document.path }))
      .resolves.toMatchObject({ content: 'recover me', id: document.id })

    const removed = await runtime.ctx.worldlineProjects.trashProject({ projectId })
    await expect(runtime.ctx.worldlineProjects.library()).resolves.toMatchObject({ total: 0 })
    const restored = await runtime.ctx.worldlineProjects.restoreProject({ trashId: removed.trashId })
    expect(restored.manifest.id).toBe(projectId)
    await runtime.dispose()
  })

  it('rejects path traversal and does not accept a stale move revision', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Safety', template: 'blank' })
    const projectId: ProjectId = project.manifest.id
    await expect(runtime.ctx.worldlineProjects.write({
      projectId,
      path: '../escape.md',
      content: 'bad',
    })).rejects.toMatchObject({ code: 'path-invalid' })
    await expect(runtime.ctx.worldlineProjects.move({
      projectId,
      source: 'canon/charter.md',
      destination: 'canon/moved.md',
      expectedRevision: 'sha256:stale' as Revision,
    })).rejects.toMatchObject({ code: 'revision-conflict' })
    await runtime.dispose()
  })

  it('detects external edits and relocates libraries only after a dry-run plan', async () => {
    const source = await temporaryRoot()
    const destination = await temporaryRoot()
    const runtime = await start(source)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Relocation', template: 'blank' })
    const document = await runtime.ctx.worldlineProjects.read({
      projectId: project.manifest.id,
      path: 'canon/charter.md',
    })
    await writeFile(join(project.path, 'canon', 'charter.md'), 'external change', 'utf8')
    await expect(runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: document.path,
      content: 'stale editor value',
      expectedRevision: document.revision,
    })).rejects.toMatchObject({ code: 'revision-conflict' })

    const plan = await runtime.ctx.worldlineProjects.setRoot({ path: destination, dryRun: true })
    expect(plan).toMatchObject({ dryRun: true, projects: [{ id: project.manifest.id }] })
    expect((await runtime.ctx.worldlineProjects.root()).path).toBe(source)
    await runtime.ctx.worldlineProjects.setRoot({ path: destination })
    await expect(runtime.ctx.worldlineProjects.library()).resolves.toMatchObject({
      total: 1,
      projects: [{ manifest: { id: project.manifest.id } }],
    })
    expect(await readFile(join(source, 'relocation', 'worldline.toml'), 'utf8')).toContain(project.manifest.id)
    await runtime.dispose()
  })

  it('streams a project archive through an observable transfer job', async () => {
    const source = await temporaryRoot()
    const destination = await temporaryRoot()
    const archiveDirectory = await temporaryRoot()
    const archive = join(archiveDirectory, 'portable.worldline.tar.gz')
    const writer = await start(source)
    const project = await writer.ctx.worldlineProjects.create({ name: 'Portable', template: 'character-story' })
    await mkdir(join(project.path, 'assets'), { recursive: true })
    await writeFile(join(project.path, 'assets', 'cover.bin'), Buffer.alloc(1024 * 1024, 7))
    const exported = await waitForTransfer(writer.ctx, await writer.ctx.worldlineProjects.exportProject({
      projectId: project.manifest.id,
      destination: archive,
    }))
    expect(exported).toMatchObject({ state: 'completed' })
    expect(exported.completedBytes).toBeGreaterThan(0)
    await writer.dispose()

    const reader = await start(destination)
    const imported = await waitForTransfer(
      reader.ctx,
      await reader.ctx.worldlineProjects.importProject({ source: archive }),
    )
    expect(imported).toMatchObject({ state: 'completed', resultProjectId: project.manifest.id })
    const page = await reader.ctx.worldlineProjects.library()
    expect(page.projects[0]).toMatchObject({ manifest: { id: project.manifest.id } })
    expect(await readFile(join(page.projects[0]!.path, 'assets', 'cover.bin'))).toHaveLength(1024 * 1024)
    await reader.dispose()
  })
})
