import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type {
  Blueprint,
  BlueprintId,
  Checkpoint,
  ProjectId,
  RunId,
  RunSnapshot,
} from '@deepseek-ai/dsh-worldline-standard'
import {
  WWS_VERSION,
  stableStringify,
  worldlineId,
} from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineProjectError } from '@deepseek-ai/dsh-worldline-project'
import {
  WorldlineRunDatabase,
  type RunStream,
  type RunStreamRecord,
} from '@deepseek-ai/dsh-worldline-run-sqlite'
import {
  type ArchiveFileDigest,
  type ArchiveManifestBase,
  type ArchivePreflight,
  type ArchiveSourceFile,
  assertArchiveNotAborted,
  extractArchive,
  parseArchiveEnvelope,
  preflightArchive,
  writeArchive,
} from './archive-core.ts'
import {
  copyFileDurable,
  durableWrite,
  durableWriteStream,
  exists,
} from './storage.ts'

const BLUEPRINT_FILES = new Set(['blueprint.json', 'certificate.json', 'source-snapshot.json'])
const RUN_FILES = new Set([
  'blueprint.json',
  'snapshot.json',
  'metadata.json',
  'checkpoints.ndjson',
  'records.ndjson',
])
const RUN_STREAMS = new Set<RunStream>([
  'world-event',
  'decision-trace',
  'ai-intent',
  'ai-invocation',
  'observation',
  'narrative-beat',
  'telemetry',
])
const MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024

interface BlueprintArchiveManifest extends ArchiveManifestBase {
  readonly kind: 'blueprint'
  readonly projectId: ProjectId
  readonly blueprintId: BlueprintId
  readonly blueprintDigest: string
  readonly sourceDigest: string
}

interface RunArchiveManifest extends ArchiveManifestBase {
  readonly kind: 'run'
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly blueprintId: BlueprintId
  readonly blueprintDigest: string
  readonly sequence: number
  readonly recordCount: number
  readonly checkpointCount: number
}

/** Describes the blueprint archive preflight value exchanged across the package boundary.
 */
export type BlueprintArchivePreflight = ArchivePreflight<BlueprintArchiveManifest>
/** Describes the run archive preflight value exchanged across the package boundary.
 */
export type RunArchivePreflight = ArchivePreflight<RunArchiveManifest>

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requiredString(source: Readonly<Record<string, unknown>>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorldlineProjectError('transfer-failed', `archive manifest ${key} is malformed`)
  }
  return value
}

function requiredCount(source: Readonly<Record<string, unknown>>, key: string): number {
  const value = source[key]
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new WorldlineProjectError('transfer-failed', `archive manifest ${key} is malformed`)
  }
  return Number(value)
}

function parseBlueprintManifest(value: unknown): BlueprintArchiveManifest {
  const { source, base } = parseArchiveEnvelope(value, 'blueprint')
  const blueprintDigest = requiredString(source, 'blueprintDigest')
  const sourceDigest = requiredString(source, 'sourceDigest')
  if (!/^[a-f0-9]{64}$/u.test(blueprintDigest) || !/^[a-f0-9]{64}$/u.test(sourceDigest)) {
    throw new WorldlineProjectError('transfer-failed', 'Blueprint archive digests must be lowercase SHA-256')
  }
  return {
    ...base,
    kind: 'blueprint',
    projectId: worldlineId<'project'>(requiredString(source, 'projectId')),
    blueprintId: worldlineId<'blueprint'>(requiredString(source, 'blueprintId')),
    blueprintDigest,
    sourceDigest,
  }
}

function parseRunManifest(value: unknown): RunArchiveManifest {
  const { source, base } = parseArchiveEnvelope(value, 'run')
  const blueprintDigest = requiredString(source, 'blueprintDigest')
  if (!/^[a-f0-9]{64}$/u.test(blueprintDigest)) {
    throw new WorldlineProjectError('transfer-failed', 'Run archive Blueprint digest must be lowercase SHA-256')
  }
  return {
    ...base,
    kind: 'run',
    projectId: worldlineId<'project'>(requiredString(source, 'projectId')),
    runId: worldlineId<'run'>(requiredString(source, 'runId')),
    blueprintId: worldlineId<'blueprint'>(requiredString(source, 'blueprintId')),
    blueprintDigest,
    sequence: requiredCount(source, 'sequence'),
    recordCount: requiredCount(source, 'recordCount'),
    checkpointCount: requiredCount(source, 'checkpointCount'),
  }
}

function validateExactLayout(expected: ReadonlySet<string>, paths: ReadonlySet<string>): void {
  if (paths.size !== expected.size || [...expected].some(path => !paths.has(path))) {
    throw new WorldlineProjectError('transfer-failed', 'archive payload does not match its current artifact layout')
  }
}

/** Perform preflight blueprint archive through the package's public contract.
 * @param source - The source supplied by the caller.
 * @param signal - The signal supplied by the caller.
 * @returns The result produced by the operation.
 */
export function preflightBlueprintArchive(
  source: string,
  signal?: AbortSignal,
): Promise<BlueprintArchivePreflight> {
  return preflightArchive({
    source,
    ...(signal === undefined ? {} : { signal }),
    parseManifest: parseBlueprintManifest,
    payloadPrefix: () => 'payload/',
    validateLayout: (_manifest, paths) => { validateExactLayout(BLUEPRINT_FILES, paths) },
  })
}

/** Perform preflight run archive through the package's public contract.
 * @param source - The source supplied by the caller.
 * @param signal - The signal supplied by the caller.
 * @returns The result produced by the operation.
 */
export function preflightRunArchive(
  source: string,
  signal?: AbortSignal,
): Promise<RunArchivePreflight> {
  return preflightArchive({
    source,
    ...(signal === undefined ? {} : { signal }),
    parseManifest: parseRunManifest,
    payloadPrefix: () => 'payload/',
    validateLayout: (_manifest, paths) => { validateExactLayout(RUN_FILES, paths) },
  })
}

async function parseBlueprintFiles(directory: string): Promise<{
  readonly blueprint: Blueprint
  readonly blueprintText: string
  readonly certificateText: string
  readonly sourceSnapshotText: string
  readonly sourceDigest: string
}> {
  const blueprintText = await readFile(resolve(directory, 'blueprint.json'), 'utf8')
  const certificateText = await readFile(resolve(directory, 'certificate.json'), 'utf8')
  const sourceSnapshotText = await readFile(resolve(directory, 'source-snapshot.json'), 'utf8')
  const blueprint = parseBlueprint(JSON.parse(blueprintText) as unknown)
  const certificate = JSON.parse(certificateText) as Readonly<Record<string, unknown>>
  const sourceSnapshot = jsonObject(JSON.parse(sourceSnapshotText) as unknown, 'Blueprint source snapshot')
  if (certificate['blueprintDigest'] !== blueprint.digest
    || stableStringify(certificate) !== stableStringify(blueprint.certificate)
    || sourceSnapshot['projectId'] !== blueprint.projectId
    || typeof sourceSnapshot['digest'] !== 'string'
    || !/^[a-f0-9]{64}$/u.test(sourceSnapshot['digest'])
    || typeof sourceSnapshot['capturedAt'] !== 'string'
    || !Number.isFinite(Date.parse(sourceSnapshot['capturedAt']))
    || !Array.isArray(sourceSnapshot['files'])) {
    throw new WorldlineProjectError('transfer-failed', 'frozen Blueprint artifacts disagree or are malformed')
  }
  return {
    blueprint,
    blueprintText,
    certificateText,
    sourceSnapshotText,
    sourceDigest: sourceSnapshot['digest'],
  }
}

/** Export a compiled blueprint as a deterministic archive.
 * @param options - The options supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function exportBlueprintArchive(options: {
  readonly buildDirectory: string
  readonly destination: string
  readonly signal: AbortSignal
  readonly onTotal: (totalBytes: number) => void
  readonly onProgress: (completedBytes: number) => void
}): Promise<{ readonly archiveBytes: number; readonly sourceBytes: number }> {
  const artifacts = await parseBlueprintFiles(options.buildDirectory)
  const sources = [...BLUEPRINT_FILES].map(path => ({
    absolute: resolve(options.buildDirectory, path),
    path,
  }))
  return writeArchive({
    destination: options.destination,
    payloadPrefix: 'payload/',
    sources,
    signal: options.signal,
    createManifest: (files: readonly ArchiveFileDigest[], expandedBytes: number) => ({
      format: WWS_VERSION,
      kind: 'blueprint',
      projectId: artifacts.blueprint.projectId,
      blueprintId: artifacts.blueprint.id,
      blueprintDigest: artifacts.blueprint.digest,
      sourceDigest: artifacts.sourceDigest,
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      expandedBytes,
      files,
    }),
    onTotal: options.onTotal,
    onProgress: options.onProgress,
  })
}

/** Perform extract and verify blueprint archive through the package's public contract.
 * @param options - The options supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function extractAndVerifyBlueprintArchive(options: {
  readonly source: string
  readonly destination: string
  readonly preflight: BlueprintArchivePreflight
  readonly signal: AbortSignal
  readonly onProgress: (completedBytes: number) => void
}): Promise<Awaited<ReturnType<typeof parseBlueprintFiles>>> {
  await extractArchive(options)
  const artifacts = await parseBlueprintFiles(options.destination)
  const manifest = options.preflight.manifest
  if (artifacts.blueprint.projectId !== manifest.projectId
    || artifacts.blueprint.id !== manifest.blueprintId
    || artifacts.blueprint.digest !== manifest.blueprintDigest
    || artifacts.sourceDigest !== manifest.sourceDigest) {
    throw new WorldlineProjectError('manifest-conflict', 'Blueprint archive identity does not match its payload')
  }
  return artifacts
}

function lineBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`)
}

async function writeNdjson(
  path: string,
  values: () => Iterable<unknown>,
  expectedBytes: number,
): Promise<void> {
  function* lines(): Iterable<Uint8Array> {
    for (const value of values()) yield Buffer.from(`${JSON.stringify(value)}\n`)
  }
  await durableWriteStream(path, Readable.from(lines()), expectedBytes)
}

/** Export a Run as a deterministic archive.
 * @param options - The options supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function exportRunArchive(options: {
  readonly runDirectory: string
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly destination: string
  readonly signal: AbortSignal
  readonly onTotal: (totalBytes: number) => void
  readonly onProgress: (completedBytes: number) => void
}): Promise<{ readonly archiveBytes: number; readonly sourceBytes: number }> {
  const databasePath = resolve(options.runDirectory, 'world.sqlite')
  const blueprintPath = resolve(options.runDirectory, 'blueprint.json')
  if (!(await exists(databasePath)) || !(await exists(blueprintPath))) {
    throw new WorldlineProjectError('entry-not-found', 'Run storage is missing its ledger or retained Blueprint')
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'worldline-run-archive-'))
  let database: WorldlineRunDatabase | undefined
  try {
    const reader = new WorldlineRunDatabase(databasePath, { readOnly: true })
    database = reader
    reader.beginConsistentRead()
    const snapshot = reader.snapshot()
    if (snapshot === undefined || snapshot.runId !== options.runId) {
      throw new WorldlineProjectError('manifest-conflict', 'Run ledger identity does not match its storage')
    }
    const blueprint = parseBlueprint(JSON.parse(await readFile(blueprintPath, 'utf8')) as unknown)
    if (blueprint.projectId !== options.projectId
      || blueprint.id !== snapshot.blueprintId || blueprint.digest !== snapshot.blueprintDigest) {
      throw new WorldlineProjectError('manifest-conflict', 'Run retained Blueprint does not match its snapshot')
    }
    const metadata = { ...reader.metadata(), status: 'paused' }
    const checkpoints = reader.checkpoints()
    let recordBytes = 0
    let recordCount = 0
    for (const record of reader.allRecords()) {
      assertArchiveNotAborted(options.signal)
      recordBytes += lineBytes(record)
      recordCount += 1
    }
    const checkpointBytes = checkpoints.reduce((sum, checkpoint) => sum + lineBytes(checkpoint), 0)
    await durableWrite(resolve(temporary, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
    await durableWrite(resolve(temporary, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    await writeNdjson(resolve(temporary, 'checkpoints.ndjson'), () => checkpoints, checkpointBytes)
    await writeNdjson(resolve(temporary, 'records.ndjson'), () => reader.allRecords(), recordBytes)
    const sources: ArchiveSourceFile[] = [
      { absolute: blueprintPath, path: 'blueprint.json' },
      { absolute: resolve(temporary, 'snapshot.json'), path: 'snapshot.json' },
      { absolute: resolve(temporary, 'metadata.json'), path: 'metadata.json' },
      { absolute: resolve(temporary, 'checkpoints.ndjson'), path: 'checkpoints.ndjson' },
      { absolute: resolve(temporary, 'records.ndjson'), path: 'records.ndjson' },
    ]
    return await writeArchive({
      destination: options.destination,
      payloadPrefix: 'payload/',
      sources,
      signal: options.signal,
      createManifest: (files: readonly ArchiveFileDigest[], expandedBytes: number) => ({
        format: WWS_VERSION,
        kind: 'run',
        projectId: options.projectId,
        runId: options.runId,
        blueprintId: snapshot.blueprintId,
        blueprintDigest: snapshot.blueprintDigest,
        sequence: snapshot.sequence,
        recordCount,
        checkpointCount: checkpoints.length,
        createdAt: new Date().toISOString(),
        fileCount: files.length,
        expandedBytes,
        files,
      }),
      onTotal: options.onTotal,
      onProgress: options.onProgress,
    })
  } finally {
    database?.endConsistentRead()
    database?.close()
    await rm(temporary, { recursive: true, force: true })
  }
}

function jsonObject(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorldlineProjectError('transfer-failed', `${name} must be a JSON object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function parseBlueprint(value: unknown): Blueprint {
  const source = jsonObject(value, 'Blueprint')
  if (source['format'] !== WWS_VERSION || typeof source['id'] !== 'string'
    || typeof source['projectId'] !== 'string' || typeof source['digest'] !== 'string'
    || !/^[a-f0-9]{64}$/u.test(source['digest'])
    || !Array.isArray(source['canon']) || !Array.isArray(source['links'])
    || !Array.isArray(source['maps']) || !Array.isArray(source['entities'])
    || !Array.isArray(source['actions']) || !Array.isArray(source['systems'])
    || !Array.isArray(source['invariants']) || !Array.isArray(source['provenance'])) {
    throw new WorldlineProjectError('transfer-failed', 'Blueprint identity or format is malformed')
  }
  jsonObject(source['purpose'], 'Blueprint purpose')
  jsonObject(source['modelPolicy'], 'Blueprint model policy')
  jsonObject(source['certificate'], 'Blueprint certificate')
  return {
    ...source,
    id: worldlineId<'blueprint'>(source['id']),
    projectId: worldlineId<'project'>(source['projectId']),
  } as unknown as Blueprint
}

function parseRunSnapshot(value: unknown): RunSnapshot {
  const source = jsonObject(value, 'Run snapshot')
  if (typeof source['runId'] !== 'string' || typeof source['blueprintId'] !== 'string'
    || typeof source['blueprintDigest'] !== 'string' || typeof source['branchId'] !== 'string'
    || !Number.isSafeInteger(source['sequence']) || Number(source['sequence']) < 0
    || typeof source['logicalTime'] !== 'number' || !Number.isFinite(source['logicalTime'])
    || !Array.isArray(source['processes']) || !Array.isArray(source['reservations'])
    || !Array.isArray(source['futureEvents'])) {
    throw new WorldlineProjectError('transfer-failed', 'Run snapshot identity or cursor is malformed')
  }
  jsonObject(source['state'], 'Run state')
  jsonObject(source['modelPolicy'], 'Run model policy')
  jsonObject(source['aiBudget'], 'Run AI budget')
  jsonObject(source['aiUsage'], 'Run AI usage')
  return {
    ...source,
    runId: worldlineId<'run'>(source['runId']),
    blueprintId: worldlineId<'blueprint'>(source['blueprintId']),
    branchId: worldlineId<'worldline'>(source['branchId']),
  } as unknown as RunSnapshot
}

function parseRecord(value: unknown, snapshot: RunSnapshot): RunStreamRecord {
  const source = jsonObject(value, 'Run record')
  if (!Number.isSafeInteger(source['sequence']) || Number(source['sequence']) < 0
    || Number(source['sequence']) > snapshot.sequence
    || !Number.isSafeInteger(source['ordinal']) || Number(source['ordinal']) < 0
    || typeof source['logicalTime'] !== 'number' || !Number.isFinite(source['logicalTime'])
    || typeof source['stream'] !== 'string' || !RUN_STREAMS.has(source['stream'] as RunStream)
    || typeof source['id'] !== 'string' || source['id'].trim() === '') {
    throw new WorldlineProjectError('transfer-failed', 'Run record cursor or identity is malformed')
  }
  jsonObject(source['payload'], 'Run record payload')
  return source as unknown as RunStreamRecord
}

function parseCheckpoint(value: unknown, snapshot: RunSnapshot): {
  readonly checkpoint: Checkpoint
  readonly label: string
} {
  const source = jsonObject(value, 'Run checkpoint entry')
  const checkpointSource = jsonObject(source['checkpoint'], 'Run checkpoint')
  const checkpointSnapshot = parseRunSnapshot(checkpointSource['snapshot'])
  if (typeof checkpointSource['id'] !== 'string' || typeof checkpointSource['runId'] !== 'string'
    || !Number.isSafeInteger(checkpointSource['sequence']) || Number(checkpointSource['sequence']) < 0
    || typeof checkpointSource['createdAt'] !== 'string'
    || typeof checkpointSource['digest'] !== 'string') {
    throw new WorldlineProjectError('transfer-failed', 'Run checkpoint fields are malformed')
  }
  const checkpoint = {
    ...checkpointSource,
    id: worldlineId<'checkpoint'>(checkpointSource['id']),
    runId: worldlineId<'run'>(checkpointSource['runId']),
    snapshot: checkpointSnapshot,
  } as unknown as Checkpoint
  if (typeof source['label'] !== 'string' || source['label'].trim() === ''
    || checkpoint.runId !== snapshot.runId || checkpoint.snapshot.runId !== snapshot.runId
    || checkpoint.snapshot.blueprintDigest !== snapshot.blueprintDigest
    || checkpoint.sequence > snapshot.sequence
    || checkpoint.digest !== sha256(stableStringify(checkpoint.snapshot))) {
    throw new WorldlineProjectError('transfer-failed', 'Run checkpoint identity or digest is malformed')
  }
  return { checkpoint, label: source['label'] }
}

async function* ndjson(path: string): AsyncIterable<unknown> {
  const input = createReadStream(path)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      if (Buffer.byteLength(line) > MAX_NDJSON_LINE_BYTES) {
        throw new WorldlineProjectError('transfer-failed', `NDJSON line exceeds ${String(MAX_NDJSON_LINE_BYTES)} bytes`)
      }
      yield JSON.parse(line) as unknown
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

/** Perform extract and import run archive through the package's public contract.
 * @param options - The options supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function extractAndImportRunArchive(options: {
  readonly source: string
  readonly destination: string
  readonly preflight: RunArchivePreflight
  readonly databasePath: string
  readonly retainedBlueprintPath: string
  readonly signal: AbortSignal
  readonly onProgress: (completedBytes: number) => void
}): Promise<void> {
  await extractArchive(options)
  const manifest = options.preflight.manifest
  const snapshot = parseRunSnapshot(JSON.parse(
    await readFile(resolve(options.destination, 'snapshot.json'), 'utf8'),
  ))
  const blueprint = parseBlueprint(JSON.parse(
    await readFile(resolve(options.destination, 'blueprint.json'), 'utf8'),
  ) as unknown)
  const metadata = jsonObject(JSON.parse(
    await readFile(resolve(options.destination, 'metadata.json'), 'utf8'),
  ), 'Run metadata')
  if (Object.keys(metadata).length > 1_000
    || Object.entries(metadata).some(([key, value]) => key.trim() === '' || typeof value !== 'string')) {
    throw new WorldlineProjectError('transfer-failed', 'Run metadata must contain bounded string pairs')
  }
  if (snapshot.runId !== manifest.runId || snapshot.blueprintId !== manifest.blueprintId
    || snapshot.blueprintDigest !== manifest.blueprintDigest || snapshot.sequence !== manifest.sequence
    || blueprint.projectId !== manifest.projectId
    || blueprint.id !== manifest.blueprintId || blueprint.digest !== manifest.blueprintDigest) {
    throw new WorldlineProjectError('manifest-conflict', 'Run archive identity does not match its payload')
  }
  if (await exists(options.databasePath)) {
    throw new WorldlineProjectError('entry-exists', `Run already exists: ${manifest.runId}`)
  }
  const database = new WorldlineRunDatabase(options.databasePath)
  try {
    database.initialize(snapshot)
    const records: RunStreamRecord[] = []
    let recordCount = 0
    let previousSequence = -1
    let previousOrdinal = -1
    for await (const value of ndjson(resolve(options.destination, 'records.ndjson'))) {
      assertArchiveNotAborted(options.signal)
      const record = parseRecord(value, snapshot)
      const ordinal = record.ordinal ?? 0
      if (record.sequence < previousSequence
        || (record.sequence === previousSequence && ordinal !== previousOrdinal + 1)
        || (record.sequence > previousSequence && ordinal !== 0)) {
        throw new WorldlineProjectError('transfer-failed', 'Run records are not strictly ordered')
      }
      previousSequence = record.sequence
      previousOrdinal = ordinal
      records.push(record)
      recordCount += 1
      if (records.length >= 1_000) {
        database.commit({ snapshot, records: records.splice(0) })
      }
    }
    if (records.length > 0) database.commit({ snapshot, records })
    if (recordCount !== manifest.recordCount) {
      throw new WorldlineProjectError('transfer-failed', 'Run archive record count does not match its manifest')
    }
    let checkpointCount = 0
    for await (const value of ndjson(resolve(options.destination, 'checkpoints.ndjson'))) {
      assertArchiveNotAborted(options.signal)
      const item = parseCheckpoint(value, snapshot)
      database.saveCheckpoint(item.checkpoint, item.label)
      checkpointCount += 1
    }
    if (checkpointCount !== manifest.checkpointCount) {
      throw new WorldlineProjectError('transfer-failed', 'Run archive checkpoint count does not match its manifest')
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && key !== 'runId' && key !== 'blueprintDigest') {
        database.setMeta(key, key === 'status' ? 'paused' : value)
      }
    }
    await copyFileDurable(
      resolve(options.destination, 'blueprint.json'),
      options.retainedBlueprintPath,
    )
  } finally {
    database.close()
  }
}
