import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ZipFile as ZipWriter } from 'yazl'
import { openPromise as openZip, type Entry, type ZipFile as ZipReader } from 'yauzl'
import type { MechanismDependency, ProjectId } from '@deepseek-ai/dsh-worldline-standard'
import { WWS_VERSION, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineProjectError } from '@deepseek-ai/dsh-worldline-project'
import {
  durableWriteStream,
  exists,
  isInside,
  normalizeRelative,
  resolveInside,
  walk,
} from './storage.ts'

const ARCHIVE_MANIFEST = 'worldline-archive.json'
const MAX_ARCHIVE_FILES = 100_000
const MAX_EXPANDED_BYTES = 128 * 1024 ** 3
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const MAX_SUSPICIOUS_RATIO = 1_000
const RATIO_CHECK_BYTES = 100 * 1024 ** 2
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

interface ProjectArchiveManifest {
  readonly format: typeof WWS_VERSION
  readonly kind: 'project'
  readonly projectId: ProjectId
  readonly rootDirectory: string
  readonly createdAt: string
  readonly fileCount: number
  readonly expandedBytes: number
  readonly includesRuns: boolean
  readonly dependencies: readonly MechanismDependency[]
  readonly files: readonly ArchiveFileDigest[]
}

interface ArchiveFileDigest {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface ProjectArchivePreflight {
  readonly manifest: ProjectArchiveManifest
  readonly entries: readonly ArchiveEntryFingerprint[]
  readonly archiveBytes: number
  readonly archiveModifiedAtMs: number
}

interface ArchiveEntryFingerprint {
  readonly path: string
  readonly compressedBytes: number
  readonly expandedBytes: number
  readonly crc32: number
  readonly attributes: number
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function abortError(): Error {
  return new DOMException('Worldline archive transfer was cancelled', 'AbortError')
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

async function* abortable(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    assertNotAborted(signal)
    yield chunk
  }
}

function archivePath(path: string): string {
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[a-z]:/iu.test(path)) {
    throw new WorldlineProjectError('transfer-failed', `unsafe ZIP entry path: ${path}`)
  }
  const directory = path.endsWith('/')
  const trimmed = directory ? path.slice(0, -1) : path
  if (trimmed === '') throw new WorldlineProjectError('transfer-failed', 'ZIP contains an empty entry path')
  const segments = trimmed.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'
    || segment.includes(':') || /[. ]$/u.test(segment) || /[\u0000-\u001f]/u.test(segment)
    || segment.normalize('NFC') !== segment || WINDOWS_RESERVED.test(segment))) {
    throw new WorldlineProjectError('transfer-failed', `unsafe ZIP entry path: ${path}`)
  }
  normalizeRelative(trimmed)
  return directory ? `${trimmed}/` : trimmed
}

function fingerprint(entry: Entry): ArchiveEntryFingerprint {
  return {
    path: entry.fileName,
    compressedBytes: entry.compressedSize,
    expandedBytes: entry.uncompressedSize,
    crc32: entry.crc32 >>> 0,
    attributes: entry.externalFileAttributes >>> 0,
  }
}

function sameFingerprint(left: ArchiveEntryFingerprint, right: ArchiveEntryFingerprint): boolean {
  return left.path === right.path
    && left.compressedBytes === right.compressedBytes
    && left.expandedBytes === right.expandedBytes
    && left.crc32 === right.crc32
    && left.attributes === right.attributes
}

function isSymbolicLink(entry: Entry): boolean {
  const unixMode = entry.externalFileAttributes >>> 16
  return (unixMode & 0o170000) === 0o120000
}

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
    if (ids.has(id)) throw new WorldlineProjectError('transfer-failed', `archive repeats dependency: ${id}`)
    ids.add(id)
    return {
      id,
      version: dependency['version'],
      required: dependency['required'],
    }
  })
}

function parseFileDigests(value: unknown): readonly ArchiveFileDigest[] {
  if (!Array.isArray(value)) {
    throw new WorldlineProjectError('transfer-failed', 'archive manifest files must be an array')
  }
  const names = new Set<string>()
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new WorldlineProjectError('transfer-failed', 'archive file digest must be an object')
    }
    const file = item as Record<string, unknown>
    if (typeof file['path'] !== 'string' || file['path'].endsWith('/')
      || !Number.isSafeInteger(file['bytes']) || Number(file['bytes']) < 0
      || typeof file['sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(file['sha256'])) {
      throw new WorldlineProjectError('transfer-failed', 'archive file digest is malformed')
    }
    const path = archivePath(file['path'])
    const canonical = path.toLocaleLowerCase('en-US')
    if (names.has(canonical)) {
      throw new WorldlineProjectError('transfer-failed', `archive manifest repeats a file: ${path}`)
    }
    names.add(canonical)
    return { path, bytes: Number(file['bytes']), sha256: file['sha256'] }
  })
}

function parseManifest(value: unknown): ProjectArchiveManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorldlineProjectError('transfer-failed', 'archive manifest must be an object')
  }
  const source = value as Record<string, unknown>
  if (source['format'] !== WWS_VERSION || source['kind'] !== 'project'
    || typeof source['projectId'] !== 'string' || typeof source['rootDirectory'] !== 'string'
    || typeof source['createdAt'] !== 'string' || !Number.isFinite(Date.parse(source['createdAt']))
    || !Number.isSafeInteger(source['fileCount']) || Number(source['fileCount']) < 1
    || !Number.isSafeInteger(source['expandedBytes']) || Number(source['expandedBytes']) < 1
    || typeof source['includesRuns'] !== 'boolean') {
    throw new WorldlineProjectError('transfer-failed', 'archive manifest does not match the current project archive contract')
  }
  const dependencies = parseDependencies(source['dependencies'])
  const files = parseFileDigests(source['files'])
  if (files.length !== Number(source['fileCount'])
    || files.reduce((sum, file) => sum + file.bytes, 0) !== Number(source['expandedBytes'])) {
    throw new WorldlineProjectError('transfer-failed', 'archive file digests do not match declared totals')
  }
  return {
    format: WWS_VERSION,
    kind: 'project',
    projectId: worldlineId<'project'>(source['projectId']),
    rootDirectory: archivePath(source['rootDirectory']).replace(/\/$/u, ''),
    createdAt: source['createdAt'],
    fileCount: Number(source['fileCount']),
    expandedBytes: Number(source['expandedBytes']),
    includesRuns: source['includesRuns'],
    dependencies,
    files,
  }
}

async function sha256File(path: string, signal: AbortSignal): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of abortable(createReadStream(path), signal)) digest.update(chunk)
  return digest.digest('hex')
}

async function readEntryBounded(zip: ZipReader, entry: Entry, maxBytes: number): Promise<string> {
  if (entry.uncompressedSize > maxBytes) {
    throw new WorldlineProjectError('transfer-failed', `${entry.fileName} exceeds its metadata limit`)
  }
  const stream = await zip.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += value.length
    if (bytes > maxBytes) throw new WorldlineProjectError('transfer-failed', `${entry.fileName} exceeds its metadata limit`)
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function preflightProjectArchive(
  source: string,
  signal?: AbortSignal,
): Promise<ProjectArchivePreflight> {
  const absolute = resolve(source)
  if (signal !== undefined) assertNotAborted(signal)
  const archiveInfo = await stat(absolute)
  if (!archiveInfo.isFile()) throw new WorldlineProjectError('transfer-failed', 'archive source is not a file')
  const zip = await openZip(absolute, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  })
  try {
    const files: Entry[] = []
    const names = new Set<string>()
    let manifest: ProjectArchiveManifest | undefined
    let expandedBytes = 0
    let payloadFiles = 0
    for await (const entry of zip.eachEntry()) {
      if (signal !== undefined) assertNotAborted(signal)
      entry.fileName = archivePath(entry.fileName)
      const canonicalName = entry.fileName.toLocaleLowerCase('en-US')
      if (names.has(canonicalName)) {
        throw new WorldlineProjectError('transfer-failed', `ZIP contains a duplicate entry: ${entry.fileName}`)
      }
      names.add(canonicalName)
      if (entry.isEncrypted() || !entry.canDecodeFileData()) {
        throw new WorldlineProjectError('transfer-failed', `ZIP entry cannot be decoded: ${entry.fileName}`)
      }
      if (isSymbolicLink(entry)) {
        throw new WorldlineProjectError('transfer-failed', `ZIP links are forbidden: ${entry.fileName}`)
      }
      if (files.length >= MAX_ARCHIVE_FILES) {
        throw new WorldlineProjectError('transfer-failed', `ZIP exceeds ${String(MAX_ARCHIVE_FILES)} entries`)
      }
      if (entry.uncompressedSize > RATIO_CHECK_BYTES
        && entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_SUSPICIOUS_RATIO) {
        throw new WorldlineProjectError('transfer-failed', `suspicious ZIP expansion ratio: ${entry.fileName}`)
      }
      expandedBytes += entry.uncompressedSize
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new WorldlineProjectError('transfer-failed', 'ZIP expanded size exceeds the Worldline archive limit')
      }
      if (entry.fileName === ARCHIVE_MANIFEST) {
        if (manifest !== undefined || entry.fileName.endsWith('/')) {
          throw new WorldlineProjectError('transfer-failed', 'ZIP must contain one archive manifest file')
        }
        manifest = parseManifest(JSON.parse(await readEntryBounded(zip, entry, MAX_MANIFEST_BYTES)))
      } else if (!entry.fileName.endsWith('/')) {
        payloadFiles += 1
      }
      files.push(entry)
    }
    if (manifest === undefined) throw new WorldlineProjectError('transfer-failed', 'ZIP has no Worldline archive manifest')
    if (manifest.rootDirectory.includes('/')) {
      throw new WorldlineProjectError('transfer-failed', 'project archive root must be one portable directory name')
    }
    const payloadPrefix = `payload/${manifest.rootDirectory}/`
    if (!files.some(entry => entry.fileName === `${payloadPrefix}worldline.toml`)) {
      throw new WorldlineProjectError('transfer-failed', 'project archive has no payload worldline.toml')
    }
    if (files.some(entry => entry.fileName !== ARCHIVE_MANIFEST && !entry.fileName.startsWith(payloadPrefix))) {
      throw new WorldlineProjectError('transfer-failed', 'project archive contains data outside its declared payload root')
    }
    const payloadBytes = files.filter(entry => entry.fileName !== ARCHIVE_MANIFEST && !entry.fileName.endsWith('/'))
      .reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    if (payloadFiles !== manifest.fileCount || payloadBytes !== manifest.expandedBytes) {
      throw new WorldlineProjectError('transfer-failed', 'project archive size declaration does not match its ZIP directory')
    }
    const digestFiles = new Map(manifest.files.map(file => [
      `${payloadPrefix}${file.path}`.toLocaleLowerCase('en-US'), file,
    ]))
    for (const entry of files) {
      if (entry.fileName === ARCHIVE_MANIFEST || entry.fileName.endsWith('/')) continue
      const declared = digestFiles.get(entry.fileName.toLocaleLowerCase('en-US'))
      if (declared === undefined || declared.bytes !== entry.uncompressedSize) {
        throw new WorldlineProjectError('transfer-failed', `ZIP entry is not covered by its manifest: ${entry.fileName}`)
      }
      digestFiles.delete(entry.fileName.toLocaleLowerCase('en-US'))
    }
    if (digestFiles.size !== 0) {
      throw new WorldlineProjectError('transfer-failed', 'archive manifest declares files missing from the ZIP')
    }
    return {
      manifest,
      entries: files.map(entry => fingerprint(entry)),
      archiveBytes: archiveInfo.size,
      archiveModifiedAtMs: archiveInfo.mtimeMs,
    }
  } finally {
    zip.close()
  }
}

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
  const destination = resolve(options.destination)
  if (isInside(options.project, destination)) {
    throw new WorldlineProjectError('path-invalid', 'archive destination cannot be inside the exported project')
  }
  if (await exists(destination)) throw new WorldlineProjectError('entry-exists', `archive already exists: ${destination}`)
  const projectRoot = archivePath(basename(options.project))
  const sourceEntries: Array<{
    readonly absolute: string
    readonly archive: string
    readonly size: number
    readonly mtime: Date
    readonly mode: number
    readonly relative: string
    readonly sha256: string
  }> = []
  let sourceBytes = 0
  for (const item of await walk(options.project, true)) {
    if (!item.dirent.isFile()) continue
    if (item.relativePath === '.worldline/cache' || item.relativePath.startsWith('.worldline/cache/')) continue
    if (!options.includesRuns
      && (item.relativePath === '.worldline/runs' || item.relativePath.startsWith('.worldline/runs/'))) continue
    if (sourceEntries.length >= MAX_ARCHIVE_FILES) {
      throw new WorldlineProjectError('transfer-failed', `project exceeds ${String(MAX_ARCHIVE_FILES)} archive files`)
    }
    const absolute = resolveInside(options.project, item.relativePath)
    const info = await stat(absolute)
    sourceBytes += info.size
    if (sourceBytes > MAX_EXPANDED_BYTES) {
      throw new WorldlineProjectError('transfer-failed', 'project exceeds the Worldline archive size limit')
    }
    sourceEntries.push({
      absolute,
      archive: archivePath(`payload/${projectRoot}/${item.relativePath}`),
      size: info.size,
      mtime: info.mtime,
      mode: info.mode,
      relative: archivePath(item.relativePath),
      sha256: await sha256File(absolute, options.signal),
    })
  }
  if (sourceEntries.length === 0 || sourceBytes < 1) {
    throw new WorldlineProjectError('transfer-failed', 'project has no files to archive')
  }
  options.onTotal(sourceBytes)
  const manifest: ProjectArchiveManifest = {
    format: WWS_VERSION,
    kind: 'project',
    projectId: options.projectId,
    rootDirectory: projectRoot,
    createdAt: new Date().toISOString(),
    fileCount: sourceEntries.length,
    expandedBytes: sourceBytes,
    includesRuns: options.includesRuns,
    dependencies: options.dependencies,
    files: sourceEntries.map(entry => ({ path: entry.relative, bytes: entry.size, sha256: entry.sha256 })),
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = resolve(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  const zip = new ZipWriter()
  let completedBytes = 0
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), ARCHIVE_MANIFEST)
  for (const entry of sourceEntries) {
    zip.addReadStreamLazy(entry.archive, {
      size: entry.size,
      mtime: entry.mtime,
      mode: entry.mode,
      compress: true,
    }, (callback) => {
      assertNotAborted(options.signal)
      const digest = createHash('sha256')
      async function* checkedSource(): AsyncIterable<Uint8Array> {
        for await (const chunk of abortable(createReadStream(entry.absolute), options.signal)) {
          digest.update(chunk)
          completedBytes += chunk.byteLength
          options.onProgress(completedBytes)
          yield chunk
        }
        if (digest.digest('hex') !== entry.sha256) {
          throw new WorldlineProjectError(
            'revision-conflict',
            `project file changed while exporting: ${entry.relative}`,
          )
        }
      }
      callback(null, Readable.from(checkedSource()))
    })
  }
  try {
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
    const writing = pipeline(zip.outputStream, output, { signal: options.signal })
    zip.end()
    await writing
    const file = await open(temporary, 'r+')
    try { await file.sync() } finally { await file.close() }
    await rename(temporary, destination)
    try {
      const parent = await open(dirname(destination), 'r')
      try { await parent.sync() } finally { await parent.close() }
    } catch {
      // Windows and some network filesystems do not expose directory fsync.
    }
    return { archiveBytes: (await stat(destination)).size, sourceBytes }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function extractProjectArchive(options: {
  readonly source: string
  readonly destination: string
  readonly preflight: ProjectArchivePreflight
  readonly signal: AbortSignal
  readonly onProgress: (completedBytes: number) => void
}): Promise<void> {
  const archiveInfo = await stat(resolve(options.source))
  if (archiveInfo.size !== options.preflight.archiveBytes
    || archiveInfo.mtimeMs !== options.preflight.archiveModifiedAtMs) {
    throw new WorldlineProjectError('transfer-failed', 'project archive changed after preflight')
  }
  const zip = await openZip(resolve(options.source), {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  })
  const prefix = `payload/${options.preflight.manifest.rootDirectory}/`
  const digests = new Map(options.preflight.manifest.files.map(file => [file.path, file]))
  let completedBytes = 0
  let entryIndex = 0
  try {
    for await (const entry of zip.eachEntry()) {
      assertNotAborted(options.signal)
      entry.fileName = archivePath(entry.fileName)
      const expected = options.preflight.entries[entryIndex]
      entryIndex += 1
      if (expected === undefined || !sameFingerprint(fingerprint(entry), expected)) {
        throw new WorldlineProjectError('transfer-failed', 'project archive directory changed after preflight')
      }
      if (entry.isEncrypted() || !entry.canDecodeFileData() || isSymbolicLink(entry)) {
        throw new WorldlineProjectError('transfer-failed', `ZIP entry became unsafe: ${entry.fileName}`)
      }
      const path = entry.fileName
      if (path === ARCHIVE_MANIFEST) continue
      if (!path.startsWith(prefix)) throw new WorldlineProjectError('transfer-failed', `entry escapes the payload root: ${path}`)
      const relative = path.slice(prefix.length).replace(/\/$/u, '')
      if (relative === '') continue
      const destination = resolveInside(options.destination, relative)
      if (path.endsWith('/')) {
        await mkdir(destination, { recursive: true })
        continue
      }
      const stream = await zip.openReadStreamPromise(entry)
      let crc = 0xffffffff
      const sha256 = createHash('sha256')
      async function* checked(): AsyncIterable<Uint8Array> {
        for await (const chunk of abortable(stream, options.signal)) {
          for (const byte of chunk) {
            crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
          }
          sha256.update(chunk)
          yield chunk
        }
      }
      await durableWriteStream(destination, checked(), entry.uncompressedSize)
      if ((crc ^ 0xffffffff) >>> 0 !== (entry.crc32 >>> 0)) {
        throw new WorldlineProjectError('transfer-failed', `ZIP entry checksum failed: ${entry.fileName}`)
      }
      const declared = digests.get(relative)
      if (declared === undefined || sha256.digest('hex') !== declared.sha256) {
        throw new WorldlineProjectError('transfer-failed', `ZIP entry digest failed: ${entry.fileName}`)
      }
      completedBytes += entry.uncompressedSize
      options.onProgress(completedBytes)
    }
    if (entryIndex !== options.preflight.entries.length) {
      throw new WorldlineProjectError('transfer-failed', 'project archive entry count changed after preflight')
    }
  } finally {
    zip.close()
  }
}
