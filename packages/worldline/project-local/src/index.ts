import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  type DocumentId,
  PROJECT_MANIFEST,
  type ProjectId,
  type ProjectManifest,
  type ProjectTemplate,
  type RunId,
  WWS_VERSION,
  allocateWorldlineId,
  stableStringify,
} from '@deepseek-ai/dsh-worldline-standard'
import {
  type ActiveProjectBuild,
  type CopyEntryRequest,
  type CopyProjectRequest,
  type CreateDirectoryRequest,
  type CreateProjectRequest,
  type DocumentHistoryEntry,
  type DocumentView,
  type ExportProjectRequest,
  type HistoryRequest,
  type ImportProjectRequest,
  type ImportProjectEntryRequest,
  type MoveEntryRequest,
  type MutationResult,
  type ProjectLibraryPage,
  type ProjectLibraryQuery,
  type ProjectLink,
  type ProjectRootView,
  type ProjectRunStorage,
  type ProjectSourceFile,
  type ProjectSourceSnapshot,
  type ProjectSearchHit,
  type ProjectSummary,
  type ProjectTreeEntry,
  type ProjectTreeListing,
  type ProjectTreeRequest,
  type ReadDocumentRequest,
  type RestoreEntryRequest,
  type RestoreProjectRequest,
  type RestoreRevisionRequest,
  type RootRelocationPlan,
  type SearchProjectRequest,
  type SetProjectRootRequest,
  type StoreProjectBuildRequest,
  type TransferJob,
  type TrashEntryRequest,
  type TrashedEntry,
  type TrashedProject,
  type TrashProjectRequest,
  type WriteDocumentRequest,
  type WriteProjectControlRequest,
  type ProjectControlDocument,
  WorldlineProjectError,
  WorldlineProjects,
} from '@deepseek-ai/dsh-worldline-project'
import { exportProjectArchive, extractProjectArchive, preflightProjectArchive } from './archive.ts'
import { readManifest, writeManifest } from './manifest.ts'
import { ProjectMetadata } from './metadata.ts'
import {
  CONTROL_DIRECTORY,
  assertNoSymlink,
  canonicalRoot,
  directorySize,
  durableWrite,
  durableWriteStream,
  exists,
  messageOf,
  normalizeRelative,
  readTextBounded,
  resolveInside,
  revisionOf,
  walk,
} from './storage.ts'

export interface Config {
  /** Initial library root; the settings namespace supersedes it when available. */
  root: string
  /** Bound for one directory listing. */
  maxEntries: number
  /** Bound for one project-wide text search. */
  maxSearchFiles: number
}

interface ProjectSettings { readonly root: string }
interface EntryTrashMetadata {
  readonly originalPath: string
  readonly deletedAt: string
  readonly kind: TrashedEntry['kind']
  readonly sizeBytes: number
}
interface ProjectTrashMetadata {
  readonly originalName: string
  readonly deletedAt: string
  readonly sizeBytes: number
}

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv'])
const SETTINGS_NAMESPACE = settingsNamespace('worldline-project')
const SETTINGS_SCHEMA = z.object({ root: z.string().default('') })

function slugify(value: string): string {
  const slug = value.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
  if (slug === '') throw new WorldlineProjectError('path-invalid', 'project name must contain a letter or number')
  return slug.slice(0, 80)
}

function now(): string { return new Date().toISOString() }

function kindOf(path: string, directory: boolean): ProjectTreeEntry['kind'] {
  if (directory) return 'directory'
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) ? 'document' : 'asset'
}

function titleOf(path: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
  return heading ?? basename(path, extname(path))
}

function excerptAround(content: string, query: string): string {
  const normalized = content.toLocaleLowerCase()
  const index = normalized.indexOf(query.toLocaleLowerCase())
  const start = Math.max(0, index < 0 ? 0 : index - 80)
  return content.slice(start, start + 240).replace(/\s+/g, ' ').trim()
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Durable local provider. Files remain the source of truth; all control data is rebuildable sidecar state. */
export default class LocalWorldlineProjects extends WorldlineProjects {
  static Config: z<Config> = z.object({
    root: z.string().default(''),
    maxEntries: z.natural().min(1).default(5000),
    maxSearchFiles: z.natural().min(1).default(50_000),
  })

  private settings: SettingsScope<ProjectSettings> | undefined
  private configuredRoot: string
  private scannedAt: string | undefined
  private projectCache = new Map<ProjectId, string>()
  private readonly jobs = new Map<string, TransferJob & { controller?: AbortController }>()
  private readonly context: Context

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    this.context = ctx
    this.configuredRoot = config.root
    ctx.inject(['settings'], (settingsCtx) => {
      const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, SETTINGS_SCHEMA, {
        base: { root: config.root },
        exposeToClients: true,
      })
      this.settings = scope
      this.configuredRoot = scope.get().root
      scope.watch((next) => {
        this.configuredRoot = next.root
        this.projectCache.clear()
        this.scannedAt = undefined
      })
      return () => { this.settings = undefined }
    })
  }

  private async rootPath(): Promise<string> {
    if (this.configuredRoot.trim() === '') {
      throw new WorldlineProjectError('root-not-configured', 'choose a Worldline project root first')
    }
    try { return await canonicalRoot(this.configuredRoot) } catch (error) {
      if (error instanceof WorldlineProjectError) throw error
      throw new WorldlineProjectError('root-unreadable', messageOf(error))
    }
  }

  private async scan(requestedRoot?: string): Promise<ProjectSummary[]> {
    const root = requestedRoot ?? await this.rootPath()
    const summaries: ProjectSummary[] = []
    const cache = new Map<ProjectId, string>()
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const path = resolve(root, entry.name)
      if (!(await exists(resolve(path, PROJECT_MANIFEST)))) continue
      try {
        const summary = await this.summarize(path)
        summaries.push(summary)
        cache.set(summary.manifest.id, path)
      } catch (error) {
        this.context.logger('worldline-project').warn(
          'ignored damaged project %s: %s',
          path,
          messageOf(error),
        )
      }
    }
    this.projectCache = cache
    this.scannedAt = now()
    return summaries
  }

  private async projectPath(projectId: ProjectId): Promise<string> {
    let path = this.projectCache.get(projectId)
    if (path === undefined) {
      await this.scan()
      path = this.projectCache.get(projectId)
    }
    if (path === undefined) {
      throw new WorldlineProjectError('project-not-found', `Worldline project not found: ${projectId}`)
    }
    return path
  }

  private async summarize(path: string): Promise<ProjectSummary> {
    const manifest = await readManifest(path)
    const entries = await walk(path)
    const documentCount = entries.filter(entry => entry.dirent.isFile()
      && TEXT_EXTENSIONS.has(extname(entry.relativePath).toLowerCase())).length
    return {
      manifest,
      path,
      health: 'ready',
      status: await exists(resolve(path, '.worldline', 'builds', 'active'))
        ? 'frozen'
        : 'draft',
      sizeBytes: await directorySize(path),
      documentCount,
    }
  }

  private async metadata(projectPath: string): Promise<ProjectMetadata> {
    const metadata = new ProjectMetadata(projectPath)
    await metadata.load()
    return metadata
  }

  async root(): Promise<ProjectRootView> {
    if (this.configuredRoot.trim() === '') {
      return { configured: false, writable: false, projectCount: 0 }
    }
    const root = await this.rootPath()
    const projects = await this.scan(root)
    return {
      configured: true,
      path: root,
      writable: true,
      projectCount: projects.length,
      ...(this.scannedAt === undefined ? {} : { scannedAt: this.scannedAt }),
    }
  }

  async setRoot(request: SetProjectRootRequest): Promise<RootRelocationPlan> {
    const destination = await canonicalRoot(request.path, request.create !== false)
    const source = this.configuredRoot.trim() === '' ? undefined : await this.rootPath()
    const sourceProjects = source === undefined || source === destination ? [] : await this.scan(source)
    const destinationNames = new Set((await readdir(destination, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name.toLocaleLowerCase()))
    const projects = sourceProjects.map(project => ({
      id: project.manifest.id,
      name: basename(project.path),
      bytes: project.sizeBytes,
    }))
    const conflicts = projects.filter(project => destinationNames.has(project.name.toLocaleLowerCase()))
      .map(project => project.name)
    const plan: RootRelocationPlan = {
      ...(source === undefined ? {} : { source }),
      destination,
      projects,
      conflicts,
      requiredBytes: projects.reduce((sum, project) => sum + project.bytes, 0),
      dryRun: request.dryRun === true,
    }
    if (request.dryRun === true) return plan
    if (conflicts.length > 0) {
      throw new WorldlineProjectError('manifest-conflict', 'destination contains conflicting projects', {
        conflicts: conflicts.join(', '),
      })
    }
    if (source !== undefined && source !== destination) {
      const staging = resolve(destination, '.worldline-relocation', randomUUID())
      const committed: string[] = []
      try {
        await mkdir(staging, { recursive: true })
        for (const project of projects) {
          const staged = resolve(staging, project.name)
          await cp(resolve(source, project.name), staged, {
            recursive: true,
            errorOnExist: true,
            force: false,
          })
          const manifest = await readManifest(staged)
          if (manifest.id !== project.id) throw new Error(`project verification failed: ${project.name}`)
        }
        for (const project of projects) {
          const committedPath = resolve(destination, project.name)
          await rename(resolve(staging, project.name), committedPath)
          committed.push(committedPath)
        }
      } catch (error) {
        await Promise.all(committed.map(path => rm(path, { recursive: true, force: true })))
        throw error
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
    if (this.settings !== undefined) await this.settings.update({ root: destination })
    this.configuredRoot = destination
    await this.scan(destination)
    return plan
  }

  async library(query: ProjectLibraryQuery = {}): Promise<ProjectLibraryPage> {
    const root = await this.root()
    let projects = await this.scan()
    const search = query.search?.trim().toLocaleLowerCase()
    if (search !== undefined && search !== '') {
      projects = projects.filter(project => [project.manifest.name, project.manifest.description,
        ...project.manifest.tags].some(value => value.toLocaleLowerCase().includes(search)))
    }
    if (query.tags !== undefined && query.tags.length > 0) {
      const tags = query.tags
      projects = projects.filter(project => tags.every(tag => project.manifest.tags.includes(tag)))
    }
    if (query.template !== undefined) projects = projects.filter(project => project.manifest.template === query.template)
    projects.sort((left, right) => {
      if (query.sort === 'name-asc') return left.manifest.name.localeCompare(right.manifest.name)
      if (query.sort === 'created-desc') return right.manifest.createdAt.localeCompare(left.manifest.createdAt)
      return right.manifest.updatedAt.localeCompare(left.manifest.updatedAt)
    })
    const total = projects.length
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.min(200, Math.max(1, query.limit ?? 50))
    return { root, projects: projects.slice(offset, offset + limit), total }
  }

  async rescan(): Promise<TransferJob> {
    const job = this.beginJob('rescan')
    try {
      await this.scan()
      return this.finishJob(job.id)
    } catch (error) {
      return this.failJob(job.id, error)
    }
  }

  async create(request: CreateProjectRequest): Promise<ProjectSummary> {
    const root = await this.rootPath()
    const folder = await this.availableName(root, slugify(request.name))
    const path = resolve(root, folder)
    await mkdir(path, { recursive: false })
    try {
      const timestamp = now()
      const manifest: ProjectManifest = {
        format: WWS_VERSION,
        id: allocateWorldlineId<'project'>('project'),
        name: request.name.trim(),
        description: request.description?.trim() ?? '',
        createdAt: timestamp,
        updatedAt: timestamp,
        defaultWorldId: allocateWorldlineId<'world'>('world'),
        defaultWorldlineId: allocateWorldlineId<'worldline'>('worldline'),
        template: request.template,
        tags: request.tags ?? [],
        dependencies: [],
        ...(request.author === undefined ? {} : { author: request.author }),
      }
      await writeManifest(path, manifest)
      await this.createTemplate(path, request.template)
      await mkdir(resolve(path, CONTROL_DIRECTORY, 'history'), { recursive: true })
      const summary = await this.summarize(path)
      this.projectCache.set(manifest.id, path)
      return summary
    } catch (error) {
      await rm(path, { recursive: true, force: true })
      throw error
    }
  }

  private async createTemplate(path: string, template: ProjectTemplate): Promise<void> {
    const documents: Record<string, string> = {
      'canon/charter.md': '# World Charter\n\nState the non-negotiable truths of this world.\n',
      'canon/timeline.md': '# Canon Timeline\n\nRecord dated events and causal links.\n',
      'maps/world.md': '# World Map\n\nDefine hierarchical places, topology and travel edges.\n',
      'mechanisms/core.md': '# Core Mechanisms\n\nDefine resources, actions, processes and invariants.\n',
    }
    if (template === 'character-story' || template === 'playable-scenario') {
      documents['characters/protagonist.md'] = '# Protagonist\n\nIdentity, values, goals, resources and relationships.\n'
      documents['scenarios/opening.md'] = '# Opening Scenario\n\nInitial state, viewpoint and playable objective.\n'
    }
    if (template === 'social-simulation' || template === 'civilization-sandbox') {
      documents['factions/society.md'] = '# Society\n\nInstitutions, roles, norms and resource flows.\n'
      documents['mechanisms/economy.md'] = '# Economy\n\nProduction, exchange, scarcity and allocation rules.\n'
    }
    const metadata = await this.metadata(path)
    for (const [relativePath, content] of Object.entries(documents)) {
      await durableWrite(resolveInside(path, relativePath), content)
      metadata.ensure(relativePath)
    }
    await metadata.save()
  }

  async copyProject(request: CopyProjectRequest): Promise<ProjectSummary> {
    const source = await this.projectPath(request.projectId)
    const root = await this.rootPath()
    const destination = resolve(root, await this.availableName(root, slugify(request.name)))
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
    try {
      await this.reidentifyProjectCopy(destination, request.name.trim())
      const result = await this.summarize(destination)
      this.projectCache.set(result.manifest.id, destination)
      return result
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
  }

  async trashProject(request: TrashProjectRequest): Promise<TrashedProject> {
    const source = await this.projectPath(request.projectId)
    const root = await this.rootPath()
    const trashId = randomUUID()
    const target = resolve(root, '.worldline-trash', 'projects', trashId)
    const sizeBytes = await directorySize(source)
    const metadata: ProjectTrashMetadata = { originalName: basename(source), deletedAt: now(), sizeBytes }
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    await durableWrite(`${target}.json`, `${JSON.stringify(metadata, null, 2)}\n`)
    this.projectCache.delete(request.projectId)
    return { trashId, ...metadata, manifest: await readManifest(target) }
  }

  async listTrashedProjects(): Promise<readonly TrashedProject[]> {
    const directory = resolve(await this.rootPath(), '.worldline-trash', 'projects')
    if (!(await exists(directory))) return []
    const results: TrashedProject[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metadata = recordOf(JSON.parse(await readTextBounded(resolve(directory, `${entry.name}.json`))))
      const manifest = await readManifest(resolve(directory, entry.name)).catch(() => undefined)
      results.push({
        trashId: entry.name,
        originalName: String(metadata.originalName),
        deletedAt: String(metadata.deletedAt),
        sizeBytes: Number(metadata.sizeBytes),
        ...(manifest === undefined ? {} : { manifest }),
      })
    }
    return results.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
  }

  async restoreProject(request: RestoreProjectRequest): Promise<ProjectSummary> {
    const root = await this.rootPath()
    const source = resolve(root, '.worldline-trash', 'projects', normalizeRelative(request.trashId))
    if (!(await exists(source))) throw new WorldlineProjectError('entry-not-found', 'trashed project not found')
    const raw = recordOf(JSON.parse(await readTextBounded(`${source}.json`)))
    const desired = request.name === undefined ? String(raw.originalName) : slugify(request.name)
    const destination = resolve(root, await this.availableName(root, desired))
    await rename(source, destination)
    await rm(`${source}.json`, { force: true })
    const result = await this.summarize(destination)
    this.projectCache.set(result.manifest.id, destination)
    return result
  }

  async tree(request: ProjectTreeRequest): Promise<ProjectTreeListing> {
    const project = await this.projectPath(request.projectId)
    const path = normalizeRelative(request.path ?? '')
    const directory = resolveInside(project, path)
    await assertNoSymlink(project, directory)
    const metadata = await this.metadata(project)
    const entries: ProjectTreeEntry[] = []
    let truncated = false
    for (const dirent of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (dirent.name === CONTROL_DIRECTORY) continue
      if (entries.length >= this.config.maxEntries) { truncated = true; break }
      if (dirent.isSymbolicLink()) continue
      const relativePath = [path, dirent.name].filter(Boolean).join('/')
      const absolute = resolveInside(project, relativePath)
      const info = await stat(absolute)
      const kind = kindOf(relativePath, dirent.isDirectory())
      const sidecar = dirent.isFile() ? metadata.ensure(relativePath) : undefined
      entries.push({
        id: sidecar?.id ?? allocateWorldlineId<'document'>('entry'),
        name: dirent.name,
        path: relativePath,
        kind,
        sizeBytes: dirent.isDirectory() ? 0 : info.size,
        updatedAt: info.mtime.toISOString(),
        ...(kind === 'document' ? { revision: revisionOf(await readTextBounded(absolute)) } : {}),
        ...(sidecar?.objectKind === undefined ? {} : { objectKind: sidecar.objectKind }),
        tags: sidecar?.tags ?? [],
      })
    }
    await metadata.save()
    return { projectId: request.projectId, path, entries, truncated }
  }

  async read(request: ReadDocumentRequest): Promise<DocumentView> {
    const project = await this.projectPath(request.projectId)
    const path = normalizeRelative(request.path)
    const absolute = resolveInside(project, path)
    await assertNoSymlink(project, absolute, true)
    const content = await readTextBounded(absolute)
    const info = await stat(absolute)
    const metadata = await this.metadata(project)
    const sidecar = metadata.ensure(path)
    await metadata.save()
    return {
      projectId: request.projectId,
      id: sidecar.id,
      path,
      content,
      revision: revisionOf(content),
      updatedAt: info.mtime.toISOString(),
      ...(sidecar.objectKind === undefined ? {} : { objectKind: sidecar.objectKind }),
      tags: sidecar.tags,
    }
  }

  async write(request: WriteDocumentRequest): Promise<DocumentView> {
    const project = await this.projectPath(request.projectId)
    const path = normalizeRelative(request.path)
    if (path === '' || path.startsWith(`${CONTROL_DIRECTORY}/`) || path === PROJECT_MANIFEST) {
      throw new WorldlineProjectError('path-invalid', `reserved project path: ${path}`)
    }
    const absolute = resolveInside(project, path)
    await assertNoSymlink(project, absolute, true)
    const current = await exists(absolute) ? await readTextBounded(absolute) : undefined
    const actualRevision = current === undefined ? undefined : revisionOf(current)
    if (request.expectedRevision !== undefined && request.expectedRevision !== actualRevision) {
      throw new WorldlineProjectError('revision-conflict', 'document changed since it was opened', {
        expected: request.expectedRevision,
        actual: actualRevision ?? 'missing',
      })
    }
    if (current === undefined && request.createParents !== true && !(await exists(dirname(absolute)))) {
      throw new WorldlineProjectError('entry-not-found', 'parent directory does not exist')
    }
    const metadata = await this.metadata(project)
    const sidecar = metadata.ensure(path, {
      ...(request.documentId === undefined ? {} : { id: request.documentId }),
      ...(request.objectKind === undefined ? {} : { objectKind: request.objectKind }),
      ...(request.tags === undefined ? {} : { tags: request.tags }),
    })
    if (current !== undefined && actualRevision !== undefined && current !== request.content) {
      await durableWrite(metadata.historyPath(sidecar.id, actualRevision), current)
      await this.appendHistory(project, sidecar.id, {
        revision: actualRevision,
        savedAt: now(),
        sizeBytes: Buffer.byteLength(current),
        reason: 'autosave',
      })
    }
    await durableWrite(absolute, request.content)
    await metadata.save()
    await this.touchManifest(project)
    return this.read(request)
  }

  async importEntry(
    request: ImportProjectEntryRequest,
    source: AsyncIterable<Uint8Array>,
  ): Promise<MutationResult> {
    const project = await this.projectPath(request.projectId)
    const path = normalizeRelative(request.path)
    if (path === '' || path.startsWith(`${CONTROL_DIRECTORY}/`) || path === PROJECT_MANIFEST) {
      throw new WorldlineProjectError('path-invalid', `reserved project path: ${path}`)
    }
    if (!Number.isSafeInteger(request.expectedBytes) || request.expectedBytes < 0
      || request.expectedBytes > 128 * 1024 ** 3) {
      throw new WorldlineProjectError('entry-too-large', 'streamed import length is outside the 128 GiB safety bound')
    }
    if (kindOf(path, false) === 'document' && request.expectedBytes > 20 * 1024 ** 2) {
      throw new WorldlineProjectError('entry-too-large', 'text document exceeds the 20 MiB editor bound')
    }
    const absolute = resolveInside(project, path)
    await assertNoSymlink(project, absolute, true)
    if (await exists(absolute)) throw new WorldlineProjectError('entry-exists', `entry exists: ${path}`)
    const metadata = await this.metadata(project)
    const sidecar = metadata.ensure(path)
    try {
      await durableWriteStream(absolute, source, request.expectedBytes)
      await metadata.save()
      await this.touchManifest(project)
    } catch (error) {
      metadata.remove(path)
      throw error
    }
    return { projectId: request.projectId, path, id: sidecar.id }
  }

  async createDirectory(request: CreateDirectoryRequest): Promise<MutationResult> {
    const project = await this.projectPath(request.projectId)
    const path = normalizeRelative(request.path)
    const absolute = resolveInside(project, path)
    await assertNoSymlink(project, absolute, true)
    if (await exists(absolute)) throw new WorldlineProjectError('entry-exists', `entry exists: ${path}`)
    await mkdir(absolute, { recursive: false })
    return { projectId: request.projectId, path }
  }

  async move(request: MoveEntryRequest): Promise<MutationResult> {
    const project = await this.projectPath(request.projectId)
    const sourcePath = normalizeRelative(request.source)
    const destinationPath = normalizeRelative(request.destination)
    const source = resolveInside(project, sourcePath)
    const destination = resolveInside(project, destinationPath)
    await assertNoSymlink(project, source)
    await assertNoSymlink(project, destination, true)
    if (!(await exists(source))) throw new WorldlineProjectError('entry-not-found', `entry not found: ${sourcePath}`)
    if (await exists(destination)) throw new WorldlineProjectError('entry-exists', `entry exists: ${destinationPath}`)
    if (request.expectedRevision !== undefined && (await stat(source)).isFile()) {
      const actual = revisionOf(await readTextBounded(source))
      if (actual !== request.expectedRevision) {
        throw new WorldlineProjectError('revision-conflict', 'entry changed before move')
      }
    }
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
    const metadata = await this.metadata(project)
    metadata.move(sourcePath, destinationPath)
    await metadata.save()
    const movedMetadata = metadata.get(destinationPath)
    return { projectId: request.projectId, path: destinationPath,
      ...(movedMetadata === undefined ? {} : { id: movedMetadata.id }) }
  }

  async copyEntry(request: CopyEntryRequest): Promise<MutationResult> {
    const project = await this.projectPath(request.projectId)
    const sourcePath = normalizeRelative(request.source)
    const destinationPath = normalizeRelative(request.destination)
    const source = resolveInside(project, sourcePath)
    const destination = resolveInside(project, destinationPath)
    await assertNoSymlink(project, source)
    await assertNoSymlink(project, destination, true)
    if (!(await exists(source))) throw new WorldlineProjectError('entry-not-found', `entry not found: ${sourcePath}`)
    if (await exists(destination)) throw new WorldlineProjectError('entry-exists', `entry exists: ${destinationPath}`)
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
    const metadata = await this.metadata(project)
    metadata.clone(sourcePath, destinationPath)
    if ((await stat(destination)).isFile() && metadata.get(destinationPath) === undefined) metadata.ensure(destinationPath)
    await metadata.save()
    const copiedMetadata = metadata.get(destinationPath)
    return { projectId: request.projectId, path: destinationPath,
      ...(copiedMetadata === undefined ? {} : { id: copiedMetadata.id }) }
  }

  async trashEntry(request: TrashEntryRequest): Promise<TrashedEntry> {
    const project = await this.projectPath(request.projectId)
    const path = normalizeRelative(request.path)
    const source = resolveInside(project, path)
    await assertNoSymlink(project, source)
    if (!(await exists(source))) throw new WorldlineProjectError('entry-not-found', `entry not found: ${path}`)
    const info = await stat(source)
    if (request.expectedRevision !== undefined && info.isFile()
      && revisionOf(await readTextBounded(source)) !== request.expectedRevision) {
      throw new WorldlineProjectError('revision-conflict', 'entry changed before deletion')
    }
    const trashId = randomUUID()
    const directory = resolve(project, CONTROL_DIRECTORY, 'trash', trashId)
    const payload = resolve(directory, 'payload')
    const metadata: EntryTrashMetadata = {
      originalPath: path,
      deletedAt: now(),
      kind: kindOf(path, info.isDirectory()),
      sizeBytes: info.isDirectory() ? await directorySize(source) : info.size,
    }
    await mkdir(directory, { recursive: true })
    await rename(source, payload)
    await durableWrite(resolve(directory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    return { trashId, ...metadata }
  }

  async listTrashedEntries(projectId: ProjectId): Promise<readonly TrashedEntry[]> {
    const project = await this.projectPath(projectId)
    const root = resolve(project, CONTROL_DIRECTORY, 'trash')
    if (!(await exists(root))) return []
    const results: TrashedEntry[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metadata = recordOf(JSON.parse(await readTextBounded(resolve(root, entry.name, 'metadata.json'))))
      results.push({
        trashId: entry.name,
        originalPath: String(metadata.originalPath),
        deletedAt: String(metadata.deletedAt),
        kind: String(metadata.kind) as TrashedEntry['kind'],
        sizeBytes: Number(metadata.sizeBytes),
      })
    }
    return results.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
  }

  async restoreEntry(request: RestoreEntryRequest): Promise<MutationResult> {
    const project = await this.projectPath(request.projectId)
    const directory = resolve(project, CONTROL_DIRECTORY, 'trash', normalizeRelative(request.trashId))
    if (!(await exists(directory))) throw new WorldlineProjectError('entry-not-found', 'trashed entry not found')
    const raw = recordOf(JSON.parse(await readTextBounded(resolve(directory, 'metadata.json'))))
    const path = normalizeRelative(request.destination ?? String(raw.originalPath))
    const destination = resolveInside(project, path)
    if (await exists(destination)) throw new WorldlineProjectError('entry-exists', `entry exists: ${path}`)
    await assertNoSymlink(project, destination, true)
    await mkdir(dirname(destination), { recursive: true })
    await rename(resolve(directory, 'payload'), destination)
    await rm(directory, { recursive: true, force: true })
    const metadata = await this.metadata(project)
    if ((await stat(destination)).isFile()) metadata.ensure(path)
    await metadata.save()
    const restoredMetadata = metadata.get(path)
    return { projectId: request.projectId, path,
      ...(restoredMetadata === undefined ? {} : { id: restoredMetadata.id }) }
  }

  async history(request: HistoryRequest): Promise<readonly DocumentHistoryEntry[]> {
    const document = await this.read(request)
    const idPath = document.id.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = resolve(
      await this.projectPath(request.projectId),
      CONTROL_DIRECTORY,
      'history',
      idPath,
      'history.json',
    )
    if (!(await exists(path))) return []
    const entries = JSON.parse(await readTextBounded(path)) as DocumentHistoryEntry[]
    return entries.slice(-(request.limit ?? 100)).reverse()
  }

  async restoreRevision(request: RestoreRevisionRequest): Promise<DocumentView> {
    const document = await this.read(request)
    if (document.revision !== request.expectedRevision) {
      throw new WorldlineProjectError('revision-conflict', 'document changed before history restore')
    }
    const metadata = await this.metadata(await this.projectPath(request.projectId))
    const snapshot = metadata.historyPath(document.id, request.revision)
    const content = await readTextBounded(snapshot)
    return this.write({ ...request, content, expectedRevision: request.expectedRevision })
  }

  async search(request: SearchProjectRequest): Promise<readonly ProjectSearchHit[]> {
    const project = await this.projectPath(request.projectId)
    const base = resolveInside(project, request.path ?? '')
    const rootRelative = relative(project, base).split(sep).join('/')
    const metadata = await this.metadata(project)
    const hits: ProjectSearchHit[] = []
    let inspected = 0
    for (const entry of await walk(base)) {
      if (!entry.dirent.isFile() || !TEXT_EXTENSIONS.has(extname(entry.relativePath).toLowerCase())) continue
      inspected += 1
      if (inspected > this.config.maxSearchFiles) break
      const path = [rootRelative, entry.relativePath].filter(Boolean).join('/')
      const sidecar = metadata.ensure(path)
      if (request.tags !== undefined && !request.tags.every(tag => sidecar.tags.includes(tag))) continue
      if (request.kinds !== undefined && (sidecar.objectKind === undefined
        || !request.kinds.includes(sidecar.objectKind))) continue
      const content = await readTextBounded(resolveInside(project, path))
      const query = request.query.trim()
      if (query !== '' && !`${path}\n${content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue
      hits.push({
        id: sidecar.id,
        path,
        title: titleOf(path, content),
        excerpt: excerptAround(content, query),
        score: content.toLocaleLowerCase().split(query.toLocaleLowerCase()).length - 1,
        ...(sidecar.objectKind === undefined ? {} : { objectKind: sidecar.objectKind }),
        tags: sidecar.tags,
      })
      if (hits.length >= Math.min(500, request.limit ?? 100)) break
    }
    await metadata.save()
    return hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  }

  async backlinks(request: ReadDocumentRequest): Promise<readonly ProjectLink[]> {
    const project = await this.projectPath(request.projectId)
    const target = await this.read(request)
    const results: ProjectLink[] = []
    const metadata = await this.metadata(project)
    for (const entry of await walk(project)) {
      if (!entry.dirent.isFile() || !TEXT_EXTENSIONS.has(extname(entry.relativePath).toLowerCase())) continue
      const content = await readTextBounded(resolveInside(project, entry.relativePath))
      const patterns = [target.id, target.path]
      for (const pattern of patterns) {
        if (!content.includes(pattern)) continue
        const source = metadata.ensure(entry.relativePath)
        results.push({
          sourceId: source.id,
          sourcePath: entry.relativePath,
          targetId: target.id,
          target: pattern,
          kind: pattern === target.id ? 'id' : 'path',
          broken: false,
        })
      }
    }
    await metadata.save()
    return results
  }

  async exportProject(request: ExportProjectRequest): Promise<TransferJob> {
    const project = await this.projectPath(request.projectId)
    const destination = resolve(request.destination)
    const job = this.beginJob('export', await directorySize(project))
    void (async () => {
      try {
        const signal = this.jobs.get(job.id)?.controller?.signal
        if (signal === undefined) throw new Error('archive transfer controller is unavailable')
        const result = await exportProjectArchive({
          project,
          projectId: request.projectId,
          destination,
          includesRuns: request.includeRuns === true,
          signal,
          onTotal: (totalBytes) => { this.updateJobTotal(job.id, totalBytes) },
          onProgress: (completedBytes) => { this.updateJobProgress(job.id, completedBytes) },
        })
        this.finishJob(job.id, result.sourceBytes)
      } catch (error) { this.failJob(job.id, error) }
    })()
    return job
  }

  async importProject(request: ImportProjectRequest): Promise<TransferJob> {
    const conflict: unknown = request.conflict
    if (conflict !== 'copy' && conflict !== 'replace' && conflict !== 'cancel') {
      throw new WorldlineProjectError('manifest-conflict', 'project archive conflict policy is required')
    }
    const root = await this.rootPath()
    const source = resolve(request.source)
    const info = await stat(source)
    const job = this.beginJob('import', info.size)
    void (async () => {
      const staging = resolve(root, '.worldline-import', job.id)
      try {
        const signal = this.jobs.get(job.id)?.controller?.signal
        if (signal === undefined) throw new Error('archive transfer controller is unavailable')
        const preflight = await preflightProjectArchive(source, signal)
        this.updateJobTotal(job.id, preflight.manifest.expandedBytes)
        const disk = await statfs(root)
        const availableBytes = disk.bavail * disk.bsize
        if (availableBytes < preflight.manifest.expandedBytes * 1.05) {
          throw new WorldlineProjectError('transfer-failed', 'not enough disk space for the declared ZIP payload')
        }
        const extracted = resolve(staging, 'project')
        await mkdir(extracted, { recursive: true })
        await extractProjectArchive({
          source,
          destination: extracted,
          preflight,
          signal,
          onProgress: (completedBytes) => { this.updateJobProgress(job.id, completedBytes) },
        })
        const manifest = await readManifest(extracted)
        if (manifest.id !== preflight.manifest.projectId) {
          throw new WorldlineProjectError('manifest-conflict', 'archive and project manifest identities do not match')
        }
        const existing = (await this.scan()).find(project => project.manifest.id === manifest.id)
        if (existing !== undefined && conflict === 'cancel') {
          throw new WorldlineProjectError('manifest-conflict', `project already exists: ${manifest.id}`)
        }
        if (existing !== undefined && conflict === 'replace') {
          await this.trashProject({ projectId: manifest.id, reason: 'replaced by archive import' })
        }
        const destinationName = await this.availableName(root, request.name === undefined
          ? preflight.manifest.rootDirectory
          : slugify(request.name))
        const destination = resolve(root, destinationName)
        if (existing !== undefined && conflict === 'copy') {
          await this.reidentifyProjectCopy(extracted, request.name ?? `${manifest.name} Copy`)
        } else if (request.name !== undefined) {
          await writeManifest(extracted, { ...manifest, name: request.name, updatedAt: now() })
        }
        await rename(extracted, destination)
        await rm(staging, { recursive: true, force: true })
        const summary = await this.summarize(destination)
        this.projectCache.set(summary.manifest.id, destination)
        this.finishJob(job.id, preflight.manifest.expandedBytes, summary.manifest.id)
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
        this.failJob(job.id, error)
      }
    })()
    return job
  }

  transfer(id: string): Promise<TransferJob> {
    const job = this.jobs.get(id)
    if (job === undefined) throw new WorldlineProjectError('entry-not-found', `transfer not found: ${id}`)
    const { controller: _controller, ...view } = job
    return Promise.resolve(view)
  }

  async cancelTransfer(id: string): Promise<TransferJob> {
    const job = this.jobs.get(id)
    if (job === undefined) throw new WorldlineProjectError('entry-not-found', `transfer not found: ${id}`)
    job.controller?.abort()
    if (job.state === 'queued' || job.state === 'running') this.jobs.set(id, { ...job, state: 'cancelled' })
    return this.transfer(id)
  }

  async sourceSnapshot(projectId: ProjectId): Promise<ProjectSourceSnapshot> {
    const project = await this.projectPath(projectId)
    const manifest = await readManifest(project)
    const metadata = await this.metadata(project)
    const files: ProjectSourceFile[] = []
    for (const entry of await walk(project)) {
      if (entry.relativePath === PROJECT_MANIFEST) continue
      if (!entry.dirent.isFile() || !TEXT_EXTENSIONS.has(extname(entry.relativePath).toLowerCase())) continue
      const content = await readTextBounded(resolveInside(project, entry.relativePath))
      const sidecar = metadata.ensure(entry.relativePath)
      files.push({
        id: sidecar.id,
        path: entry.relativePath,
        content,
        revision: revisionOf(content),
        ...(sidecar.objectKind === undefined ? {} : { objectKind: sidecar.objectKind }),
        tags: sidecar.tags,
      })
    }
    await metadata.save()
    files.sort((left, right) => left.path.localeCompare(right.path))
    for (const file of files) {
      const current = await readTextBounded(resolveInside(project, file.path))
      if (revisionOf(current) !== file.revision) {
        throw new WorldlineProjectError(
          'revision-conflict',
          `project source changed while capturing a build snapshot: ${file.path}`,
        )
      }
    }
    const currentPaths = (await walk(project))
      .filter(entry => entry.relativePath !== PROJECT_MANIFEST && entry.dirent.isFile()
        && TEXT_EXTENSIONS.has(extname(entry.relativePath).toLowerCase()))
      .map(entry => entry.relativePath)
      .sort((left, right) => left.localeCompare(right))
    if (stableStringify(currentPaths) !== stableStringify(files.map(file => file.path))) {
      throw new WorldlineProjectError('revision-conflict', 'project files changed while capturing a build snapshot')
    }
    const latestManifest = await readManifest(project)
    if (latestManifest.id !== manifest.id || latestManifest.updatedAt !== manifest.updatedAt) {
      throw new WorldlineProjectError('revision-conflict', 'project manifest changed during build snapshot capture')
    }
    return {
      projectId,
      manifest,
      capturedAt: now(),
      digest: revisionOf(stableStringify({
        manifest,
        files: files.map(file => ({ path: file.path, revision: file.revision })),
      })),
      files,
    }
  }

  async readControl(
    projectId: ProjectId,
    namespace: string,
    path: string,
  ): Promise<ProjectControlDocument | undefined> {
    const absolute = await this.controlPath(projectId, namespace, path)
    if (!(await exists(absolute))) return undefined
    const content = await readTextBounded(absolute)
    return { content, revision: revisionOf(content) }
  }

  async writeControl(request: WriteProjectControlRequest): Promise<ProjectControlDocument> {
    const absolute = await this.controlPath(request.projectId, request.namespace, request.path)
    const current = await exists(absolute) ? await readTextBounded(absolute) : undefined
    const revision = current === undefined ? undefined : revisionOf(current)
    if (request.expectedRevision !== undefined && request.expectedRevision !== revision) {
      throw new WorldlineProjectError('revision-conflict', 'control document changed concurrently')
    }
    await durableWrite(absolute, request.content)
    return { content: request.content, revision: revisionOf(request.content) }
  }

  async storeBuild(request: StoreProjectBuildRequest): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(request.digest)) {
      throw new WorldlineProjectError('path-invalid', 'build digest must be lowercase SHA-256')
    }
    const project = await this.projectPath(request.projectId)
    const builds = resolve(project, CONTROL_DIRECTORY, 'builds')
    const destination = resolve(builds, request.digest)
    if (await exists(destination)) {
      await durableWrite(resolve(builds, 'active'), `${request.digest}\n`)
      return
    }
    const staging = resolve(builds, `.staging-${randomUUID()}`)
    try {
      await durableWrite(resolve(staging, 'blueprint.json'), request.blueprint)
      await durableWrite(resolve(staging, 'certificate.json'), request.certificate)
      await durableWrite(resolve(staging, 'source-snapshot.json'), request.sourceSnapshot)
      await rename(staging, destination)
      await durableWrite(resolve(builds, 'active'), `${request.digest}\n`)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async activeBuild(projectId: ProjectId): Promise<ActiveProjectBuild | undefined> {
    const project = await this.projectPath(projectId)
    const builds = resolve(project, CONTROL_DIRECTORY, 'builds')
    const active = resolve(builds, 'active')
    if (!(await exists(active))) return undefined
    const digest = (await readTextBounded(active)).trim()
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw new WorldlineProjectError('project-invalid', 'active Blueprint digest is malformed')
    }
    const blueprintPath = resolve(builds, digest, 'blueprint.json')
    if (!(await exists(blueprintPath))) {
      throw new WorldlineProjectError('project-invalid', 'active Blueprint artifact is missing')
    }
    return { projectId, digest, blueprintPath }
  }

  async runStorage(projectId: ProjectId, runId: RunId): Promise<ProjectRunStorage> {
    const project = await this.projectPath(projectId)
    const directoryName = runId.replace(/[^a-zA-Z0-9._-]/g, '_')
    const directory = resolve(project, CONTROL_DIRECTORY, 'runs', directoryName)
    await mkdir(directory, { recursive: true })
    const metadataPath = resolve(directory, 'run.json')
    if (!(await exists(metadataPath))) {
      await durableWrite(metadataPath, `${JSON.stringify({ projectId, runId }, null, 2)}\n`)
    } else {
      const stored = recordOf(JSON.parse(await readTextBounded(metadataPath)))
      if (stored.projectId !== projectId || stored.runId !== runId) {
        throw new WorldlineProjectError('manifest-conflict', 'Run storage identity collision')
      }
    }
    return { projectId, runId, databasePath: resolve(directory, 'world.sqlite') }
  }

  async runStorages(): Promise<readonly ProjectRunStorage[]> {
    const projects = await this.scan()
    const storages: ProjectRunStorage[] = []
    for (const project of projects) {
      const root = resolve(project.path, CONTROL_DIRECTORY, 'runs')
      if (!(await exists(root))) continue
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const metadataPath = resolve(root, entry.name, 'run.json')
        if (!(await exists(metadataPath))) continue
        try {
          const stored = recordOf(JSON.parse(await readTextBounded(metadataPath)))
          if (stored.projectId !== project.manifest.id || typeof stored.runId !== 'string') continue
          storages.push({
            projectId: project.manifest.id,
            runId: stored.runId as RunId,
            databasePath: resolve(root, entry.name, 'world.sqlite'),
          })
        } catch (error) {
          this.context.logger('worldline-project').warn(
            'ignored damaged Run metadata %s: %s',
            metadataPath,
            messageOf(error),
          )
        }
      }
    }
    return storages
  }

  private beginJob(kind: TransferJob['kind'], totalBytes?: number): TransferJob {
    const job: TransferJob & { controller: AbortController } = {
      id: randomUUID(), kind, state: 'running', completedBytes: 0,
      ...(totalBytes === undefined ? {} : { totalBytes }),
      controller: new AbortController(),
    }
    this.jobs.set(job.id, job)
    const { controller: _controller, ...view } = job
    return view
  }

  private async controlPath(projectId: ProjectId, namespace: string, path: string): Promise<string> {
    if (!/^[a-z][a-z0-9-]*$/u.test(namespace)) {
      throw new WorldlineProjectError('path-invalid', `invalid control namespace: ${namespace}`)
    }
    const project = await this.projectPath(projectId)
    const base = resolve(project, CONTROL_DIRECTORY, namespace)
    const absolute = resolveInside(base, path)
    await assertNoSymlink(base, absolute, true)
    return absolute
  }

  private finishJob(id: string, completedBytes?: number, projectId?: ProjectId): TransferJob {
    const current = this.jobs.get(id)
    if (current === undefined) throw new Error(`transfer disappeared: ${id}`)
    const finalBytes = completedBytes ?? current.totalBytes ?? current.completedBytes
    const job = { ...current, state: 'completed' as const,
      completedBytes: finalBytes,
      totalBytes: finalBytes,
      ...(projectId === undefined ? {} : { resultProjectId: projectId }) }
    this.jobs.set(id, job)
    const { controller: _controller, ...view } = job
    return view
  }

  private failJob(id: string, error: unknown): TransferJob {
    const current = this.jobs.get(id)
    if (current === undefined) throw new Error(`transfer disappeared: ${id}`)
    if (current.state === 'cancelled') {
      const { controller: _controller, ...view } = current
      return view
    }
    const job = { ...current, state: 'failed' as const, error: messageOf(error) }
    this.jobs.set(id, job)
    const { controller: _controller, ...view } = job
    return view
  }

  private updateJobProgress(id: string, completedBytes: number): void {
    const current = this.jobs.get(id)
    if (current === undefined || current.state !== 'running') return
    this.jobs.set(id, { ...current, completedBytes })
  }

  private updateJobTotal(id: string, totalBytes: number): void {
    const current = this.jobs.get(id)
    if (current === undefined || current.state !== 'running') return
    this.jobs.set(id, { ...current, totalBytes })
  }

  private async reidentifyProjectCopy(project: string, name: string): Promise<void> {
    const previous = await readManifest(project)
    const timestamp = now()
    await writeManifest(project, {
      ...previous,
      id: allocateWorldlineId<'project'>('project'),
      defaultWorldId: allocateWorldlineId<'world'>('world'),
      defaultWorldlineId: allocateWorldlineId<'worldline'>('worldline'),
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await rm(resolve(project, CONTROL_DIRECTORY, 'history'), { recursive: true, force: true })
    await rm(resolve(project, CONTROL_DIRECTORY, 'builds'), { recursive: true, force: true })
    await rm(resolve(project, CONTROL_DIRECTORY, 'runs'), { recursive: true, force: true })
    await rm(resolve(project, CONTROL_DIRECTORY, 'index.json'), { force: true })
    const metadata = await this.metadata(project)
    for (const entry of await walk(project)) {
      if (entry.dirent.isFile() && TEXT_EXTENSIONS.has(extname(entry.relativePath).toLowerCase())) {
        metadata.ensure(entry.relativePath, { id: allocateWorldlineId<'document'>('doc') })
      }
    }
    await metadata.save()
  }

  private async availableName(root: string, requested: string): Promise<string> {
    const base = slugify(requested)
    for (let index = 0; index < 10_000; index += 1) {
      const value = index === 0 ? base : `${base}-${String(index + 1)}`
      if (!(await exists(resolve(root, value)))) return value
    }
    throw new WorldlineProjectError('entry-exists', `cannot allocate a unique project folder for ${base}`)
  }

  private async touchManifest(project: string): Promise<void> {
    const manifest = await readManifest(project)
    await writeManifest(project, { ...manifest, updatedAt: now() })
  }

  private async appendHistory(
    project: string,
    id: DocumentId,
    entry: DocumentHistoryEntry,
  ): Promise<void> {
    const idPath = id.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = resolve(project, CONTROL_DIRECTORY, 'history', idPath, 'history.json')
    const entries = await exists(path)
      ? JSON.parse(await readTextBounded(path)) as DocumentHistoryEntry[]
      : []
    entries.push(entry)
    await durableWrite(path, `${JSON.stringify(entries.slice(-500), null, 2)}\n`)
  }
}

export { LocalWorldlineProjects }
