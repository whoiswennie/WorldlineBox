import { basename } from 'node:path'
import type { MechanismDependency, ProjectId } from '@deepseek-ai/dsh-worldline-standard'
import { WWS_VERSION, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineProjectError } from '@deepseek-ai/dsh-worldline-project'
import {
  type ArchiveFileDigest,
  type ArchiveManifestBase,
  type ArchivePreflight,
  type ArchiveSourceFile,
  extractArchive,
  parseArchiveEnvelope,
  portableArchivePath,
  preflightArchive,
  writeArchive,
} from './archive-core.ts'
import { isInside, resolveInside, walk } from './storage.ts'

interface ProjectArchiveManifest extends ArchiveManifestBase {
  readonly kind: 'project'
  readonly projectId: ProjectId
  readonly rootDirectory: string
  readonly includesRuns: boolean
  readonly dependencies: readonly MechanismDependency[]
}

/** Describes the project archive preflight value exchanged across the package boundary.
 */
export type ProjectArchivePreflight = ArchivePreflight<ProjectArchiveManifest>

function parseDependencies(value: unknown): readonly MechanismDependency[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new WorldlineProjectError('transfer-failed', 'archive manifest dependencies must be an array')
  }
  const ids = new Set<string>()
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new WorldlineProjectError('transfer-failed', 'archive dependency must be an object')
    }
    const dependency = item as Record<string, unknown>
    if (typeof dependency['id'] !== 'string' || dependency['id'].trim() === ''
      || typeof dependency['version'] !== 'string' || dependency['version'].trim() === ''
      || typeof dependency['required'] !== 'boolean') {
      throw new WorldlineProjectError('transfer-failed', 'archive dependency is malformed')
    }
    const id = dependency['id'].trim()
    if (ids.has(id)) {
      throw new WorldlineProjectError('transfer-failed', `archive repeats dependency: ${id}`)
    }
    ids.add(id)
    return { id, version: dependency['version'], required: dependency['required'] }
  })
}

function parseProjectManifest(value: unknown): ProjectArchiveManifest {
  const { source, base } = parseArchiveEnvelope(value, 'project')
  if (typeof source['projectId'] !== 'string' || typeof source['rootDirectory'] !== 'string'
    || typeof source['includesRuns'] !== 'boolean') {
    throw new WorldlineProjectError(
      'transfer-failed',
      'archive manifest does not match the current project archive contract',
    )
  }
  const rootDirectory = portableArchivePath(source['rootDirectory']).replace(/\/$/u, '')
  if (rootDirectory.includes('/')) {
    throw new WorldlineProjectError('transfer-failed', 'project archive root must be one portable directory name')
  }
  return {
    ...base,
    kind: 'project',
    projectId: worldlineId<'project'>(source['projectId']),
    rootDirectory,
    includesRuns: source['includesRuns'],
    dependencies: parseDependencies(source['dependencies']),
  }
}

function payloadPrefix(manifest: ProjectArchiveManifest): string {
  return `payload/${manifest.rootDirectory}/`
}

function validateProjectLayout(
  _manifest: ProjectArchiveManifest,
  paths: ReadonlySet<string>,
): void {
  if (!paths.has('worldline.toml')) {
    throw new WorldlineProjectError('transfer-failed', 'project archive has no payload worldline.toml')
  }
}

/** Perform preflight project archive through the package's public contract.
 * @param source - The source supplied by the caller.
 * @param signal - The signal supplied by the caller.
 * @returns The result produced by the operation.
 */
export function preflightProjectArchive(
  source: string,
  signal?: AbortSignal,
): Promise<ProjectArchivePreflight> {
  return preflightArchive({
    source,
    ...(signal === undefined ? {} : { signal }),
    parseManifest: parseProjectManifest,
    payloadPrefix,
    validateLayout: validateProjectLayout,
  })
}

/** Export a project as a deterministic, validated archive.
 * @param options - The options supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function exportProjectArchive(options: {
  readonly project: string
  readonly projectId: ProjectId
  readonly destination: string
  readonly includesRuns: boolean
  readonly dependencies: readonly MechanismDependency[]
  readonly signal: AbortSignal
  readonly onTotal: (totalBytes: number) => void
  readonly onProgress: (completedBytes: number) => void
}): Promise<{ readonly archiveBytes: number; readonly sourceBytes: number }> {
  if (isInside(options.project, options.destination)) {
    throw new WorldlineProjectError('path-invalid', 'archive destination cannot be inside the exported project')
  }
  const projectRoot = portableArchivePath(basename(options.project))
  const sources: ArchiveSourceFile[] = []
  for (const item of await walk(options.project, true)) {
    if (!item.dirent.isFile()) continue
    if (item.relativePath === '.worldline/cache' || item.relativePath.startsWith('.worldline/cache/')) continue
    if (!options.includesRuns
      && (item.relativePath === '.worldline/runs' || item.relativePath.startsWith('.worldline/runs/'))) continue
    sources.push({
      absolute: resolveInside(options.project, item.relativePath),
      path: portableArchivePath(item.relativePath),
    })
  }
  return writeArchive({
    destination: options.destination,
    payloadPrefix: `payload/${projectRoot}/`,
    sources,
    signal: options.signal,
    createManifest: (files: readonly ArchiveFileDigest[], expandedBytes: number) => ({
      format: WWS_VERSION,
      kind: 'project',
      projectId: options.projectId,
      rootDirectory: projectRoot,
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      expandedBytes,
      includesRuns: options.includesRuns,
      dependencies: options.dependencies,
      files,
    }),
    onTotal: options.onTotal,
    onProgress: options.onProgress,
  })
}

/** Perform extract project archive through the package's public contract.
 * @param options - The options supplied by the caller.
 * @returns The result produced by the operation.
 */
export function extractProjectArchive(options: {
  readonly source: string
  readonly destination: string
  readonly preflight: ProjectArchivePreflight
  readonly signal: AbortSignal
  readonly onProgress: (completedBytes: number) => void
}): Promise<void> {
  return extractArchive(options)
}
