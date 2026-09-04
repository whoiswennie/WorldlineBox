import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  WWS_VERSION,
  WORLDLINE_PROJECT_LAYOUT,
  stableStringify,
  worldlineId,
  type Blueprint,
  type ProjectId,
  type Revision,
  type RunSnapshot,
} from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineRunDatabase } from '@deepseek-ai/dsh-worldline-run-sqlite'
import LocalWorldlineProjects, { paginateTreeEntries } from '../src/index.ts'
import { extractProjectArchive, preflightProjectArchive } from '../src/archive.ts'
import { accumulateArchiveExpandedBytes } from '../src/archive-core.ts'
import { preflightBlueprintArchive, preflightRunArchive } from '../src/artifact-archive.ts'
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

async function writeZip(path: string, entries: readonly (readonly [string, string])[]): Promise<void> {
  const zip = new ZipFile()
  for (const [name, content] of entries) zip.addBuffer(Buffer.from(content), name)
  const writing = pipeline(zip.outputStream, createWriteStream(path))
  zip.end()
  await writing
}

function replaceZipEntryName(archive: Buffer, source: string, replacement: string): Buffer {
  expect(Buffer.byteLength(source)).toBe(Buffer.byteLength(replacement))
  const result = Buffer.from(archive)
  const needle = Buffer.from(source)
  let offset = 0
  let replacements = 0
  while ((offset = result.indexOf(needle, offset)) >= 0) {
    Buffer.from(replacement).copy(result, offset)
    offset += needle.length
    replacements += 1
  }
  expect(replacements).toBeGreaterThanOrEqual(2)
  return result
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

function frozenBlueprint(projectId: ProjectId): Blueprint {
  const digest = 'b'.repeat(64)
  return {
    id: worldlineId<'blueprint'>(`blueprint:${digest}`),
    digest,
    format: WWS_VERSION,
    projectId,
    worldId: worldlineId<'world'>('world:archive-test'),
    worldlineId: worldlineId<'worldline'>('worldline:archive-test'),
    projectRevision: 'sha256:archive-test' as Revision,
    createdAt: '2026-01-01T00:00:00.000Z',
    purpose: {
      summary: 'archive',
      scope: [],
      duration: 10,
      resolution: 1,
      detail: 'L2',
      hardExpectations: [],
      statisticalExpectations: [],
      antiPatterns: [],
    },
    canon: [], links: [], maps: [], entities: [], actions: [], systems: [], invariants: [],
    provenance: [],
    modelPolicy: { routes: {}, aiEnabled: false, revision: 'sha256:model' as Revision },
    certificate: {
      blueprintDigest: digest,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceCoverage: {
        author: 1,
        'approved-supplement': 0,
        'mechanism-pack': 0,
        import: 0,
        'agent-proposal': 0,
        'runtime-proposal': 0,
      },
      results: [],
      deterministicWithoutAi: true,
      knownLimits: [],
      performance: {},
    },
  }
}

function runSnapshot(blueprint: Blueprint): RunSnapshot {
  return {
    runId: worldlineId<'run'>('run:archive-test'),
    blueprintId: blueprint.id,
    blueprintDigest: blueprint.digest,
    branchId: worldlineId<'worldline'>('worldline:archive-run'),
    seed: 'archive-seed',
    logicalTime: 10,
    sequence: 1,
    state: { place: 'harbor' },
    processes: [], reservations: [], futureEvents: [], randomState: 'archive-random',
    modelPolicy: blueprint.modelPolicy,
    aiUsage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0, cacheHits: 0 },
    presentationCursors: {},
    actionDecks: {},
    storyProgress: {},
    storyStateCommits: {},
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('LocalWorldlineProjects', () => {
  it('accounts for a synthetic 20 GiB archive in bounded metadata memory', () => {
    const oneGiB = 1024 ** 3
    const total = Array.from({ length: 20 }, (_, index) => ({
      path: `payload/chunk-${String(index).padStart(2, '0')}.bin`,
      compressedBytes: 2 * 1024 ** 2,
      expandedBytes: oneGiB,
    })).reduce(accumulateArchiveExpandedBytes, 0)
    expect(total).toBe(20 * oneGiB)
    expect(() => accumulateArchiveExpandedBytes(128 * oneGiB, {
      path: 'payload/overflow.bin',
      compressedBytes: 2 * 1024 ** 2,
      expandedBytes: oneGiB,
    })).toThrow(/expanded size exceeds/u)
  })

  it('paginates 50,000 metadata names without constructing an unbounded response', () => {
    const entries = Array.from({ length: 50_000 }, (_, index) => ({
      name: `entry-${String(index).padStart(5, '0')}`,
    }))
    const first = paginateTreeEntries(entries, undefined, 200)
    const second = paginateTreeEntries(entries, first.nextCursor, 200)
    expect(first.entries).toHaveLength(200)
    expect(first.nextCursor).toBe('entry-00199')
    expect(second.entries).toHaveLength(200)
    expect(second.entries[0]?.name).toBe('entry-00200')
    expect(second.nextCursor).toBe('entry-00399')
  })

  it('serves one directory through stable bounded cursor pages', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Paged', template: 'blank' })
    const directory = join(project.path, 'bulk')
    await mkdir(directory, { recursive: true })
    await Promise.all(Array.from({ length: 401 }, async (_, index) => {
      await writeFile(join(directory, `note-${String(index).padStart(3, '0')}.md`), '# Note\n')
    }))
    const first = await runtime.ctx.worldlineProjects.tree({
      projectId: project.manifest.id,
      path: 'bulk',
      limit: 200,
    })
    if (first.nextCursor === undefined) throw new Error('first tree page did not return a cursor')
    const second = await runtime.ctx.worldlineProjects.tree({
      projectId: project.manifest.id,
      path: 'bulk',
      limit: 200,
      cursor: first.nextCursor,
    })
    if (second.nextCursor === undefined) throw new Error('second tree page did not return a cursor')
    const third = await runtime.ctx.worldlineProjects.tree({
      projectId: project.manifest.id,
      path: 'bulk',
      limit: 200,
      cursor: second.nextCursor,
    })
    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([200, 200, 1])
    expect(new Set([...first.entries, ...second.entries, ...third.entries].map(entry => entry.path)).size)
      .toBe(401)
    expect(third).toMatchObject({ truncated: false })
    expect(third.nextCursor).toBeUndefined()
    await runtime.dispose()
  })

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
    expect(manifest).toContain('format = "0.3.0"')
    expect(manifest).not.toContain('apiKey')
    const expectedDirectories = [
      ...Object.values(WORLDLINE_PROJECT_LAYOUT.canonDirectories),
      WORLDLINE_PROJECT_LAYOUT.mediaDirectory,
      WORLDLINE_PROJECT_LAYOUT.control.history,
      WORLDLINE_PROJECT_LAYOUT.control.builds,
      WORLDLINE_PROJECT_LAYOUT.control.runs,
      WORLDLINE_PROJECT_LAYOUT.control.trash,
      WORLDLINE_PROJECT_LAYOUT.control.transfers,
    ]
    await expect(Promise.all(expectedDirectories.map(async directory =>
      await readdir(join(page.projects[0]!.path, directory))))).resolves.toHaveLength(expectedDirectories.length)
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
    const released: ProjectId[] = []
    runtime.ctx.on('worldline-project/release', (releasedProjectId) => {
      released.push(releasedProjectId)
    })
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
    expect(released).toEqual([projectId])
    await expect(runtime.ctx.worldlineProjects.library()).resolves.toMatchObject({ total: 0 })
    const restored = await runtime.ctx.worldlineProjects.restoreProject({ trashId: removed.trashId })
    expect(restored.manifest.id).toBe(projectId)
    await runtime.dispose()
  })

  it('logically recycles a project without relocating an open Run database', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Open ledger', template: 'blank' })
    const runId = worldlineId<'run'>('run:open-ledger')
    const storage = await runtime.ctx.worldlineProjects.runStorage(project.manifest.id, runId)
    const database = new WorldlineRunDatabase(storage.databasePath)

    try {
      const trashed = await runtime.ctx.worldlineProjects.trashProject({ projectId: project.manifest.id })

      expect(await readFile(join(project.path, 'worldline.toml'), 'utf8')).toContain(project.manifest.id)
      expect(await readFile(storage.databasePath)).not.toHaveLength(0)
      await expect(runtime.ctx.worldlineProjects.library()).resolves.toMatchObject({ total: 0 })
      await expect(runtime.ctx.worldlineProjects.runStorage(project.manifest.id, runId))
        .rejects.toMatchObject({ code: 'project-not-found' })
      const listed = await runtime.ctx.worldlineProjects.listTrashedProjects()
      expect(listed).toHaveLength(1)
      expect(listed[0]?.trashId).toBe(trashed.trashId)
      expect(listed[0]?.manifest?.id).toBe(project.manifest.id)

      const restored = await runtime.ctx.worldlineProjects.restoreProject({ trashId: trashed.trashId })
      expect(restored.path).toBe(project.path)
      expect((await runtime.ctx.worldlineProjects.runStorage(project.manifest.id, runId)).databasePath)
        .toBe(storage.databasePath)
    } finally {
      database.close()
      await runtime.dispose()
    }
  })

  it('keeps logical project trash authoritative across provider restarts', async () => {
    const root = await temporaryRoot()
    const first = await start(root)
    const project = await first.ctx.worldlineProjects.create({ name: 'Durable trash', template: 'blank' })
    const trashed = await first.ctx.worldlineProjects.trashProject({ projectId: project.manifest.id })
    await first.dispose()

    const second = await start(root)
    await expect(second.ctx.worldlineProjects.library()).resolves.toMatchObject({ total: 0 })
    await expect(second.ctx.worldlineProjects.listTrashedProjects()).resolves.toEqual([
      expect.objectContaining({ trashId: trashed.trashId, originalName: 'durable-trash' }),
    ])
    await second.ctx.worldlineProjects.restoreProject({ trashId: trashed.trashId })
    const restoredLibrary = await second.ctx.worldlineProjects.library()
    expect(restoredLibrary.total).toBe(1)
    expect(restoredLibrary.projects[0]?.manifest.id).toBe(project.manifest.id)
    await second.dispose()
  })

  it('permanently empties the project recycle bin only when explicitly requested', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const first = await runtime.ctx.worldlineProjects.create({ name: 'First trash', template: 'blank' })
    const second = await runtime.ctx.worldlineProjects.create({ name: 'Second trash', template: 'blank' })
    await runtime.ctx.worldlineProjects.trashProject({ projectId: first.manifest.id })
    await runtime.ctx.worldlineProjects.trashProject({ projectId: second.manifest.id })

    await expect(runtime.ctx.worldlineProjects.emptyProjectTrash()).resolves.toBe(2)
    await expect(runtime.ctx.worldlineProjects.listTrashedProjects()).resolves.toEqual([])
    await expect(runtime.ctx.worldlineProjects.emptyProjectTrash()).resolves.toBe(0)
    await runtime.dispose()
  })

  it('keeps a project in place when a resource owner cannot release it', async () => {
    const root = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Busy', template: 'blank' })
    runtime.ctx.on('worldline-project/release', () => {
      throw new Error('synthetic resource release failure')
    })

    await expect(runtime.ctx.worldlineProjects.trashProject({ projectId: project.manifest.id }))
      .rejects.toMatchObject({ code: 'project-busy' })
    const library = await runtime.ctx.worldlineProjects.library()
    expect(library.total).toBe(1)
    expect(library.projects.map(item => item.manifest.id)).toEqual([project.manifest.id])
    await expect(runtime.ctx.worldlineProjects.listTrashedProjects()).resolves.toEqual([])
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

  it('selects an isolated author workspace without copying the previous library', async () => {
    const source = await temporaryRoot()
    const destination = await temporaryRoot()
    const runtime = await start(source)
    const existing = await runtime.ctx.worldlineProjects.create({ name: 'Existing', template: 'blank' })

    const selected = await runtime.ctx.worldlineProjects.setRoot({
      path: destination,
      relocateExisting: false,
    })

    expect(selected).toMatchObject({
      source,
      destination,
      projects: [],
      conflicts: [],
      requiredBytes: 0,
      dryRun: false,
    })
    expect((await runtime.ctx.worldlineProjects.root()).path).toBe(destination)
    await expect(runtime.ctx.worldlineProjects.library()).resolves.toMatchObject({ total: 0 })
    expect(await readFile(join(source, 'existing', 'worldline.toml'), 'utf8'))
      .toContain(existing.manifest.id)
    await runtime.dispose()
  })

  it('streams a project archive through an observable transfer job', async () => {
    const source = await temporaryRoot()
    const destination = await temporaryRoot()
    const archiveDirectory = await temporaryRoot()
    const archive = join(archiveDirectory, 'portable.worldline.zip')
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
      await reader.ctx.worldlineProjects.importProject({ source: archive, conflict: 'copy' }),
    )
    expect(imported).toMatchObject({ state: 'completed', resultProjectId: project.manifest.id })
    const page = await reader.ctx.worldlineProjects.library()
    expect(page.projects[0]).toMatchObject({ manifest: { id: project.manifest.id } })
    expect(await readFile(join(page.projects[0]!.path, 'assets', 'cover.bin'))).toHaveLength(1024 * 1024)
    await reader.dispose()
  })

  it('applies explicit duplicate project policies without retaining duplicate identities', async () => {
    const root = await temporaryRoot()
    const archiveDirectory = await temporaryRoot()
    const archive = join(archiveDirectory, 'conflict.worldline.zip')
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Conflict', template: 'blank' })
    const charter = join(project.path, 'canon', 'charter.md')
    await waitForTransfer(runtime.ctx, await runtime.ctx.worldlineProjects.exportProject({
      projectId: project.manifest.id,
      destination: archive,
    }))
    await writeFile(charter, 'local mutation', 'utf8')

    const cancelled = await waitForTransfer(runtime.ctx, await runtime.ctx.worldlineProjects.importProject({
      source: archive,
      conflict: 'cancel',
    }))
    expect(cancelled).toMatchObject({ state: 'failed' })
    expect(await readFile(charter, 'utf8')).toBe('local mutation')

    const copied = await waitForTransfer(runtime.ctx, await runtime.ctx.worldlineProjects.importProject({
      source: archive,
      conflict: 'copy',
    }))
    expect(copied.state).toBe('completed')
    expect(copied.resultProjectId).not.toBe(project.manifest.id)
    const afterCopy = await runtime.ctx.worldlineProjects.library()
    expect(new Set(afterCopy.projects.map(item => item.manifest.id)).size).toBe(2)

    const replaced = await waitForTransfer(runtime.ctx, await runtime.ctx.worldlineProjects.importProject({
      source: archive,
      conflict: 'replace',
    }))
    expect(replaced).toMatchObject({ state: 'completed', resultProjectId: project.manifest.id })
    const restored = (await runtime.ctx.worldlineProjects.library()).projects
      .find(item => item.manifest.id === project.manifest.id)
    expect(restored).toBeDefined()
    expect(await readFile(join(restored!.path, 'canon', 'charter.md'), 'utf8')).not.toBe('local mutation')
    expect((await runtime.ctx.worldlineProjects.listTrashedProjects())
      .some(item => item.manifest?.id === project.manifest.id)).toBe(true)
    await runtime.dispose()
  })

  it('rejects duplicate and path-traversing ZIP entries during preflight', async () => {
    const archiveDirectory = await temporaryRoot()
    const duplicate = join(archiveDirectory, 'duplicate.worldline.zip')
    const manifest = JSON.stringify({
      format: WWS_VERSION,
      kind: 'project',
      projectId: 'project:01HZZZZZZZZZZZZZZZZZZZZZZZ',
      rootDirectory: 'world',
      createdAt: new Date().toISOString(),
      fileCount: 1,
      expandedBytes: 1,
      includesRuns: false,
      dependencies: [],
      files: [{ path: 'worldline.toml', bytes: 1, sha256: '0'.repeat(64) }],
    })
    await writeZip(duplicate, [
      ['worldline-archive.json', manifest],
      ['payload/world/worldline.toml', 'a'],
      ['payload/world/worldline.toml', 'b'],
    ])
    await expect(preflightProjectArchive(duplicate)).rejects.toThrow(/duplicate entry/u)

    const traversal = join(archiveDirectory, 'traversal.worldline.zip')
    await writeZip(traversal, [['aa/escape', 'outside']])
    await writeFile(traversal, replaceZipEntryName(await readFile(traversal), 'aa/escape', '../escape'))
    await expect(preflightProjectArchive(traversal)).rejects.toThrow(/invalid relative path|unsafe ZIP entry path/u)
  })

  it('keeps cancelled transfers cancelled and removes partial archive output', async () => {
    const root = await temporaryRoot()
    const archiveDirectory = await temporaryRoot()
    const destination = join(archiveDirectory, 'cancelled.worldline.zip')
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Cancel', template: 'blank' })
    await mkdir(join(project.path, 'assets'), { recursive: true })
    await writeFile(join(project.path, 'assets', 'large.bin'), Buffer.alloc(32 * 1024 * 1024, 9))
    const initial = await runtime.ctx.worldlineProjects.exportProject({
      projectId: project.manifest.id,
      destination,
    })
    expect(await runtime.ctx.worldlineProjects.cancelTransfer(initial.id)).toMatchObject({ state: 'cancelled' })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await readdir(archiveDirectory)).length === 0) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(await runtime.ctx.worldlineProjects.transfer(initial.id)).toMatchObject({ state: 'cancelled' })
    expect(await readdir(archiveDirectory)).toEqual([])
    await runtime.dispose()
  })

  it('verifies every extracted payload against the manifest SHA-256', async () => {
    const archiveDirectory = await temporaryRoot()
    const extraction = await temporaryRoot()
    const archive = join(archiveDirectory, 'digest.worldline.zip')
    const payload = 'actual payload'
    const declaredDigest = createHash('sha256').update('forged payload').digest('hex')
    await writeZip(archive, [
      ['worldline-archive.json', JSON.stringify({
        format: WWS_VERSION,
        kind: 'project',
        projectId: 'project:01HZZZZZZZZZZZZZZZZZZZZZZZ',
        rootDirectory: 'world',
        createdAt: new Date().toISOString(),
        fileCount: 1,
        expandedBytes: Buffer.byteLength(payload),
        includesRuns: false,
        dependencies: [],
        files: [{ path: 'worldline.toml', bytes: Buffer.byteLength(payload), sha256: declaredDigest }],
      })],
      ['payload/world/worldline.toml', payload],
    ])
    const preflight = await preflightProjectArchive(archive)
    await expect(extractProjectArchive({
      source: archive,
      destination: extraction,
      preflight,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toThrow(/digest failed/u)
  })

  it('round-trips frozen Blueprint and logical Run archives through transfer jobs', async () => {
    const root = await temporaryRoot()
    const archiveDirectory = await temporaryRoot()
    const runtime = await start(root)
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Artifacts', template: 'blank' })
    const blueprint = frozenBlueprint(project.manifest.id)
    const sourceDigest = 'a'.repeat(64)
    await runtime.ctx.worldlineProjects.storeBuild({
      projectId: project.manifest.id,
      digest: blueprint.digest,
      blueprint: `${JSON.stringify(blueprint, null, 2)}\n`,
      certificate: `${JSON.stringify(blueprint.certificate, null, 2)}\n`,
      sourceSnapshot: `${JSON.stringify({
        projectId: project.manifest.id,
        capturedAt: '2026-01-01T00:00:00.000Z',
        digest: sourceDigest,
        files: [],
      }, null, 2)}\n`,
    })
    const blueprintArchive = join(archiveDirectory, 'frozen.worldline-blueprint.zip')
    const exportedBlueprint = await waitForTransfer(runtime.ctx,
      await runtime.ctx.worldlineProjects.exportBlueprint({
        projectId: project.manifest.id,
        destination: blueprintArchive,
      }))
    expect(exportedBlueprint).toMatchObject({
      state: 'completed',
      resultBlueprintDigest: blueprint.digest,
    })
    expect((await preflightBlueprintArchive(blueprintArchive)).manifest.files.map(file => file.path).sort())
      .toEqual(['blueprint.json', 'certificate.json', 'source-snapshot.json'])
    await rm(join(project.path, '.worldline', 'builds'), { recursive: true, force: true })
    const importedBlueprint = await waitForTransfer(runtime.ctx,
      await runtime.ctx.worldlineProjects.importBlueprint({
        projectId: project.manifest.id,
        source: blueprintArchive,
      }))
    expect(importedBlueprint).toMatchObject({
      state: 'completed',
      resultBlueprintDigest: blueprint.digest,
    })
    await expect(runtime.ctx.worldlineProjects.activeBuild(project.manifest.id))
      .resolves.toMatchObject({ digest: blueprint.digest })

    const snapshot = runSnapshot(blueprint)
    const storage = await runtime.ctx.worldlineProjects.runStorage(project.manifest.id, snapshot.runId)
    await writeFile(join(storage.databasePath, '..', 'blueprint.json'), JSON.stringify(blueprint))
    const database = new WorldlineRunDatabase(storage.databasePath)
    database.initialize(snapshot)
    database.commit({
      snapshot,
      records: [{
        sequence: 1,
        logicalTime: 10,
        stream: 'world-event',
        id: 'event:archive-000001',
        payload: { type: 'arrival' },
      }],
    })
    const checkpoint = {
      id: worldlineId<'checkpoint'>('checkpoint:archive-000001'),
      runId: snapshot.runId,
      sequence: snapshot.sequence,
      createdAt: '2026-01-01T00:00:00.000Z',
      snapshot,
      digest: createHash('sha256').update(stableStringify(snapshot)).digest('hex'),
    }
    database.saveCheckpoint(checkpoint, 'Arrival')
    database.close()

    const runArchive = join(archiveDirectory, 'play.worldline-run.zip')
    const exportedRun = await waitForTransfer(runtime.ctx,
      await runtime.ctx.worldlineProjects.exportRun({
        projectId: project.manifest.id,
        runId: snapshot.runId,
        destination: runArchive,
      }))
    expect(exportedRun).toMatchObject({ state: 'completed', resultRunId: snapshot.runId })
    const runManifest = (await preflightRunArchive(runArchive)).manifest
    expect(runManifest).toMatchObject({ recordCount: 1, checkpointCount: 1 })
    expect(runManifest.files.map(file => file.path)).not.toContain('world.sqlite')
    await expect(preflightBlueprintArchive(runArchive)).rejects.toThrow(/current blueprint archive contract/iu)
    await rm(join(storage.databasePath, '..'), { recursive: true, force: true })
    const importedRun = await waitForTransfer(runtime.ctx,
      await runtime.ctx.worldlineProjects.importRun({
        projectId: project.manifest.id,
        source: runArchive,
      }))
    expect(importedRun).toMatchObject({ state: 'completed', resultRunId: snapshot.runId })
    const restored = (await runtime.ctx.worldlineProjects.runStorages())
      .find(item => item.runId === snapshot.runId)
    expect(restored).toBeDefined()
    const restoredDatabase = new WorldlineRunDatabase(restored!.databasePath)
    expect(restoredDatabase.snapshot()).toMatchObject({ runId: snapshot.runId, sequence: 1 })
    expect(restoredDatabase.records()).toEqual([
      expect.objectContaining({ id: 'event:archive-000001' }),
    ])
    expect(restoredDatabase.checkpoints()).toHaveLength(1)
    restoredDatabase.close()
    expect(JSON.parse(await readFile(join(restored!.databasePath, '..', 'blueprint.json'), 'utf8')))
      .toMatchObject({ digest: blueprint.digest })
    await runtime.dispose()
  })
})
