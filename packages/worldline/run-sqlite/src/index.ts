import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Checkpoint, JsonObject, RunSnapshot } from '@deepseek-ai/dsh-worldline-standard'

/** Describes the run stream value exchanged across the package boundary.
 */
export type RunStream =
  | 'world-event'
  | 'decision-trace'
  | 'ai-intent'
  | 'ai-invocation'
  | 'observation'
  | 'narrative-beat'
  | 'presentation-progress'
  | 'action-deck'
  | 'story-progress'
  | 'story-state'
  | 'runtime-diagnostic'
  | 'telemetry'

/** Describes the run stream record value exchanged across the package boundary.
 */
export interface RunStreamRecord {
  readonly sequence: number
  /** Stable cursor component assigned by SQLite within one authoritative sequence. */
  readonly ordinal?: number
  readonly logicalTime: number
  readonly stream: RunStream
  readonly id: string
  readonly payload: JsonObject
}

/** Describes the run commit value exchanged across the package boundary.
 */
export interface RunCommit {
  readonly snapshot: RunSnapshot
  readonly records: readonly RunStreamRecord[]
  readonly metadata?: Readonly<Record<string, string>>
}

/** Configures one authoritative Run database connection. */
export interface Config {
  /** Open the database in query-only mode without creating parent directories. */
  readonly readOnly?: boolean
}

const APPLICATION_ID = 0x5757524c
const CURRENT_SCHEMA_VERSION = 5

const CURRENT_SCHEMA = `
  CREATE TABLE run_meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  CREATE TABLE snapshot(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    sequence INTEGER NOT NULL,
    logical_time REAL NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE checkpoints(
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    logical_time REAL NOT NULL,
    label TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE stream_records(
    sequence INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    logical_time REAL NOT NULL,
    stream TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(sequence, ordinal),
    UNIQUE(stream, id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS stream_records_time
    ON stream_records(stream, logical_time, sequence);
`

function parseObject(value: unknown): JsonObject {
  const parsed = JSON.parse(String(value)) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Worldline Run SQLite row does not contain a JSON object')
  }
  return parsed as JsonObject
}

/** SQLite store owned by exactly one Runtime worker for its entire lifetime. */
export class WorldlineRunDatabase {
  /** Owned SQLite connection; writable mode has exactly one runtime-worker owner. */
  readonly database: DatabaseSync
  /** Whether this connection rejects every mutation path. */
  readonly readOnly: boolean

  constructor(readonly path: string, options: Config = {}) {
    this.readOnly = options.readOnly === true
    if (!this.readOnly) mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { readOnly: this.readOnly })
    this.database.exec(this.readOnly ? `
      PRAGMA query_only=ON;
      PRAGMA busy_timeout=5000;
    ` : `
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
    `)
    const applicationId = Number(this.database.prepare('PRAGMA application_id').get()?.['application_id'])
    const version = Number(this.database.prepare('PRAGMA user_version').get()?.['user_version'])
    const tableCount = Number(this.database.prepare(`
      SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).get()?.['count'])
    const newDatabase = applicationId === 0 && version === 0 && tableCount === 0
    if (!newDatabase && (applicationId !== APPLICATION_ID || version !== CURRENT_SCHEMA_VERSION)) {
      this.database.close()
      throw new Error('Worldline Run SQLite only supports the current schema; rebuild or import the Run')
    }
    if (newDatabase && this.readOnly) {
      this.database.close()
      throw new Error('Worldline Run SQLite archive source is empty')
    }
    if (!newDatabase) return
    try {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ${CURRENT_SCHEMA}
        PRAGMA application_id=${String(APPLICATION_ID)};
        PRAGMA user_version=${String(CURRENT_SCHEMA_VERSION)};
        COMMIT;
      `)
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      this.database.close()
      throw error
    }
  }

  /** Close the owned SQLite connection. */
  close(): void { this.database.close() }

  /** Hold one WAL read snapshot while a logical archive is streamed. */
  beginConsistentRead(): void {
    if (!this.readOnly) throw new Error('consistent archive reads require a read-only Run connection')
    if (this.database.isTransaction) throw new Error('a consistent Run read is already active')
    this.database.exec('BEGIN')
  }

  /** End the active consistent-read snapshot without mutating the Run. */
  endConsistentRead(): void {
    if (this.database.isTransaction) this.database.exec('ROLLBACK')
  }

  /** Read one Run metadata value.
   * @param key - The key supplied by the caller.
   * @returns The result produced by the operation.
   */
  meta(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM run_meta WHERE key=?').get(key)
    return row === undefined ? undefined : String(row['value'])
  }

  /** Persist one metadata value in the authoritative Run database.
   * @param key - The key supplied by the caller.
   * @param value - The value supplied by the caller.
   */
  setMeta(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO run_meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, value)
  }

  /** Read all Run metadata as an immutable record.
   * @returns The result produced by the operation.
   */
  metadata(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.database.prepare('SELECT key,value FROM run_meta ORDER BY key')
      .all().map(row => [String(row['key']), String(row['value'])]))
  }

  /** Initialize an empty Run database from a validated snapshot.
   * @param snapshot - The snapshot supplied by the caller.
   */
  initialize(snapshot: RunSnapshot): void {
    const existing = this.snapshot()
    if (existing !== undefined) {
      if (existing.runId !== snapshot.runId || existing.blueprintDigest !== snapshot.blueprintDigest) {
        throw new Error('existing Run database belongs to another immutable Run or Blueprint')
      }
      return
    }
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.database.prepare(`
        INSERT INTO snapshot(singleton,sequence,logical_time,payload) VALUES(1,?,?,?)
      `).run(snapshot.sequence, snapshot.logicalTime, JSON.stringify(snapshot))
      this.database.prepare('INSERT INTO run_meta(key,value) VALUES(?,?)').run('runId', snapshot.runId)
      this.database.prepare('INSERT INTO run_meta(key,value) VALUES(?,?)')
        .run('blueprintDigest', snapshot.blueprintDigest)
      this.setMeta('status', 'paused')
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** Reconstruct the latest authoritative Run snapshot.
   * @returns The result produced by the operation.
   */
  snapshot(): RunSnapshot | undefined {
    const row = this.database.prepare('SELECT payload FROM snapshot WHERE singleton=1').get()
    return row === undefined ? undefined : parseObject(row['payload']) as unknown as RunSnapshot
  }

  /** Commit the next Run snapshot and append-only records atomically.
   * @param value - The value supplied by the caller.
   */
  commit(value: RunCommit): void {
    const current = this.snapshot()
    if (current === undefined) throw new Error('Run database is not initialized')
    if (value.snapshot.sequence < current.sequence) throw new Error('Run snapshot sequence cannot move backwards')
    const insert = this.database.prepare(`
      INSERT INTO stream_records(sequence,ordinal,logical_time,stream,id,payload)
      VALUES(?,?,?,?,?,?)
    `)
    const nextOrdinal = this.database.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS value
      FROM stream_records WHERE sequence=?
    `)
    try {
      this.database.exec('BEGIN IMMEDIATE')
      const ordinals = new Map<number, number>()
      for (const record of value.records) {
        if (record.sequence > value.snapshot.sequence) {
          throw new Error('stream record is ahead of the committed snapshot')
        }
        const ordinal = ordinals.get(record.sequence)
          ?? (record.sequence > current.sequence
            ? 0
            : Number(nextOrdinal.get(record.sequence)?.['value'] ?? 0))
        insert.run(
          record.sequence,
          ordinal,
          record.logicalTime,
          record.stream,
          record.id,
          JSON.stringify(record.payload),
        )
        ordinals.set(record.sequence, ordinal + 1)
      }
      this.database.prepare(`
        UPDATE snapshot SET sequence=?,logical_time=?,payload=? WHERE singleton=1
      `).run(value.snapshot.sequence, value.snapshot.logicalTime, JSON.stringify(value.snapshot))
      const writeMeta = this.database.prepare(`
        INSERT INTO run_meta(key,value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `)
      for (const [key, metadataValue] of Object.entries(value.metadata ?? {})) {
        writeMeta.run(key, metadataValue)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** Read a filtered page from the append-only record stream.
   * @param afterSequence - The after sequence supplied by the caller.
   * @param limit - The limit supplied by the caller.
   * @param stream - The stream supplied by the caller.
   * @param afterOrdinal - The after ordinal supplied by the caller.
   * @returns The result produced by the operation.
   */
  records(
    afterSequence = -1,
    limit = 500,
    stream?: RunStream,
    afterOrdinal = -1,
    tail = false,
  ): readonly RunStreamRecord[] {
    const bounded = Math.min(5001, Math.max(1, limit))
    const rows = tail
      ? (stream === undefined
        ? this.database.prepare(`
              SELECT sequence,ordinal,logical_time,stream,id,payload FROM stream_records
              ORDER BY sequence DESC,ordinal DESC LIMIT ?
            `).all(bounded)
        : this.database.prepare(`
              SELECT sequence,ordinal,logical_time,stream,id,payload FROM stream_records
              WHERE stream=? ORDER BY sequence DESC,ordinal DESC LIMIT ?
            `).all(stream, bounded)).reverse()
      : stream === undefined
        ? this.database.prepare(`
          SELECT sequence,ordinal,logical_time,stream,id,payload FROM stream_records
          WHERE sequence>? OR (sequence=? AND ordinal>?)
          ORDER BY sequence,ordinal LIMIT ?
        `).all(afterSequence, afterSequence, afterOrdinal, bounded)
        : this.database.prepare(`
          SELECT sequence,ordinal,logical_time,stream,id,payload FROM stream_records
          WHERE (sequence>? OR (sequence=? AND ordinal>?)) AND stream=?
          ORDER BY sequence,ordinal LIMIT ?
        `).all(afterSequence, afterSequence, afterOrdinal, stream, bounded)
    return rows.map(row => ({
      sequence: Number(row['sequence']),
      ordinal: Number(row['ordinal']),
      logicalTime: Number(row['logical_time']),
      stream: String(row['stream']) as RunStream,
      id: String(row['id']),
      payload: parseObject(row['payload']),
    }))
  }

  /** Perform all records through the package's public contract.
   * @returns The result produced by the operation.
   */
  *allRecords(): Iterable<RunStreamRecord> {
    const rows = this.database.prepare(`
      SELECT sequence,ordinal,logical_time,stream,id,payload
      FROM stream_records ORDER BY sequence,ordinal
    `).iterate()
    for (const row of rows) {
      yield {
        sequence: Number(row['sequence']),
        ordinal: Number(row['ordinal']),
        logicalTime: Number(row['logical_time']),
        stream: String(row['stream']) as RunStream,
        id: String(row['id']),
        payload: parseObject(row['payload']),
      }
    }
  }

  /** Read one append-only record by its stable identifier.
   * @param stream - The stream supplied by the caller.
   * @param id - The id supplied by the caller.
   * @returns The result produced by the operation.
   */
  record(stream: RunStream, id: string): RunStreamRecord | undefined {
    const row = this.database.prepare(`
      SELECT sequence,ordinal,logical_time,stream,id,payload
      FROM stream_records WHERE stream=? AND id=?
    `).get(stream, id)
    return row === undefined ? undefined : {
      sequence: Number(row['sequence']),
      ordinal: Number(row['ordinal']),
      logicalTime: Number(row['logical_time']),
      stream: String(row['stream']) as RunStream,
      id: String(row['id']),
      payload: parseObject(row['payload']),
    }
  }

  /** Perform save checkpoint through the package's public contract.
   * @param checkpoint - The checkpoint supplied by the caller.
   * @param label - The label supplied by the caller.
   */
  saveCheckpoint(checkpoint: Checkpoint, label: string): void {
    this.database.prepare(`
      INSERT INTO checkpoints(id,sequence,logical_time,label,payload,created_at)
      VALUES(?,?,?,?,?,?)
    `).run(
      checkpoint.id,
      checkpoint.sequence,
      checkpoint.snapshot.logicalTime,
      label,
      JSON.stringify(checkpoint),
      new Date().toISOString(),
    )
  }

  /** List the checkpoints stored for this Run.
   * @returns The result produced by the operation.
   */
  checkpoints(): readonly { readonly checkpoint: Checkpoint; readonly label: string; readonly createdAt: string }[] {
    return this.database.prepare(`
      SELECT label,payload,created_at FROM checkpoints ORDER BY sequence DESC
    `).all().map(row => ({
      checkpoint: parseObject(row['payload']) as unknown as Checkpoint,
      label: String(row['label']),
      createdAt: String(row['created_at']),
    }))
  }

  /** Persist a named checkpoint for the current Run snapshot.
   * @param id - The id supplied by the caller.
   * @returns The result produced by the operation.
   */
  checkpoint(id: string): Checkpoint | undefined {
    const row = this.database.prepare('SELECT payload FROM checkpoints WHERE id=?').get(id)
    return row === undefined ? undefined : parseObject(row['payload']) as unknown as Checkpoint
  }

  /** Execute SQLite integrity validation and return every reported issue.
   * @returns The result produced by the operation.
   */
  integrity(): { readonly ok: boolean; readonly journalMode: string; readonly detail: string } {
    const detail = String(this.database.prepare('PRAGMA integrity_check').get()?.['integrity_check'] ?? '')
    const journalMode = String(this.database.prepare('PRAGMA journal_mode').get()?.['journal_mode'] ?? '')
    return { ok: detail === 'ok' && journalMode.toLowerCase() === 'wal', journalMode, detail }
  }
}

export default WorldlineRunDatabase
