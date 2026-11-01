import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { inspectCompanionFencedMaintenance, openCompanionFencedMaintenance } from '../../src/companions/fenced-maintenance';
import { beginCompanionHostIncidentRepair, companionHostIncidentRepairManifestSchema, completeCompanionHostIncidentRepair,
  hostIncidentRepairSHA as sha, hostIncidentRepairStateSHA, planCompanionHostIncidentRepair } from '../../src/companions/host-incident-repair';
import { CompanionMemoryLedger } from '../../src/companions/memory-ledger';
import { companionRecoveryFencePath } from '../../src/companions/recovery-fence';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { runCompanionHostIncidentRepair } from '../../src/main/companions/host-incident-repair';
import { companionMemorySchema } from '../../src/shared/companion-memory';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionMemory } from '../../src/shared/companions';

const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean }): CompanionConnection };
const roots: string[] = [], handles = new Set<{ close(): void }>();
afterEach(() => { for (const handle of handles) handle.close(); handles.clear(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('wlb-host-incident-test-')) throw new Error('Unsafe incident fixture cleanup.');
  rmSync(root, { recursive: true, force: true });
} });
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wlb-host-incident-test-')); roots.push(root);
  const selection = { libraryId: randomUUID(), libraryPath: root }, data = path.join(root, '.worldlinebox', 'companions'); mkdirSync(data, { recursive: true });
  const catalog = new Database(path.join(root, '.worldlinebox', 'library.db')); catalog.exec('CREATE TABLE library(library_id TEXT PRIMARY KEY)'); catalog.prepare('INSERT INTO library VALUES(?)').run(selection.libraryId); catalog.close();
  const ledgerFile = path.join(data, 'messages.sqlite'), store = new CompanionsStore(ledgerFile, [], { recoveryAuthority: selection }); handles.add(store);
  const owner = store.createCompanion({ name: 'isolated incident fixture', description: '', persona: 'Actual retained source.', avatar: 'custom', model: '', proactive: false });
  const room = store.openPrivate(owner.id), scope = { companionId: owner.id, conversationId: room.id }, owners = path.join(root, '伙伴记忆'); mkdirSync(path.join(owners, owner.id), { recursive: true });
  const request = async (command: CompanionStorageCommand) => store.request(command);
  const registry = new CompanionArtifactRegistry(path.join(owners, owner.id), owner.id, { registryStorage: { request } });
  const library = new CompanionMemoryLibrary({ libraryDirectory: owners, artifacts: async () => registry, request });
  const sources = new CompanionMemorySourceFiles({ library }), history = new CompanionMemoryHistoryFiles({ library });
  const source = store.appendMessage({ conversationId: room.id, authorId: owner.id, content: 'An actual formally stored source.', replyDirective: 'none' });
  const note = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory', content: 'An actual formally stored source.', tags: [],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  while ((await sources.flush(owner.id)).pending) { /* real canonical evidence */ }
  while ((await history.flush(owner.id)).pending) { /* real immutable history/current */ }
  const old = await history.read(scope, note.id, note.contentRevision!);
  store.request({ type: 'execution.invalidate', kind: 'message', id: source.id, companionId: owner.id });
  await registry.revoke('memory:' + note.id); await registry.purgeRevokedBody('memory:' + note.id);
  await library.close(); store.close(); handles.delete(store);
  const inspection = inspectCompanionFencedMaintenance(selection), db = inspection.db;
  const noteRow = db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(note.id) as { data: string }, prior = companionMemorySchema.parse(JSON.parse(noteRow.data));
  const annotations = db.prepare('SELECT annotations FROM companion_memory_version_revisions WHERE note_id=? AND version=?').get(note.id, prior.version - 1) as { annotations: string };
  const parsed = JSON.parse(annotations.annotations) as { tags: string[]; diaryName?: string; autoTags?: boolean }, repairAt = '2026-10-31T10:00:00.000Z';
  const repaired: CompanionMemory = { ...old, tags: parsed.tags, status: 'queued', version: prior.version + 1, contentRevision: old.contentRevision,
    annotationRevision: prior.annotationRevision! + 1, semanticRevision: prior.semanticRevision! + 1, updatedAt: repairAt };
  if (parsed.diaryName !== undefined) repaired.diaryName = parsed.diaryName; else delete repaired.diaryName;
  if (parsed.autoTags !== undefined) repaired.metadata = { ...repaired.metadata, autoTags: parsed.autoTags };
  const artifact = db.prepare('SELECT * FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get(owner.id, 'memory:' + note.id) as { relative_path: string; revision: number; content_hash: string; metadata: string };
  const original = db.prepare('SELECT metadata FROM companion_artifact_versions WHERE owner_id=? AND artifact_id=? AND revision=?').get(owner.id, 'memory:' + note.id, artifact.revision) as { metadata: string };
  const descriptor = db.prepare('SELECT document_hash FROM companion_memory_history_files WHERE note_id=? AND content_revision=?').get(note.id, old.contentRevision) as { document_hash: string };
  const marker = db.prepare('SELECT value FROM metadata WHERE key=?').get('execution-source-invalid/message/' + source.id) as { value: string };
  const files = (db.prepare("SELECT owner_id,relative_path FROM companion_artifacts WHERE state='committed'").all() as Array<{ owner_id: string; relative_path: string }>).map(item => {
    const bytes = readFileSync(path.join(owners, item.owner_id, ...item.relative_path.split('/'))); return { owner: item.owner_id, relativePath: item.relative_path, sha256: sha(bytes), size: bytes.length };
  });
  const receipt = Buffer.from(JSON.stringify({ schema: 'incident-recovery-hypothesis-validation-v1', eligibleMessageCount: 1,
    checks: [{ kind: 'message', id: source.id, valid: true }], results: [{ id: source.id, readable: true, failedProofHashes: [] }],
    originalTombstones: [{ key: 'execution-source-invalid/message/' + source.id, value: marker.value, valueSha256: sha(marker.value) }],
    newMarkers: [], modelOrNetworkCalls: 0, currentAssetsFullStrictLoadAndFinal: true, fullCanonicalGate: true, publishedCertificateSkip: false, originalLibraryWrites: 0 }));
  const manifest = companionHostIncidentRepairManifestSchema.parse({ schema: 'worldlinebox.host-shutdown-withdrawal-repair-v1', operationId: randomUUID(), libraryId: selection.libraryId,
    initialHead: inspection.head, repairAt, beforeStateSHA: hostIncidentRepairStateSHA(db), tombstones: [{ kind: 'message', id: source.id, valueSHA: sha(marker.value) }],
    notes: [{ id: note.id, owner: owner.id, beforeSHA: sha(noteRow.data), historyRevision: old.contentRevision, historyDocumentSHA: descriptor.document_hash,
      annotationsSHA: sha(annotations.annotations), afterSHA: sha(JSON.stringify(repaired)), registryBeforeSHA: sha(JSON.stringify(artifact)), registryPublishedSHA: sha(original.metadata) }],
    archives: [], consolidations: [], canonicalFiles: files, validation: { beforeRepairReceiptSHA: sha(receipt), afterRepairReceiptSHA: sha(receipt), sourceSnapshotSHA: sha('actual isolated fixture'), fullMainGate: 'sql+canonical+current-role+action-authority+final', noCertificateShortcut: true } });
  inspection.close();
  return { root, selection, owners, ledgerFile, manifest, receipt, note, prior, repaired, artifact, source,
    read: (sql: string, ...args: unknown[]) => { const db = new Database(ledgerFile, { readonly: true }); try { return db.prepare(sql).all(...args); } finally { db.close(); } },
    run: (mode?: 'plan' | 'apply', approvedManifestSHA?: string) => runCompanionHostIncidentRepair(selection, manifest, { mode, approvedManifestSHA, validationBefore: receipt, validationAfter: receipt }) };
}

it('defaults to readonly plan, then performs exact fenced phases without replaying messages, rewards or retired aliases', async () => {
  const f = await fixture(), before = sha(readFileSync(f.ledgerFile)), plan = f.run();
  expect(plan.state).toBe('planned'); expect(sha(readFileSync(f.ledgerFile))).toBe(before); expect(existsSync(path.join(f.root, '.worldlinebox', 'companions', 'host-incident-repair'))).toBe(false);
  expect(() => f.run('apply', 'a'.repeat(64))).toThrow('批准');
  const completed = f.run('apply', plan.manifestSHA); expect(completed.head.generation).toBe(plan.head.generation + 2);
  expect(f.read('SELECT content FROM messages WHERE id=?', f.source.id)).toEqual([{ content: f.source.content }]);
  expect(f.read('SELECT content_revision FROM companion_memory_version_revisions WHERE note_id=? AND version=?', f.note.id, f.prior.version)).toEqual([{ content_revision: f.prior.contentRevision }]);
  expect(f.read('SELECT content_revision FROM companion_memory_version_revisions WHERE note_id=? AND version=?', f.note.id, f.repaired.version)).toEqual([{ content_revision: 1 }]);
  expect(f.read('SELECT data FROM vcp_memory_notes WHERE id=?', f.note.id)).toEqual([{ data: JSON.stringify(f.repaired) }]);
  expect(f.read("SELECT operation,note_version,status FROM vcp_memory_outbox WHERE note_id=? AND note_version=?", f.note.id, f.repaired.version)).toEqual([{ operation: 'remember', note_version: f.repaired.version, status: 'pending' }]);
  expect(f.run('apply', plan.manifestSHA).head).toEqual(completed.head);
});

it('rejects a wrong library, exact row drift, unapproved plan or changed canonical bytes without clearing any marker', async () => {
  const f = await fixture();
  expect(() => planCompanionHostIncidentRepair({ ...f.selection, libraryId: randomUUID() }, f.manifest, f.owners)).toThrow('身份');
  const changed = structuredClone(f.manifest); changed.notes[0]!.beforeSHA = 'a'.repeat(64);
  expect(() => planCompanionHostIncidentRepair(f.selection, changed, f.owners)).toThrow('CAS');
  const file = f.manifest.canonicalFiles[0]!; writeFileSync(path.join(f.owners, file.owner, ...file.relativePath.split('/')), 'external same-purpose content');
  expect(() => f.run()).toThrow('文件'); expect(f.read("SELECT value FROM metadata WHERE key=?", 'execution-source-invalid/message/' + f.source.id)).toHaveLength(1);
});

it('resumes a prepared operation with exact installed bytes, and rejects domain drift after preparation', async () => {
  const f = await fixture(), plan = f.run();
  const head = beginCompanionHostIncidentRepair(f.selection, f.manifest, f.owners, plan.manifestSHA);
  expect(head.generation).toBe(plan.head.generation + 1);
  expect(planCompanionHostIncidentRepair(f.selection, f.manifest, f.owners).state).toBe('prepared');
  // A crash after installation leaves a revoked artifact and no visible note.
  writeFileSync(path.join(f.owners, f.note.companionId, ...f.artifact.relative_path.split('/')), f.note.content);
  expect(f.read("SELECT state FROM companion_artifacts WHERE artifact_id=?", 'memory:' + f.note.id)).toEqual([{ state: 'revoked' }]);
  expect(completeCompanionHostIncidentRepair(f.selection, f.manifest, f.owners, plan.manifestSHA).generation).toBe(head.generation + 1);
  const g = await fixture(), next = g.run(); beginCompanionHostIncidentRepair(g.selection, g.manifest, g.owners, next.manifestSHA);
  const maintenance = openCompanionFencedMaintenance(g.selection, { ...g.manifest.initialHead, generation: g.manifest.initialHead.generation + 1 });
  maintenance.mutate(db => db.prepare("INSERT INTO metadata(key,value) VALUES('unrelated-later-write','must-not-be-rolled-back')").run()); maintenance.close();
  expect(() => g.run('apply', next.manifestSHA)).toThrow('水位');
  expect(g.read("SELECT value FROM metadata WHERE key='unrelated-later-write'")).toEqual([{ value: 'must-not-be-rolled-back' }]);
});

it('keeps an actual intervening forget or SQL permission change authoritative and rolls the repair back', async () => {
  const f = await fixture(), plan = f.run(); beginCompanionHostIncidentRepair(f.selection, f.manifest, f.owners, plan.manifestSHA);
  writeFileSync(path.join(f.owners, f.note.companionId, ...f.artifact.relative_path.split('/')), f.note.content);
  const writer = new Database(f.ledgerFile); writer.prepare('DELETE FROM conversation_members WHERE conversation_id=?').run(f.source.conversationId); writer.close();
  expect(() => completeCompanionHostIncidentRepair(f.selection, f.manifest, f.owners, plan.manifestSHA)).toThrow('领域状态');
  expect(f.read("SELECT state FROM companion_artifacts WHERE artifact_id=?", 'memory:' + f.note.id)).toEqual([{ state: 'revoked' }]);
  expect(f.read('SELECT data FROM vcp_memory_notes WHERE id=?', f.note.id)).not.toEqual([{ data: JSON.stringify(f.repaired) }]);
  const db = new Database(f.ledgerFile, { readonly: true }); expect(new CompanionMemoryLedger(db).versionRevision(f.note.id, f.prior.version)).toBe(f.prior.contentRevision); db.close();
});

it('rolls back every repair row if the actual final SQL source gate rejects after provisional Registry publication', async () => {
  const f = await fixture(), writer = new Database(f.ledgerFile);
  writer.exec(`CREATE TRIGGER incident_test_actual_withdraw AFTER UPDATE OF state ON companion_artifacts WHEN NEW.state='committed'
    BEGIN INSERT OR IGNORE INTO vcp_source_blocks(message_id,companion_id,created_at) SELECT id,author_id,created_at FROM messages; END`);
  f.manifest.beforeStateSHA = hostIncidentRepairStateSHA(writer); writer.close();
  const plan = f.run();
  expect(() => f.run('apply', plan.manifestSHA)).toThrow('SQL');
  expect(f.read('SELECT data FROM vcp_memory_notes WHERE id=?', f.note.id)).not.toEqual([{ data: JSON.stringify(f.repaired) }]);
  expect(f.read("SELECT state FROM companion_artifacts WHERE artifact_id=?", 'memory:' + f.note.id)).toEqual([{ state: 'revoked' }]);
  expect(f.read('SELECT * FROM vcp_source_blocks')).toHaveLength(0);
  expect(f.read('SELECT content_revision FROM companion_memory_version_revisions WHERE note_id=? AND version=?', f.note.id, f.repaired.version)).toHaveLength(0);
});

it.each(['prepared', 'completed'] as const)('reconciles an unknown %s finish only through the same approved receipt, without rerunning the repair', async phase => {
  const f = await fixture(), plan = f.run(), authority = new Database(companionRecoveryFencePath(f.selection));
  authority.exec(`CREATE TRIGGER incident_test_finish_failure BEFORE UPDATE OF pending ON recovery_authority
    WHEN OLD.pending=1 AND NEW.pending=0 AND OLD.generation=${plan.head.generation + (phase === 'prepared' ? 1 : 2)} BEGIN SELECT RAISE(ABORT,'injected durable finish failure'); END`);
  expect(() => f.run('apply', plan.manifestSHA)).toThrow('durable finish failure');
  expect(() => f.run()).toThrow('未结');
  authority.exec('DROP TRIGGER incident_test_finish_failure'); authority.close();
  const repaired = f.run('apply', plan.manifestSHA), again = f.run('apply', plan.manifestSHA);
  expect(repaired.head.generation).toBe(plan.head.generation + 2); expect(again.head).toEqual(repaired.head);
  expect(f.read('SELECT note_version FROM vcp_memory_outbox WHERE note_id=? AND note_version=?', f.note.id, f.repaired.version)).toHaveLength(1);
});

it('finishes only its exact atomic two-link crash pair before applying the SQL restoration', async () => {
  const f = await fixture(), plan = f.run(); beginCompanionHostIncidentRepair(f.selection, f.manifest, f.owners, plan.manifestSHA);
  const target = path.join(f.owners, f.note.companionId, ...f.artifact.relative_path.split('/'));
  const stages = path.join(f.root, '.worldlinebox', 'companions', 'host-incident-repair', f.manifest.operationId, 'atomic-install'); mkdirSync(stages, { recursive: true });
  const staged = path.join(stages, sha(target) + '.body'); writeFileSync(staged, f.note.content); linkSync(staged, target);
  expect(lstatSync(target).nlink).toBe(2); expect(f.run('apply', plan.manifestSHA).state).toBe('completed');
  expect(lstatSync(target).nlink).toBe(1); expect(existsSync(staged)).toBe(false);
});
