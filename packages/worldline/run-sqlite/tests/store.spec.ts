import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import type { RunSnapshot } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineRunDatabase } from '../src/index.ts'

const roots: string[] = []

function snapshot(sequence = 0): RunSnapshot {
  return {
    runId: worldlineId<'run'>('run:sqlite-test-0001'),
    blueprintId: worldlineId<'blueprint'>('blueprint:sqlite-test-0001'),
    blueprintDigest: 'b'.repeat(64),
    branchId: worldlineId<'worldline'>('worldline:sqlite-test-0001'),
    seed: 'sqlite-seed',
    logicalTime: sequence * 10,
    sequence,
    state: { value: sequence },
    processes: [], reservations: [], futureEvents: [], randomState: 'random-state',
    modelPolicy: { routes: {}, aiEnabled: false, revision: 'sha256:model-policy' as RunSnapshot['modelPolicy']['revision'] },
    aiBudget: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxConcurrent: 0, maxCallsPerLogicalDay: 0, maxCallsPerRealHour: 0, maxEstimatedCost: 0, currency: 'USD' },
    aiUsage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0, cacheHits: 0 },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorldlineRunDatabase', () => {
  it('rejects a stale schema instead of carrying compatibility code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-run-db-stale-'))
    roots.push(root)
    const path = join(root, 'world.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      PRAGMA application_id=0x5757524c;
      PRAGMA user_version=1;
      CREATE TABLE stream_records(
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
    `)
    legacy.close()

    expect(() => new WorldlineRunDatabase(path)).toThrow(/only supports the current schema/u)

    const inspected = new DatabaseSync(path, { readOnly: true })
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    const schema = inspected.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='stream_records'",
    ).get()
    expect(String(schema?.['sql'])).toContain('CHECK(stream')
    inspected.close()
  })

  it('commits a snapshot and separated streams atomically in WAL mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-run-db-'))
    roots.push(root)
    const path = join(root, 'world.sqlite')
    const store = new WorldlineRunDatabase(path)
    store.initialize(snapshot())
    store.commit({
      snapshot: snapshot(1),
      records: [{
        sequence: 1,
        logicalTime: 10,
        stream: 'telemetry',
        id: 'telemetry:test-000001',
        payload: { queueDepth: 0 },
      }],
    })
    expect(store.integrity()).toMatchObject({ ok: true, journalMode: 'wal' })
    store.close()

    const reopened = new WorldlineRunDatabase(path)
    expect(reopened.snapshot()).toMatchObject({ sequence: 1, logicalTime: 10, state: { value: 1 } })
    expect(reopened.records()).toHaveLength(1)
    reopened.close()
  })

  it('leaves no partial state when initialization or a later disk write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-run-db-write-failure-'))
    roots.push(root)
    const store = new WorldlineRunDatabase(join(root, 'world.sqlite'))
    store.database.exec(`
      CREATE TEMP TRIGGER fail_blueprint_meta
      BEFORE INSERT ON run_meta WHEN NEW.key='blueprintDigest'
      BEGIN SELECT RAISE(ABORT, 'simulated persistent write failure'); END;
    `)
    expect(() => { store.initialize(snapshot()) }).toThrow(/simulated persistent write failure/u)
    expect(store.snapshot()).toBeUndefined()
    expect(store.metadata()).toEqual({})
    expect(store.database.isTransaction).toBe(false)

    store.database.exec('DROP TRIGGER fail_blueprint_meta')
    store.initialize(snapshot())
    store.database.exec('PRAGMA query_only=ON')
    expect(() => {
      store.commit({
        snapshot: snapshot(1),
        records: [{
          sequence: 1,
          logicalTime: 10,
          stream: 'telemetry',
          id: 'telemetry:write-failure-000001',
          payload: { queueDepth: 1 },
        }],
      })
    }).toThrow()
    store.database.exec('PRAGMA query_only=OFF')
    expect(store.snapshot()).toMatchObject({ sequence: 0, logicalTime: 0 })
    expect(store.records()).toEqual([])
    expect(store.database.isTransaction).toBe(false)

    store.commit({ snapshot: snapshot(1), records: [] })
    expect(store.snapshot()).toMatchObject({ sequence: 1, logicalTime: 10 })
    store.close()
  })

  it('refuses to move a persisted snapshot sequence backwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-run-db-order-'))
    roots.push(root)
    const store = new WorldlineRunDatabase(join(root, 'world.sqlite'))
    store.initialize(snapshot(2))
    expect(() => { store.commit({ snapshot: snapshot(1), records: [] }) }).toThrow(/backwards/u)
    store.close()
  })

  it('appends records safely when several commits share one snapshot sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-run-db-same-sequence-'))
    roots.push(root)
    const store = new WorldlineRunDatabase(join(root, 'world.sqlite'))
    store.initialize(snapshot())
    for (const id of ['telemetry:test-000001', 'telemetry:test-000002']) {
      store.commit({
        snapshot: snapshot(),
        records: [{
          sequence: 0,
          logicalTime: 0,
          stream: 'telemetry',
          id,
          payload: { queueDepth: 0 },
        }],
      })
    }
    expect(store.records()).toHaveLength(2)
    const first = store.records(-1, 1)[0]
    if (first === undefined || first.ordinal === undefined) throw new Error('first cursor is absent')
    expect(first).toMatchObject({ sequence: 0, ordinal: 0 })
    expect(store.records(first.sequence, 1, undefined, first.ordinal)).toEqual([
      expect.objectContaining({ sequence: 0, ordinal: 1 }),
    ])
    store.close()
  })

  it('streams a stable logical view from a read-only WAL snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-run-db-reader-'))
    roots.push(root)
    const path = join(root, 'world.sqlite')
    const writer = new WorldlineRunDatabase(path)
    writer.initialize(snapshot())
    writer.commit({
      snapshot: snapshot(1),
      records: [{
        sequence: 1,
        logicalTime: 10,
        stream: 'telemetry',
        id: 'telemetry:reader-000001',
        payload: { queueDepth: 1 },
      }],
      metadata: { status: 'running', runtimeState: '{}' },
    })

    const reader = new WorldlineRunDatabase(path, { readOnly: true })
    reader.beginConsistentRead()
    expect(reader.snapshot()).toMatchObject({ sequence: 1 })
    expect([...reader.allRecords()]).toEqual([
      expect.objectContaining({ id: 'telemetry:reader-000001', ordinal: 0 }),
    ])
    expect(reader.metadata()).toMatchObject({ status: 'running', runtimeState: '{}' })
    reader.endConsistentRead()
    reader.close()
    writer.close()
  })
})
