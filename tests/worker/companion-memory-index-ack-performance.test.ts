import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionExperienceStore } from '../../src/companions/experience-store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

type Connection = CompanionConnection & { inTransaction: boolean };
const fixtures: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    if (path.dirname(fixture.root) !== path.resolve(tmpdir()) || !path.basename(fixture.root).startsWith('memory-index-ack-')) throw Error('Unexpected fixture directory');
    removeOwnedDirectorySync(fixture.root);
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'memory-index-ack-')), file = path.join(root, 'ledger.sqlite');
  const prototype = (Database as unknown as { prototype: Connection }).prototype, prepare = prototype.prepare;
  const connections = new Set<Connection>();
  let measuring = false;
  const statements = new Map<string, number>();
  vi.spyOn(prototype, 'prepare').mockImplementation(function(this: Connection, sql: string) {
    connections.add(this);
    if (measuring) statements.set(sql, (statements.get(sql) ?? 0) + 1);
    return prepare.call(this, sql);
  });
  const store = new CompanionsStore(file, ['alice', 'bob'].map(id => ({ id, name: id, persona: 'Synthetic source accounting', description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  fixtures.push({ root, store });
  const db = connections.values().next().value!, scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const write = (count: number) => Array.from({ length: count }, (_, index) => store.saveMemory({ ...scope,
    content: `Synthetic source-backed item ${index}: the blue umbrella agreement remains unfinished; verify the actual receipt before claiming success.`,
    tags: ['umbrella', `item_${index}`], diaryName: '资料', autoTags: false }));
  const pendingExperiences = () => Number((db.prepare('SELECT (SELECT count(*) FROM companion_experience_projection)+(SELECT count(*) FROM companion_experience_archive) AS n').get() as { n: number }).n);
  const settleExperiences = () => {
    for (let rounds = 0; pendingExperiences() && rounds < 10000; rounds++) store.request({ type: 'state', companionId: 'alice', includeConversations: false });
    expect(pendingExperiences()).toBe(0);
  };
  return { root, file, store, db, scope, write, statements, settleExperiences, measure: (value: boolean) => { measuring = value; } };
}
const count = (db: Connection, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const output = (name: string, value: unknown) => { mkdirSync('artifacts/vcp-validation', { recursive: true }); writeFileSync(path.join('artifacts/vcp-validation', name), JSON.stringify(value, null, 2)); };
const claimSql = `SELECT o.* FROM vcp_memory_outbox o WHERE o.companion_id=? AND o.status IN('pending','failed') AND o.next_attempt<=? AND o.attempts<8
  AND NOT EXISTS(SELECT 1 FROM vcp_memory_outbox active WHERE active.scope_id=o.scope_id AND active.status='running' AND active.lease_until>?) ORDER BY o.ordinal LIMIT 1`;
const scopeSql = "SELECT 1 FROM vcp_memory_outbox WHERE scope_id=? AND status NOT IN('done','stale','cancelled') LIMIT 1";
const plans = (db: Connection, scope: string) => ({
  claim: db.prepare('EXPLAIN QUERY PLAN ' + claimSql).all('alice', Date.now(), Date.now()),
  scope: db.prepare('EXPLAIN QUERY PLAN ' + scopeSql).all(scope),
});

it('records real SQLite ACK and synchronous experience costs for an unchanged source-backed corpus', () => {
  const requested = Number(process.env.WORLDLINEBOX_ACK_PROBE_NOTES ?? 24);
  if (!Number.isInteger(requested) || requested < 1 || requested > 2000) throw Error('Unexpected probe size');
  const label = process.env.WORLDLINEBOX_ACK_PROBE_LABEL ?? 'current';
  if (!/^[a-z0-9-]{1,40}$/u.test(label)) throw Error('Unexpected probe label');
  const f = fixture(), notes = f.write(requested); f.settleExperiences();
  // Diagnostic-only append accounting; both before/after runs retain the
  // production FULL synchronous setting. Disable auto-checkpoint only here so
  // WAL growth measures written frames rather than reused file high-watermark.
  f.db.pragma('wal_autocheckpoint=0'); f.db.pragma('wal_checkpoint(TRUNCATE)');
  const initialPlans = plans(f.db, notes[0]!.scopeId);
  const prototype = CompanionExperienceStore.prototype as unknown as { projectPending(limit?: number): void };
  const project = prototype.projectPending;
  let projectCalls = 0, projectMs = 0;
  vi.spyOn(prototype, 'projectPending').mockImplementation(function(this: CompanionExperienceStore, limit?: number) {
    const began = performance.now();
    try { return project.call(this, limit); } finally { projectCalls++; projectMs += performance.now() - began; }
  });
  const totalChanges = () => Number((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  const beforeChanges = totalChanges(), sourceRows = count(f.db, 'vcp_note_sources'), bodyRows = count(f.db, 'companion_memory_content_revisions');
  const claimMs: number[] = [], ackMs: number[] = []; f.measure(true);
  const began = performance.now();
  for (const note of notes) {
    let step = performance.now();
    const lease = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    claimMs.push(performance.now() - step); expect(lease.noteId).toBe(note.id);
    step = performance.now();
    expect(f.store.request({ type: 'memory.outbox.complete', id: lease.id, leaseToken: lease.leaseToken, indexed: true }).memoryOutboxDisposition).toEqual({ state: 'completed' });
    ackMs.push(performance.now() - step);
  }
  const elapsedMs = performance.now() - began; f.measure(false);
  expect(f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox).toBeUndefined();
  expect(count(f.db, 'vcp_note_sources')).toBe(sourceRows);
  expect(count(f.db, 'companion_memory_content_revisions')).toBe(bodyRows);
  const mutations = totalChanges() - beforeChanges;
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]!;
  const walBytes = existsSync(f.file + '-wal') ? statSync(f.file + '-wal').size : 0;
  const report = { label, actualSQLite: true, synchronous: f.db.pragma('synchronous', { simple: true }), actualExperienceFiles: true,
    actualNative: false, actualProvider: false, canonicalBodyReadLatencyMeasured: false, notes: requested,
    corpusHash: hash(notes.map(note => note.content).join('\n')), sourceHashes: ['src/companions/memory-store.ts', 'src/companions/experience-store.ts'].map(file => ({ file, sha256: hash(readFileSync(file, 'utf8')) })),
    elapsedMs, claim: { totalMs: claimMs.reduce((sum, value) => sum + value, 0), p50: percentile(claimMs, .5), p95: percentile(claimMs, .95) },
    ack: { totalMs: ackMs.reduce((sum, value) => sum + value, 0), p50: percentile(ackMs, .5), p95: percentile(ackMs, .95) },
    experienceProjection: { calls: projectCalls, totalMs: projectMs }, sqliteTotalChanges: mutations, walAppendBytes: walBytes,
    sourceDeleteStatements: [...f.statements].filter(([sql]) => sql.startsWith('DELETE FROM vcp_note_sources')).reduce((sum, [, n]) => sum + n, 0),
    statementPrepares: [...f.statements.values()].reduce((sum, n) => sum + n, 0), queryPlans: initialPlans,
    limits: ['SQLite plus synchronous experience archive only; no native ingestion or model/encoder performance claim.', 'WAL bytes include triggers and experience writes; FULL sync retained, auto-checkpoint disabled only in this isolated diagnostic.', 'One sample per implementation, not a latency distribution benchmark across machines.'] };
  output(`memory-index-ack-${label}-${requested}.json`, report);
}, 180000);

it('compares actual pending-query plans and exact FIFO results before considering partial indexes', () => {
  const f = fixture(), notes = f.write(64); f.settleExperiences();
  for (let i = 0; i < 48; i++) { const lease = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    f.store.request({ type: 'memory.outbox.complete', id: lease.id, leaseToken: lease.leaseToken, indexed: true }); }
  const before = plans(f.db, notes[0]!.scopeId), select = () => f.db.prepare(claimSql).get('alice', Date.now(), Date.now()) as { note_id: string };
  const selectedBefore = select();
  f.db.exec(`CREATE INDEX IF NOT EXISTS ack_probe_owner_pending ON vcp_memory_outbox(companion_id,ordinal)
    WHERE status IN('pending','failed') AND attempts<8;
    CREATE INDEX IF NOT EXISTS ack_probe_scope_pending ON vcp_memory_outbox(scope_id,status)
    WHERE status NOT IN('done','stale','cancelled');`);
  const after = plans(f.db, notes[0]!.scopeId);
  expect(select().note_id).toBe(selectedBefore.note_id); expect(selectedBefore.note_id).toBe(notes[48]!.id);
  expect(f.db.prepare(scopeSql).get(notes[0]!.scopeId)).toBeDefined();
  output('memory-index-ack-query-plan-probe.json', { actualSQLite: true, completedPrefix: 48, pending: 16, before, after, sameFirstFifoNote: true });
});

it('preserves exact body, source and history identities while publishing only a legal same-version ACK', () => {
  const f = fixture(), [note] = f.write(1); f.settleExperiences();
  const tables = ['companion_memory_content_revisions', 'companion_memory_version_revisions', 'companion_memory_source_outbox', 'companion_memory_history_outbox'];
  const before = Object.fromEntries(tables.map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const sources = f.db.prepare('SELECT * FROM vcp_note_sources ORDER BY note_id,message_id').all();
  const lifecycle = f.store.request({ type: 'memory.lifecycle.state', companionId: 'alice' }).memoryLifecycleState;
  const lease = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  expect(() => f.store.request({ type: 'memory.outbox.complete', id: lease.id, leaseToken: 'wrong-lease', indexed: true })).toThrow('租约');
  expect(() => f.store.request({ type: 'memory.outbox.complete', id: lease.id, leaseToken: lease.leaseToken, indexed: false })).toThrow('确认');
  f.measure(true);
  const ack = f.store.request({ type: 'memory.outbox.complete', id: lease.id, leaseToken: lease.leaseToken, indexed: true, sourceFile: 'actual-native-note.txt' });
  f.measure(false);
  const indexed = f.store.request({ type: 'memory.read', ...f.scope, id: note!.id }).memoryRead!.memory;
  expect(indexed).toEqual({ ...note!, status: 'indexed', sourceFile: 'actual-native-note.txt', updatedAt: indexed.updatedAt });
  expect(ack.memoryChangedCompanionIds).toBeUndefined(); expect(ack.memorySourceChangedCompanionIds).toBeUndefined();
  expect(f.store.request({ type: 'memory.lifecycle.state', companionId: 'alice' }).memoryLifecycleState).toEqual(lifecycle);
  for (const table of tables) expect(f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before[table]);
  expect(f.db.prepare('SELECT * FROM vcp_note_sources ORDER BY note_id,message_id').all()).toEqual(sources);
  expect([...f.statements.keys()].some(sql => sql.startsWith('DELETE FROM vcp_note_sources'))).toBe(false);
  const experience = f.db.prepare("SELECT entry FROM companion_experiences WHERE json_extract(entry,'$.source.kind')='memory' AND json_extract(entry,'$.source.id')=?").get(note!.id) as { entry: string };
  expect(JSON.parse(experience.entry).status).toBe('completed');
  // A later annotation publication omits sourceFile, which must clear the old
  // transport hint without touching the underlying immutable body identity.
  f.store.request({ type: 'memory.organize', ...f.scope, ids: [note!.id], tags: ['reindexed'] });
  const next = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  f.store.request({ type: 'memory.outbox.complete', id: next.id, leaseToken: next.leaseToken, indexed: true });
  const reindexed = f.store.request({ type: 'memory.read', ...f.scope, id: note!.id }).memoryRead!.memory;
  expect(reindexed).toMatchObject({ status: 'indexed', contentRevision: note!.contentRevision, content: note!.content, tags: ['reindexed'] });
  expect(reindexed).not.toHaveProperty('sourceFile');
});

it.each(['new-version', 'withdrawn-source'] as const)('cannot acknowledge an obsolete native receipt after %s', mutation => {
  const f = fixture(), [note] = f.write(1), lease = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  if (mutation === 'new-version') f.store.request({ type: 'memory.organize', ...f.scope, ids: [note!.id], tags: ['changed'] });
  else f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: note!.sources.map(source => source.messageId) });
  f.store.request({ type: 'memory.outbox.complete', id: lease.id, leaseToken: lease.leaseToken, indexed: true });
  const current = JSON.parse((f.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(note!.id) as { data: string }).data);
  expect(current.status).toBe(mutation === 'new-version' ? 'queued' : 'forgotten');
  expect(current.version).toBeGreaterThan(note!.version);
});

it('does not publish a same-version ACK after its source observer permission is withdrawn', () => {
  const f = fixture(), group = f.store.createConversation('Shared evidence', ['alice', 'bob']);
  const source = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: 'Actual shared evidence whose membership can be revoked.', replyDirective: 'none' });
  const note = f.store.request({ type: 'memory.record', companionId: 'alice', conversationId: group.id,
    candidate: { artifactKind: 'episode_memory' as const, content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const lease = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  expect(lease.noteId).toBe(note.id);
  // Leaving a room does not erase a previously witnessed personal experience.
  // Revoke the actual witness permission, independently of body/version data.
  f.db.prepare('DELETE FROM vcp_source_observers WHERE message_id=? AND companion_id=?').run(source.id, 'alice');
  f.store.request({ type: 'memory.outbox.complete', id: lease.id, leaseToken: lease.leaseToken, indexed: true });
  const current = JSON.parse((f.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(note.id) as { data: string }).data);
  expect(current.status).not.toBe('indexed');
  expect(f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: [source.id] }).memorySources).toEqual([]);
  expect(() => f.store.request({ type: 'memory.read', ...f.scope, id: note.id })).toThrow('失效');
});

it('keeps exhausted, delayed and scope-leased work unresolved without revisiting terminal FIFO history', () => {
  const f = fixture(), notes = f.write(9), first = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  const set = (index: number, status: string, attempts = 0, next = 0) => f.db.prepare('UPDATE vcp_memory_outbox SET status=?,attempts=?,next_attempt=? WHERE note_id=?')
    .run(status, attempts, next, notes[index]!.id);
  set(1, 'done'); set(2, 'stale'); set(3, 'cancelled'); set(4, 'failed', 8); set(5, 'failed', 1, Date.now() + 60000);
  expect(f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox).toBeUndefined(); // the real first lease excludes its scope
  f.store.request({ type: 'memory.outbox.complete', id: first.id, leaseToken: first.leaseToken, indexed: true });
  const state = () => f.db.prepare('SELECT state FROM vcp_memory_scopes WHERE scope_id=?').get(first.scopeId);
  for (const index of [6, 7]) {
    const lease = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    expect(lease.noteId).toBe(notes[index]!.id);
    f.store.request({ type: 'memory.outbox.complete', id: lease.id, leaseToken: lease.leaseToken, indexed: true });
    expect(state()).toEqual({ state: 'dirty' }); // failed-at-limit and future retry are still unsettled
  }
  const last = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  expect(last.noteId).toBe(notes[8]!.id);
  set(4, 'stale'); set(5, 'cancelled');
  f.store.request({ type: 'memory.outbox.complete', id: last.id, leaseToken: last.leaseToken, indexed: true });
  expect(state()).toEqual({ state: 'ready' });
  expect(f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox).toBeUndefined();
});

it('keeps bounded projection retries and synchronous archives with every file outside its SQL batch', () => {
  const f = fixture(), transactionStates: boolean[] = [];
  const experience = new CompanionExperienceStore(f.db, f.root, () => { transactionStates.push(f.db.inTransaction); return true; }, () => []);
  const projectionTransactions: boolean[] = [];
  f.db.function('ack_probe_transaction', { deterministic: false }, () => { projectionTransactions.push(f.db.inTransaction); return 'observed'; });
  f.db.exec(`CREATE TEMP TRIGGER ack_probe_projection_transaction BEFORE INSERT ON companion_experiences BEGIN SELECT ack_probe_transaction(); END;
    CREATE TEMP TRIGGER ack_probe_projection_failure BEFORE INSERT ON companion_experiences WHEN NEW.title='probe-fail' BEGIN SELECT RAISE(ABORT,'intentional projection failure'); END;`);
  for (let index = 0; index < 26; index++) f.db.prepare('INSERT INTO companion_experience_projection(source,source_id,companion_id,payload,observed_at) VALUES(?,?,?,?,?)')
    .run('probe', `probe_${index}`, 'alice', JSON.stringify({ source: 'memory_processing', id: `probe_${index}`, owner: 'alice', status: 'completed',
      data: { title: index === 1 ? 'probe-fail' : 'probe-ok', summary: `actual source ${index}`, createdAt: '2026-10-27T10:00:00Z' } }), '2026-10-27T10:00:00Z');
  experience.flush();
  expect(count(f.db, 'companion_experience_projection')).toBe(3); // failed second + bounded tail of two
  expect(projectionTransactions).not.toHaveLength(0); expect(projectionTransactions.every(Boolean)).toBe(true);
  expect(transactionStates).toHaveLength(8); expect(transactionStates.some(Boolean)).toBe(false);
  expect(f.db.inTransaction).toBe(false);
  expect(f.db.prepare("SELECT attempts,error FROM companion_experience_projection WHERE source='probe' AND source_id='probe_1'").get()).toMatchObject({ attempts: 1, error: 'intentional projection failure' });
  const entry = JSON.parse((f.db.prepare('SELECT entry FROM companion_experiences ORDER BY rowid LIMIT 1').get() as { entry: string }).entry);
  expect(readFileSync(path.join(f.root, entry.archiveRelativePath, 'detail.md'), 'utf8')).toContain('actual source');
  f.db.exec('DROP TRIGGER ack_probe_projection_failure');
  f.db.prepare("UPDATE companion_experience_projection SET next_attempt=0 WHERE source='probe'").run();
  for (let round = 0; round < 5; round++) experience.flush();
  expect(count(f.db, 'companion_experience_projection')).toBe(0);
  expect(count(f.db, 'companion_experience_archive')).toBe(0);
  expect(count(f.db, 'companion_experiences')).toBe(26);
});
