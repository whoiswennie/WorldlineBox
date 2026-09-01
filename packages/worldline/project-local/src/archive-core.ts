import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ZipFile as ZipWriter } from 'yazl'
import { openPromise as openZip, type Entry, type ZipFile as ZipReader } from 'yauzl'
import { WWS_VERSION } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineProjectError } from '@deepseek-ai/dsh-worldline-project'
import { durableWriteStream, exists, normalizeRelative, resolveInside } from './storage.ts'

const ARCHIVE_MANIFEST = 'worldline-archive.json'
const MAX_ARCHIVE_FILES = 100_000
const MAX_EXPANDED_BYTES = 128 * 1024 ** 3
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const MAX_SUSPICIOUS_RATIO = 1_000
const RATIO_CHECK_BYTES = 100 * 1024 ** 2
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

export type WorldlineArchiveKind = 'project' | 'blueprint' | 'run'

export interface ArchiveFileDigest {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface ArchiveManifestBase {
  readonly format: typeof WWS_VERSION
  readonly kind: WorldlineArchiveKind
  readonly createdAt: string
  readonly fileCount: number
  readonly expandedBytes: number
  readonly files: readonly ArchiveFileDigest[]
}

export interface ArchiveSourceFile {
  readonly absolute: string
  readonly path: string
}

interface PreparedArchiveSource extends ArchiveSourceFile {
  readonly bytes: number
  readonly modifiedAt: Date
  readonly mode: number
  readonly sha256: string
}

interface ArchiveEntryFingerprint {
  readonly path: string
  readonly compressedBytes: number
  readonly expandedBytes: number
  readonly crc32: number
  readonly attributes: number
}

export interface ArchivePreflight<M extends ArchiveManifestBase> {
  readonly manifest: M
  readonly payloadPrefix: string
  readonly entries: readonly ArchiveEntryFingerprint[]
  readonly archiveBytes: number
  readonly archiveModifiedAtMs: number
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function abortError(): Error {
  return new DOMException('Worldline archive transfer was cancelled', 'AbortError')
}

export function assertArchiveNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

async function* abortable(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    assertArchiveNotAborted(signal)
    yield chunk
  }
}

export function portableArchivePath(path: string): string {
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

export function parseArchiveFiles(value: unknown): readonly ArchiveFileDigest[] {
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
    const path = portableArchivePath(file['path'])
    const canonical = path.toLocaleLowerCase('en-US')
    if (names.has(canonical)) {
      throw new WorldlineProjectError('transfer-failed', `archive manifest repeats a file: ${path}`)
    }
    names.add(canonical)
    return { path, bytes: Number(file['bytes']), sha256: file['sha256'] }
  })
}

export function parseArchiveEnvelope(
  value: unknown,
  expectedKind: WorldlineArchiveKind,
): { readonly source: Readonly<Record<string, unknown>>; readonly base: ArchiveManifestBase } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorldlineProjectError('transfer-failed', 'archive manifest must be an object')
  }
  const source = value as Record<string, unknown>
  if (source['format'] !== WWS_VERSION || source['kind'] !== expectedKind
    || typeof source['createdAt'] !== 'string' || !Number.isFinite(Date.parse(source['createdAt']))
    || !Number.isSafeInteger(source['fileCount']) || Number(source['fileCount']) < 1
    || !Number.isSafeInteger(source['expandedBytes']) || Number(source['expandedBytes']) < 1) {
    throw new WorldlineProjectError(
      'transfer-failed',
      `archive manifest does not match the current ${expectedKind} archive contract`,
    )
  }
  const files = parseArchiveFiles(source['files'])
  if (files.length !== Number(source['fileCount'])
    || files.reduce((sum, file) => sum + file.bytes, 0) !== Number(source['expandedBytes'])) {
    throw new WorldlineProjectError('transfer-failed', 'archive file digests do not match declared totals')
  }
  return {
    source,
    base: {
      format: WWS_VERSION,
      kind: expectedKind,
      createdAt: source['createdAt'],
      fileCount: Number(source['fileCount']),
      expandedBytes: Number(source['expandedBytes']),
      files,
    },
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
    if (bytes > maxBytes) {
      throw new WorldlineProjectError('transfer-failed', `${entry.fileName} exceeds its metadata limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function preflightArchive<M extends ArchiveManifestBase>(options: {
  readonly source: string
  readonly signal?: AbortSignal
  readonly parseManifest: (value: unknown) => M
  readonly payloadPrefix: (manifest: M) => string
  readonly validateLayout: (manifest: M, paths: ReadonlySet<string>) => void
}): Promise<ArchivePreflight<M>> {
  const absolute = resolve(options.source)
  if (options.signal !== undefined) assertArchiveNotAborted(options.signal)
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
    const entries: Entry[] = []
    const names = new Set<string>()
    let manifest: M | undefined
    let expandedBytes = 0
    for await (const entry of zip.eachEntry()) {
      if (options.signal !== undefined) assertArchiveNotAborted(options.signal)
      entry.fileName = portableArchivePath(entry.fileName)
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
      if (entries.length >= MAX_ARCHIVE_FILES) {
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
        manifest = options.parseManifest(JSON.parse(
          await readEntryBounded(zip, entry, MAX_MANIFEST_BYTES),
        ))
      }
      entries.push(entry)
    }
    if (manifest === undefined) {
      throw new WorldlineProjectError('transfer-failed', 'ZIP has no Worldline archive manifest')
    }
    const payloadPrefix = portableArchivePath(options.payloadPrefix(manifest))
    if (!payloadPrefix.endsWith('/')) {
      throw new WorldlineProjectError('transfer-failed', 'archive payload prefix must be a directory')
    }
    if (entries.some(entry => entry.fileName !== ARCHIVE_MANIFEST
      && !entry.fileName.startsWith(payloadPrefix))) {
      throw new WorldlineProjectError('transfer-failed', 'archive contains data outside its declared payload root')
    }
    const payloadEntries = entries.filter(entry => entry.fileName !== ARCHIVE_MANIFEST
      && !entry.fileName.endsWith('/'))
    const payloadBytes = payloadEntries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    if (payloadEntries.length !== manifest.fileCount || payloadBytes !== manifest.expandedBytes) {
      throw new WorldlineProjectError('transfer-failed', 'archive size declaration does not match its ZIP directory')
    }
    const digestFiles = new Map(manifest.files.map(file => [
      `${payloadPrefix}${file.path}`.toLocaleLowerCase('en-US'), file,
    ]))
    const relativePaths = new Set<string>()
    for (const entry of payloadEntries) {
      const declared = digestFiles.get(entry.fileName.toLocaleLowerCase('en-US'))
      if (declared === undefined || declared.bytes !== entry.uncompressedSize) {
        throw new WorldlineProjectError('transfer-failed', `ZIP entry is not covered by its manifest: ${entry.fileName}`)
      }
      digestFiles.delete(entry.fileName.toLocaleLowerCase('en-US'))
      relativePaths.add(entry.fileName.slice(payloadPrefix.length))
    }
    if (digestFiles.size !== 0) {
      throw new WorldlineProjectError('transfer-failed', 'archive manifest declares files missing from the ZIP')
    }
    options.validateLayout(manifest, relativePaths)
    return {
      manifest,
      payloadPrefix,
      entries: entries.map(entry => fingerprint(entry)),
      archiveBytes: archiveInfo.size,
      archiveModifiedAtMs: archiveInfo.mtimeMs,
    }
  } finally {
    zip.close()
  }
}

export async function writeArchive(options: {
  readonly destination: string
  readonly payloadPrefix: string
  readonly sources: readonly ArchiveSourceFile[]
  readonly signal: AbortSignal
  readonly createManifest: (
    files: readonly ArchiveFileDigest[],
    expandedBytes: number,
  ) => ArchiveManifestBase
  readonly onTotal: (totalBytes: number) => void
  readonly onProgress: (completedBytes: number) => void
}): Promise<{ readonly archiveBytes: number; readonly sourceBytes: number }> {
  const destination = resolve(options.destination)
  if (await exists(destination)) {
    throw new WorldlineProjectError('entry-exists', `archive already exists: ${destination}`)
  }
  const payloadPrefix = portableArchivePath(options.payloadPrefix)
  if (!payloadPrefix.endsWith('/')) {
    throw new WorldlineProjectError('transfer-failed', 'archive payload prefix must be a directory')
  }
  if (options.sources.length === 0 || options.sources.length >= MAX_ARCHIVE_FILES) {
    throw new WorldlineProjectError('transfer-failed', 'archive source file count is outside the supported range')
  }
  const names = new Set<string>()
  const sources: PreparedArchiveSource[] = []
  let sourceBytes = 0
  for (const source of options.sources) {
    assertArchiveNotAborted(options.signal)
    const path = portableArchivePath(source.path)
    if (path.endsWith('/')) throw new WorldlineProjectError('transfer-failed', `archive source is not a file: ${path}`)
    const canonical = path.toLocaleLowerCase('en-US')
    if (names.has(canonical)) {
      throw new WorldlineProjectError('transfer-failed', `archive source repeats a file: ${path}`)
    }
    names.add(canonical)
    const info = await stat(source.absolute)
    if (!info.isFile()) throw new WorldlineProjectError('transfer-failed', `archive source is not a file: ${path}`)
    sourceBytes += info.size
    if (sourceBytes > MAX_EXPANDED_BYTES) {
      throw new WorldlineProjectError('transfer-failed', 'archive source exceeds the Worldline size limit')
    }
    sources.push({
      absolute: source.absolute,
      path,
      bytes: info.size,
      modifiedAt: info.mtime,
      mode: info.mode,
      sha256: await sha256File(source.absolute, options.signal),
    })
  }
  if (sourceBytes < 1) throw new WorldlineProjectError('transfer-failed', 'archive has no payload bytes')
  options.onTotal(sourceBytes)
  const digests = sources.map(source => ({
    path: source.path,
    bytes: source.bytes,
    sha256: source.sha256,
  }))
  const manifest = options.createManifest(digests, sourceBytes)
  const envelope = parseArchiveEnvelope(manifest, manifest.kind).base
  if (envelope.fileCount !== sources.length || envelope.expandedBytes !== sourceBytes) {
    throw new WorldlineProjectError('transfer-failed', 'archive manifest factory returned inconsistent totals')
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = resolve(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  const zip = new ZipWriter()
  let completedBytes = 0
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), ARCHIVE_MANIFEST)
  for (const source of sources) {
    zip.addReadStreamLazy(`${payloadPrefix}${source.path}`, {
      size: source.bytes,
      mtime: source.modifiedAt,
      mode: source.mode,
      compress: true,
    }, (callback) => {
      assertArchiveNotAborted(options.signal)
      const digest = createHash('sha256')
      async function* checkedSource(): AsyncIterable<Uint8Array> {
        for await (const chunk of abortable(createReadStream(source.absolute), options.signal)) {
          digest.update(chunk)
          completedBytes += chunk.byteLength
          options.onProgress(completedBytes)
          yield chunk
        }
        if (digest.digest('hex') !== source.sha256) {
          throw new WorldlineProjectError(
            'revision-conflict',
            `archive source changed while exporting: ${source.path}`,
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

export async function extractArchive<M extends ArchiveManifestBase>(options: {
  readonly source: string
  readonly destination: string
  readonly preflight: ArchivePreflight<M>
  readonly signal: AbortSignal
  readonly onProgress: (completedBytes: number) => void
}): Promise<void> {
  const archiveInfo = await stat(resolve(options.source))
  if (archiveInfo.size !== options.preflight.archiveBytes
    || archiveInfo.mtimeMs !== options.preflight.archiveModifiedAtMs) {
    throw new WorldlineProjectError('transfer-failed', 'archive changed after preflight')
  }
  const zip = await openZip(resolve(options.source), {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  })
  const digests = new Map(options.preflight.manifest.files.map(file => [file.path, file]))
  let completedBytes = 0
  let entryIndex = 0
  try {
    for await (const entry of zip.eachEntry()) {
      assertArchiveNotAborted(options.signal)
      entry.fileName = portableArchivePath(entry.fileName)
      const expected = options.preflight.entries[entryIndex]
      entryIndex += 1
      if (expected === undefined || !sameFingerprint(fingerprint(entry), expected)) {
        throw new WorldlineProjectError('transfer-failed', 'archive directory changed after preflight')
      }
      if (entry.isEncrypted() || !entry.canDecodeFileData() || isSymbolicLink(entry)) {
        throw new WorldlineProjectError('transfer-failed', `ZIP entry became unsafe: ${entry.fileName}`)
      }
      const path = entry.fileName
      if (path === ARCHIVE_MANIFEST) continue
      if (!path.startsWith(options.preflight.payloadPrefix)) {
        throw new WorldlineProjectError('transfer-failed', `entry escapes the payload root: ${path}`)
      }
      const relative = path.slice(options.preflight.payloadPrefix.length).replace(/\/$/u, '')
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
      throw new WorldlineProjectError('transfer-failed', 'archive entry count changed after preflight')
    }
  } finally {
    zip.close()
  }
}
