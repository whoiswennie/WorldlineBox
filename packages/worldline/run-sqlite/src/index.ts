import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Checkpoint, JsonObject, RunSnapshot } from '@deepseek-ai/dsh-worldline-standard'

export type RunStream =
  | 'world-event'
  | 'decision-trace'
  | 'observation'
  | 'narrative-beat'
  | 'telemetry'

export interface RunStreamRecord {
  readonly sequence: number
  /** Stable cursor component assigned by SQLite within one authoritative sequence. */
  readonly ordinal?: number
  readonly logicalTime: number
  readonly stream: RunStream
  readonly id: string
  readonly payload: JsonObject
}

export interface RunCommit {
  readonly snapshot: RunSnapshot
  readonly records: readonly RunStreamRecord[]
  readonly metadata?: Readonly<Record<string, string>>
}

const APPLICATION_ID = 0x5757524c
const SCHEMA_VERSION = 1

function parseObject(value: unknown): JsonObject {
  const parsed = JSON.parse(String(value)) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Worldline Run SQLite row does not contain a JSON object')
  }
  return parsed as JsonObject
}

/** SQLite store owned by exactly one Runtime worker for its entire lifetime. */
export class WorldlineRunDatabase {
  readonly database: DatabaseSync

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA application_id=${String(APPLICATION_ID)};
      PRAGMA user_version=${String(SCHEMA_VERSION)};
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS run_meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS snapshot(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        sequence INTEGER NOT NULL,
        logical_time REAL NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS stream_records(
        sequence INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        logical_time REAL NOT NULL,
        stream TEXT NOT NULL CHECK(stream IN (
          'world-event','decision-trace','observation','narrative-beat','telemetry'
        )),
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(sequence, ordinal),
        UNIQUE(stream, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS stream_records_time
        ON stream_records(stream, logical_time, sequence);
      CREATE TABLE IF NOT EXISTS checkpoints(
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        logical_time REAL NOT NULL,
        label TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `)
    const applicationId = Number(this.database.prepare('PRAGMA application_id').get()?.['application_id'])
    const version = Number(this.database.prepare('PRAGMA user_version').get()?.['user_version'])
    if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
      this.database.close()
      throw new Error('Worldline Run SQLite schema identity is incompatible')
    }
  }

  close(): void { this.database.close() }

  meta(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM run_meta WHERE key=?').get(key)
    return row === undefined ? undefined : String(row['value'])
  }

  setMeta(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO run_meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, value)
  }

  initialize(snapshot: RunSnapshot): void {
    const existing = this.snapshot()
    if (existing !== undefined) {
      if (existing.runId !== snapshot.runId || existing.blueprintDigest !== snapshot.blueprintDigest) {
        throw new Error('existing Run database belongs to another immutable Run or Blueprint')
      }
      return
    }
    this.database.prepare(`
      INSERT INTO snapshot(singleton,sequence,logical_time,payload) VALUES(1,?,?,?)
    `).run(snapshot.sequence, snapshot.logicalTime, JSON.stringify(snapshot))
    this.database.prepare('INSERT INTO run_meta(key,value) VALUES(?,?)').run('runId', snapshot.runId)
    this.database.prepare('INSERT INTO run_meta(key,value) VALUES(?,?)')
      .run('blueprintDigest', snapshot.blueprintDigest)
    this.setMeta('status', 'paused')
  }

  snapshot(): RunSnapshot | undefined {
    const row = this.database.prepare('SELECT payload FROM snapshot WHERE singleton=1').get()
    return row === undefined ? undefined : parseObject(row['payload']) as unknown as RunSnapshot
  }

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
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const ordinals = new Map<number, number>()
      for (const record of value.records) {
        if (record.sequence > value.snapshot.sequence) {
          throw new Error('stream record is ahead of the committed snapshot')
        }
        const ordinal = ordinals.get(record.sequence)
          ?? Number(nextOrdinal.get(record.sequence)?.['value'] ?? 0)
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
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  records(
    afterSequence = -1,
    limit = 500,
    stream?: RunStream,
    afterOrdinal = -1,
  ): readonly RunStreamRecord[] {
    const bounded = Math.min(5000, Math.max(1, limit))
    const rows = stream === undefined
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

  checkpoints(): readonly { readonly checkpoint: Checkpoint; readonly label: string; readonly createdAt: string }[] {
    return this.database.prepare(`
      SELECT label,payload,created_at FROM checkpoints ORDER BY sequence DESC
    `).all().map(row => ({
      checkpoint: parseObject(row['payload']) as unknown as Checkpoint,
      label: String(row['label']),
      createdAt: String(row['created_at']),
    }))
  }

  checkpoint(id: string): Checkpoint | undefined {
    const row = this.database.prepare('SELECT payload FROM checkpoints WHERE id=?').get(id)
    return row === undefined ? undefined : parseObject(row['payload']) as unknown as Checkpoint
  }

  integrity(): { readonly ok: boolean; readonly journalMode: string; readonly detail: string } {
    const detail = String(this.database.prepare('PRAGMA integrity_check').get()?.['integrity_check'] ?? '')
    const journalMode = String(this.database.prepare('PRAGMA journal_mode').get()?.['journal_mode'] ?? '')
    return { ok: detail === 'ok' && journalMode.toLowerCase() === 'wal', journalMode, detail }
  }
}

export default WorldlineRunDatabase
