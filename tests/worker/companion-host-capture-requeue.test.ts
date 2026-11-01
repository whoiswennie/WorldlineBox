import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { inspectCompanionFencedMaintenance, openCompanionFencedMaintenance } from '../../src/companions/fenced-maintenance';
import { companionRecoveryFencePath, CompanionRecoveryFence } from '../../src/companions/recovery-fence';
import { bindCompanionMemoryPolicyRoot, resolveCompanionMemoryPolicy, CompanionMemoryPolicyFiles } from '../../src/companions/memory-policy-files';
import { COMPANION_MEMORY_POLICY_FILE } from '../../src/shared/companion-memory-policy';
import { applyCompanionHostCaptureRequeue, planCompanionHostCaptureRequeue, companionHostCaptureRequeueManifestSchema,
  companionHostCaptureRequeueManifestSHA, companionHostCaptureRequeueRowSHA } from '../../src/companions/host-capture-requeue';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';

const Database = BetterSqlite3 as { new(filename: string, options?: { readonly?: boolean }): CompanionConnection };
type Row = Record<string, string | number | null>;
const roots: string[] = [], handles = new Set<{ close(): void }>();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const incidentAt = '2026-11-01T10:00:00.000Z';
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const handle of handles) handle.close(); handles.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-capture-requeue-')) throw new Error('Unsafe fixture cleanup.');
    rmSync(root, { recursive: true, force: true });
  }
});
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(incidentAt);
  const libraryPath = mkdtempSync(path.join(tmpdir(), 'wlb-capture-requeue-')); roots.push(libraryPath);
  const selection = { libraryPath, libraryId: randomUUID() }, data = path.join(libraryPath, '.worldlinebox', 'companions'); mkdirSync(data, { recursive: true });
  const catalog = new Database(path.join(libraryPath, '.worldlinebox', 'library.db'));
  catalog.exec('CREATE TABLE library(library_id TEXT PRIMARY KEY)'); catalog.prepare('INSERT INTO library VALUES(?)').run(selection.libraryId); catalog.close();
  const filename = path.join(data, 'messages.sqlite'), store = new CompanionsStore(filename, [{ id: 'alice', name: 'Alice', persona: '实际角色来源。', description: '',
    avatar: 'sister', active: true, proactive: false, model: '' }], { recoveryAuthority: selection }); handles.add(store);
  const owner = store.state().companions.find(value => value.id === 'alice')!, conversationId = store.openPrivate(owner.id).id;
  const profiles = new CompanionAssetProfileStore(path.join(libraryPath, '伙伴记忆'), { registryStorage: { request: async (command: CompanionStorageCommand) => store.request(command) } });
  await profiles.bootstrap(owner);
  const source = store.appendMessage({ conversationId, authorId: 'user', content: '一项仍然有效的实际事件。', replyDirective: 'none' });
  const executionReadset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true,
    companionId: owner.id, conversationId, beforeSequence: source.sequence, sources: [{ id: source.id, conversationId, checksum: sha(source.content) }],
    memories: [], knowledgeReads: [], contexts: [], topics: [] };
  const reply = store.appendMessage({ conversationId, authorId: owner.id, content: '依据该事件形成的实际发言。', executionReadset, replyDirective: 'none' });
  const job = store.request({ type: 'memory.jobs.claim', companionId: owner.id, force: true }).memoryJob!;
  expect(new Set(job.sourceMessageIds)).toEqual(new Set([source.id, reply.id]));
  store.request({ type: 'memory.jobs.fail', id: job.id, leaseToken: job.leaseToken, error: '伙伴存储请求 cognition.registry.read 排队超过 30 秒，尚未派发、未执行。', failureKind: 'cancelled', retryAfterMs: 300000 });
  store.close(); handles.delete(store);
  const inspection = inspectCompanionFencedMaintenance(selection); handles.add(inspection);
  const policyDb = inspection.db; bindCompanionMemoryPolicyRoot(policyDb, path.join(libraryPath, '伙伴记忆'));
  const cancelled = policyDb.prepare("SELECT * FROM vcp_capture_jobs WHERE status='cancelled' ORDER BY ordinal").all() as Row[];
  expect(cancelled).toHaveLength(2);
  expect(new Set(cancelled.map(row => row.updated_at)).size).toBe(1);
  const manifest = companionHostCaptureRequeueManifestSchema.parse({ schema: 'worldlinebox.host-capture-unavailable-requeue-v1', operationId: randomUUID(),
    libraryId: selection.libraryId, initialHead: inspection.head, incidentAt: cancelled[0]!.updated_at, evidenceSHA: sha('isolated, reviewed host not-dispatched incident'), jobs: cancelled.map(row => {
      const message = policyDb.prepare('SELECT author_id FROM messages WHERE id=?').get(row.message_id) as { author_id: string };
      return { id: row.id, owner: row.companion_id, conversationId: row.conversation_id, sourceMessageId: row.message_id, sourceAuthorId: message.author_id,
        sourceSequence: row.source_sequence, throughSequence: row.through_sequence, sourceRevision: row.source_revision, sourceChecksum: row.source_checksum,
        beforeRowSHA: companionHostCaptureRequeueRowSHA(row), attempts: row.attempts, dispositionRevision: row.disposition_revision,
        policyRevision: resolveCompanionMemoryPolicy(policyDb, owner.id).revision };
    }) });
  inspection.close(); handles.delete(inspection);
  const read = <T = Row>(sql: string, ...args: unknown[]) => { const db = new Database(filename, { readonly: true }); try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); } };
  const mutate = (operation: (db: CompanionConnection) => void) => { const db = new Database(filename); try {
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    operation(db);
  } finally { db.close(); } };
  const rows = () => read('SELECT * FROM vcp_capture_jobs ORDER BY ordinal');
  const protectedRows = () => {
    const db = new Database(filename, { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN('vcp_capture_jobs','metadata','companion_recovery_state','companion_task_observations','companion_task_counts','sqlite_sequence') ORDER BY name").all() as Array<{ name: string }>;
      return tables.map(({ name }) => ({ name, rows: db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all() }));
    } finally { db.close(); }
  };
  return { selection, filename, manifest, before: cancelled, source, reply, read, mutate, rows, protectedRows,
    plan: (input: unknown = manifest) => planCompanionHostCaptureRequeue(selection, input),
    apply: (input: unknown = manifest) => applyCompanionHostCaptureRequeue(selection, input, companionHostCaptureRequeueManifestSHA(input)) };
}

it('plans with no initialization or writes, atomically requeues only two exact flags, and reenters without another generation', async () => {
  const f = await fixture(), beforeProtected = f.protectedRows(), beforeMetadata = f.read('SELECT * FROM metadata ORDER BY key');
  const beforeObservations = f.read('SELECT * FROM companion_task_observations ORDER BY sequence'), beforeSequences = f.read('SELECT * FROM sqlite_sequence ORDER BY name');
  const beforeTaskCounts = f.read('SELECT * FROM companion_task_counts ORDER BY kind,companion_id');
  const beforeSchema = f.read('SELECT name,sql FROM sqlite_master ORDER BY name'), ledgerSHA = sha(readFileSync(f.filename));
  const authoritySHA = sha(readFileSync(companionRecoveryFencePath(f.selection)));
  expect(f.plan()).toMatchObject({ state: 'planned', head: f.manifest.initialHead, jobs: 2, modelRequests: 0 });
  expect(sha(readFileSync(f.filename))).toBe(ledgerSHA); expect(sha(readFileSync(companionRecoveryFencePath(f.selection)))).toBe(authoritySHA);
  const applied = f.apply(); expect(applied.head.generation).toBe(f.manifest.initialHead.generation + 1);
  expect(f.rows()).toEqual(f.before.map(row => ({ ...row, status: 'pending', admission_deferred: 1, disposition_revision: Number(row.disposition_revision) + 1 })));
  expect(f.protectedRows()).toEqual(beforeProtected); expect(f.read('SELECT name,sql FROM sqlite_master ORDER BY name')).toEqual(beforeSchema);
  const observations = f.read('SELECT * FROM companion_task_observations ORDER BY sequence');
  expect(observations.slice(0, beforeObservations.length)).toEqual(beforeObservations);
  expect(observations.slice(beforeObservations.length).map(row => ({ task_id: row.task_id, companion_id: row.companion_id, kind: row.kind, phase: row.phase })))
    .toEqual(f.manifest.jobs.map(job => ({ task_id: job.id, companion_id: job.owner, kind: 'memory_capture', phase: 'pending' })));
  expect(f.read('SELECT * FROM sqlite_sequence ORDER BY name')).toEqual(beforeSequences.map(row => row.name === 'companion_task_observations' ? { ...row, seq: Number(row.seq) + 2 } : row));
  expect(f.read('SELECT * FROM companion_task_counts ORDER BY kind,companion_id')).toEqual(beforeTaskCounts.map(row => row.kind === 'memory_capture'
    ? { ...row, live: Number(row.live) + f.manifest.jobs.filter(job => job.owner === row.companion_id).length } : row));
  expect(f.read('SELECT * FROM metadata ORDER BY key')).toEqual(expect.arrayContaining(beforeMetadata));
  expect(f.read('SELECT * FROM metadata')).toHaveLength(beforeMetadata.length + 1);
  expect(f.apply()).toEqual(applied); expect(f.plan()).toEqual(applied); expect(f.rows()).toEqual(f.before.map(row => ({ ...row, status: 'pending', admission_deferred: 1, disposition_revision: Number(row.disposition_revision) + 1 })));
});

it.each(['source-checksum', 'forgotten', 'membership', 'reset', 'proposal', 'lease', 'completed-output'] as const)('refuses fresh %s drift without changing either cancelled job', async mode => {
  const f = await fixture(); expect(f.plan().state).toBe('planned');
  f.mutate(db => {
    if (mode === 'source-checksum') db.prepare('UPDATE messages SET content=? WHERE id=?').run('外部改写的新正文。', f.source.id);
    if (mode === 'forgotten') db.prepare('INSERT INTO vcp_source_blocks(message_id,companion_id,created_at) VALUES(?,?,?)').run(f.source.id, 'alice', incidentAt);
    if (mode === 'membership') db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(f.source.conversationId, 'alice');
    if (mode === 'reset') db.prepare('INSERT OR REPLACE INTO companion_reset_boundaries(companion_id,through_sequence) VALUES(?,?)').run('alice', f.reply.sequence);
    if (mode === 'proposal') db.prepare('INSERT INTO companion_capture_proposals(job_id,companion_id,data) VALUES(?,?,?)').run(f.manifest.jobs[0]!.id, 'alice', '{}');
    if (mode === 'lease') db.prepare('UPDATE vcp_capture_jobs SET lease_token=? WHERE id=?').run('an_unsettled_lease', f.manifest.jobs[0]!.id);
    if (mode === 'completed-output') db.prepare('UPDATE vcp_capture_jobs SET output_note_versions=? WHERE id=?').run('[]', f.manifest.jobs[0]!.id);
  });
  const before = f.rows(); expect(() => f.plan()).toThrow(); expect(() => f.apply()).toThrow(); expect(f.rows()).toEqual(before);
  expect(f.read("SELECT * FROM metadata WHERE key LIKE 'host-capture-unavailable-requeue/%'")).toHaveLength(0);
});

it('rolls both updates and the receipt back when an actual late withdrawal occurs inside the first provisional update', async () => {
  const f = await fixture();
  f.mutate(db => db.exec(`CREATE TRIGGER capture_requeue_late_forget AFTER UPDATE OF status ON vcp_capture_jobs WHEN NEW.status='pending'
    BEGIN INSERT OR IGNORE INTO vcp_source_blocks(message_id,companion_id,created_at) VALUES(NEW.message_id,NEW.companion_id,'${incidentAt}'); END`));
  expect(() => f.apply()).toThrow(); expect(f.rows()).toEqual(f.before);
  expect(f.read('SELECT * FROM vcp_source_blocks')).toHaveLength(0);
  expect(f.read("SELECT * FROM metadata WHERE key LIKE 'host-capture-unavailable-requeue/%'")).toHaveLength(0);
  const inspection = inspectCompanionFencedMaintenance(f.selection); try { expect(inspection.head).toEqual(f.manifest.initialHead); } finally { inspection.close(); }
});

it('rejects wrong selection, approval, exact row CAS and strict manifest fields before changing work', async () => {
  const f = await fixture();
  expect(() => planCompanionHostCaptureRequeue({ ...f.selection, libraryId: randomUUID() }, f.manifest)).toThrow();
  expect(() => applyCompanionHostCaptureRequeue(f.selection, f.manifest, '0'.repeat(64))).toThrow();
  expect(() => f.plan({ ...f.manifest, table: 'vcp_capture_jobs' })).toThrow();
  const drift = { ...f.manifest, jobs: f.manifest.jobs.map((job, index) => index ? job : { ...job, beforeRowSHA: '0'.repeat(64) }) };
  expect(() => f.apply(drift)).toThrow(); expect(f.rows()).toEqual(f.before);
});

it('settles a committed fence interruption from its exact receipt and never performs the updates twice', async () => {
  const f = await fixture();
  const finish = vi.spyOn(CompanionRecoveryFence.prototype, 'finish').mockImplementationOnce(() => { throw new Error('Injected finish acknowledgement loss.'); });
  expect(() => f.apply()).toThrow('finish acknowledgement loss'); finish.mockRestore();
  expect(f.read("SELECT * FROM metadata WHERE key LIKE 'host-capture-unavailable-requeue/%'")).toHaveLength(1);
  expect(() => f.plan()).toThrow('未结');
  expect(f.apply()).toMatchObject({ state: 'completed', head: { generation: f.manifest.initialHead.generation + 1 } });
  expect(f.rows()).toEqual(f.before.map(row => ({ ...row, status: 'pending', admission_deferred: 1, disposition_revision: Number(row.disposition_revision) + 1 })));
});

it('rolls the first update back when the second exact job CAS changes inside the transaction', async () => {
  const f = await fixture(); expect(f.plan().state).toBe('planned');
  const [first, second] = f.manifest.jobs;
  f.mutate(db => db.exec(`CREATE TRIGGER capture_requeue_second_cas AFTER UPDATE OF status ON vcp_capture_jobs
    WHEN NEW.id='${first!.id}' AND NEW.status='pending' BEGIN UPDATE vcp_capture_jobs SET disposition_revision=disposition_revision+1 WHERE id='${second!.id}'; END`));
  expect(() => f.apply()).toThrow('更新 CAS'); expect(f.rows()).toEqual(f.before);
  expect(f.read("SELECT * FROM metadata WHERE key LIKE 'host-capture-unavailable-requeue/%'")).toHaveLength(0);
});

it('checks the actual policy file again after provisional updates and rolls both jobs back on a late change', async () => {
  const f = await fixture(), nativeRead = CompanionMemoryPolicyFiles.prototype.read; let reads = 0;
  const read = vi.spyOn(CompanionMemoryPolicyFiles.prototype, 'read').mockImplementation(function (this: CompanionMemoryPolicyFiles, owner: string) {
    if (++reads === 3) {
      const filename = path.join(f.selection.libraryPath, '伙伴记忆', owner, COMPANION_MEMORY_POLICY_FILE);
      const policy = JSON.parse(readFileSync(filename, 'utf8')); policy.policy.capture.quietMs += 1;
      writeFileSync(filename, JSON.stringify(policy));
    }
    return nativeRead.call(this, owner);
  });
  expect(() => f.apply()).toThrow('记忆策略'); expect(read).toHaveBeenCalledTimes(3); expect(f.rows()).toEqual(f.before);
  expect(f.read("SELECT * FROM metadata WHERE key LIKE 'host-capture-unavailable-requeue/%'")).toHaveLength(0);
});

it('refuses a newer real host generation after plan and never reverts work that advanced after a completed repair', async () => {
  const f = await fixture(); expect(f.plan().state).toBe('planned');
  const newer = openCompanionFencedMaintenance(f.selection, f.manifest.initialHead);
  newer.mutate(db => db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('independent-host-work', 'keep')); newer.close();
  expect(() => f.apply()).toThrow('水位'); expect(f.rows()).toEqual(f.before);
  const g = await fixture(), complete = g.apply(), progressing = openCompanionFencedMaintenance(g.selection, complete.head);
  progressing.mutate(db => db.prepare("UPDATE vcp_capture_jobs SET status='running',lease_token='new-real-lease' WHERE id=?").run(g.manifest.jobs[0]!.id)); progressing.close();
  const progress = g.rows(); expect(() => g.apply()).toThrow('水位'); expect(g.rows()).toEqual(progress);
});
