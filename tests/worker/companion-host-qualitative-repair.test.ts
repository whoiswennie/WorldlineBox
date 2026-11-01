import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { inspectCompanionFencedMaintenance } from '../../src/companions/fenced-maintenance';
import { companionRecoveryFencePath } from '../../src/companions/recovery-fence';
import { companionHostIncidentRepairManifestSchema, hostIncidentRepairSHA as sha, hostIncidentRepairStateSHA } from '../../src/companions/host-incident-repair';
import { companionHostQualitativeRepairManifestSchema } from '../../src/companions/host-incident-qualitative-repair';
import { runCompanionHostIncidentRepair, runCompanionHostQualitativeRepair } from '../../src/main/companions/host-incident-repair';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { companionMemorySchema } from '../../src/shared/companion-memory';
import type { CompanionMemory } from '../../src/shared/companions';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean }): CompanionConnection };
const roots: string[] = [], handles = new Set<{ close(): void }>();
afterEach(() => { for (const handle of handles) handle.close(); handles.clear(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('wlb-qualitative-incident-')) throw new Error('Unsafe qualitative fixture cleanup.'); rmSync(root, { recursive: true, force: true });
} });
async function fixture(options: { replacement?: boolean; lateForget?: boolean; expired?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'wlb-qualitative-incident-')); roots.push(root);
  const selection = { libraryPath: root, libraryId: randomUUID() }, dataRoot = path.join(root, '.worldlinebox', 'companions'); mkdirSync(dataRoot, { recursive: true });
  const catalog = new Database(path.join(root, '.worldlinebox', 'library.db')); catalog.exec('CREATE TABLE library(library_id TEXT PRIMARY KEY)'); catalog.prepare('INSERT INTO library VALUES(?)').run(selection.libraryId); catalog.close();
  const ledger = path.join(dataRoot, 'messages.sqlite'), store = new CompanionsStore(ledger, [{ id: 'alice', name: 'qualitative source fixture', description: '', persona: 'An actual owner.', avatar: 'sister', model: '', proactive: false, active: true }], { recoveryAuthority: selection }); handles.add(store);
  const owner = store.state().companions.find(item => item.id === 'alice')!;
  const scope = { companionId: owner.id, conversationId: store.openPrivate(owner.id).id }, owners = path.join(root, '伙伴记忆'); mkdirSync(path.join(owners, owner.id), { recursive: true });
  const request = async (command: CompanionStorageCommand) => store.request(command), registry = new CompanionArtifactRegistry(path.join(owners, owner.id), owner.id, { registryStorage: { request } });
  const library = new CompanionMemoryLibrary({ libraryDirectory: owners, request, artifacts: async () => registry }), sourceFiles = new CompanionMemorySourceFiles({ library }), history = new CompanionMemoryHistoryFiles({ library });
  const sources: string[] = [], notes: CompanionMemory[] = [], oldNotes = new Map<string, CompanionMemory>(); let firstRelationship: string | undefined;
  for (let index = 0; index < 7; ++index) {
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: owner.id, content: `Actual stated observation ${index}.` }); sources.push(source.id);
    const runtime = store.request({ type: 'state.get', ...scope }).runtimeState!, job = store.request({ type: 'memory.jobs.claim', companionId: owner.id, force: true }).memoryJob!;
    const relation = index < 2 || options.replacement && index === 6 ? [{ targetId: 'user', topic: index === 1 ? 'second matter' : 'first matter', context: 'isolated formal exchange', kind: 'expectation' as const,
      statement: source.content, reassessWhen: ['After the next actual exchange.'], replacesRecordIds: index === 6 ? [firstRelationship!] : [] }] : [];
    const saved = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, expectedStateRevision: runtime.revision,
      notes: [{ artifactKind: 'episode_memory', content: source.content, tags: [], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] }],
      stateProposal: { focus: `Actual focus ${index}`, reason: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }],
        experience: { situation: source.content, reassessWhen: ['After the next actual exchange.'], ...(options.expired && index === 6 ? { validUntil: '2000-01-01T00:00:00.000Z' } : {}) }, relationshipUpdates: relation } }).memories![0]!;
    notes.push(saved);
    if (index === 0) firstRelationship = store.request({ type: 'state.get', ...scope }).runtimeState!.relationshipRecords[0]!.id;
  }
  while ((await sourceFiles.flush(owner.id)).pending) { /* actual source files */ }
  while ((await history.flush(owner.id)).pending) { /* actual immutable history */ }
  for (const note of notes) oldNotes.set(note.id, await history.read(scope, note.id, note.contentRevision!));
  const setup = new Database(ledger);
  if (options.lateForget) setup.exec(`CREATE TRIGGER qualitative_test_late_forget AFTER UPDATE OF active ON companion_current_experiences WHEN NEW.active=1
    BEGIN INSERT OR IGNORE INTO vcp_source_blocks(message_id,companion_id,created_at) SELECT id,author_id,created_at FROM messages; END`);
  setup.close();
  const incidentFrom = new Date().toISOString();
  for (const id of sources) store.request({ type: 'execution.invalidate', kind: 'message', id, companionId: owner.id });
  for (const note of notes) { await registry.revoke('memory:' + note.id); await registry.purgeRevokedBody('memory:' + note.id); }
  const incidentUntil = new Date().toISOString(); await library.close(); store.close(); handles.delete(store);
  const inspection = inspectCompanionFencedMaintenance(selection), db = inspection.db, repairAt = new Date().toISOString();
  const noteEntries = notes.map(note => {
    const old = oldNotes.get(note.id)!, raw = (db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(note.id) as { data: string }).data, prior = companionMemorySchema.parse(JSON.parse(raw));
    const annotation = db.prepare('SELECT annotations FROM companion_memory_version_revisions WHERE note_id=? AND version=?').get(note.id, prior.version - 1) as { annotations: string }, a = JSON.parse(annotation.annotations) as { tags: string[]; autoTags?: boolean };
    const restored = { ...old, tags: a.tags, status: 'queued', version: prior.version + 1, contentRevision: old.contentRevision, annotationRevision: prior.annotationRevision! + 1, semanticRevision: prior.semanticRevision! + 1,
      updatedAt: repairAt, metadata: { ...old.metadata, autoTags: a.autoTags } };
    const artifact = db.prepare('SELECT * FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get(owner.id, 'memory:' + note.id) as { revision: number };
    const original = db.prepare('SELECT metadata FROM companion_artifact_versions WHERE owner_id=? AND artifact_id=? AND revision=?').get(owner.id, 'memory:' + note.id, artifact.revision) as { metadata: string };
    const descriptor = db.prepare('SELECT document_hash FROM companion_memory_history_files WHERE note_id=? AND content_revision=?').get(note.id, old.contentRevision) as { document_hash: string };
    return { id: note.id, owner: owner.id, beforeSHA: sha(raw), historyRevision: old.contentRevision, historyDocumentSHA: descriptor.document_hash, annotationsSHA: sha(annotation.annotations), afterSHA: sha(JSON.stringify(restored)), registryBeforeSHA: sha(JSON.stringify(artifact)), registryPublishedSHA: sha(original.metadata) };
  });
  const markers = sources.map(id => ({ key: 'execution-source-invalid/message/' + id, value: (db.prepare('SELECT value FROM metadata WHERE key=?').get('execution-source-invalid/message/' + id) as { value: string }).value })).map(marker => ({ ...marker, valueSha256: sha(marker.value) }));
  const receipt = Buffer.from(JSON.stringify({ schema: 'incident-recovery-hypothesis-validation-v1', eligibleMessageCount: sources.length, checks: sources.map(id => ({ kind: 'message', id, valid: true })),
    results: sources.map(id => ({ id, readable: true, failedProofHashes: [] })), originalTombstones: markers, newMarkers: [], modelOrNetworkCalls: 0, currentAssetsFullStrictLoadAndFinal: true, fullCanonicalGate: true, publishedCertificateSkip: false, originalLibraryWrites: 0 }));
  const fileList = (db: CompanionConnection) => (db.prepare("SELECT owner_id,relative_path FROM companion_artifacts WHERE state='committed'").all() as Array<{ owner_id: string; relative_path: string }>).map(item => {
    const bytes = readFileSync(path.join(owners, item.owner_id, ...item.relative_path.split('/'))); return { owner: item.owner_id, relativePath: item.relative_path, sha256: sha(bytes), size: bytes.length };
  });
  const parentManifest = companionHostIncidentRepairManifestSchema.parse({ schema: 'worldlinebox.host-shutdown-withdrawal-repair-v1', operationId: randomUUID(), libraryId: selection.libraryId, initialHead: inspection.head,
    repairAt, beforeStateSHA: hostIncidentRepairStateSHA(db), tombstones: markers.map(item => ({ kind: 'message', id: item.key.split('/')[2], valueSHA: item.valueSha256 })), notes: noteEntries, archives: [], consolidations: [], canonicalFiles: fileList(db),
    validation: { beforeRepairReceiptSHA: sha(receipt), afterRepairReceiptSHA: sha(receipt), sourceSnapshotSHA: sha('independent real fenced fixture'), fullMainGate: 'sql+canonical+current-role+action-authority+final', noCertificateShortcut: true } });
  inspection.close();
  const args = { validationBefore: receipt, validationAfter: receipt }, bodyPlan = runCompanionHostIncidentRepair(selection, parentManifest, args);
  runCompanionHostIncidentRepair(selection, parentManifest, { ...args, mode: 'apply', approvedManifestSHA: bodyPlan.manifestSHA });
  const current = inspectCompanionFencedMaintenance(selection), parentRaw = (current.db.prepare('SELECT value FROM metadata WHERE key=?').get('host-incident-repair/' + parentManifest.operationId) as { value: string }).value;
  const experience = current.db.prepare('SELECT id,data FROM companion_current_experiences ORDER BY source_sequence DESC,rowid DESC LIMIT 1').get() as { id: string; data: string };
  const relationships = current.db.prepare('SELECT id,data FROM companion_relationship_records ORDER BY rowid LIMIT 2').all() as Array<{ id: string; data: string }>;
  const changes = current.db.prepare('SELECT id,data FROM companion_state_changes WHERE kind=\'memory\' ORDER BY applied_at,rowid').all() as Array<{ id: string; data: string }>;
  const flags = [{ kind: 'experience', ...experience }, ...relationships.map(row => ({ kind: 'relationship', ...row })), ...changes.map(row => ({ kind: 'state_change', ...row }))].map(row => ({ kind: row.kind, id: row.id, owner: owner.id, dataSHA: sha(row.data) }));
  const manifest = companionHostQualitativeRepairManifestSchema.parse({ schema: 'worldlinebox.host-shutdown-qualitative-flags-v1', operationId: randomUUID(), libraryId: selection.libraryId, initialHead: current.head, beforeStateSHA: hostIncidentRepairStateSHA(current.db),
    incidentFrom, incidentUntil, parentRepair: { operationId: parentManifest.operationId, manifestSHA: bodyPlan.manifestSHA, receiptSHA: sha(parentRaw), afterHead: current.head }, flags, canonicalFiles: fileList(current.db) }); current.close();
  const read = (sql: string, ...bindings: unknown[]) => { const db = new Database(ledger, { readonly: true }); try { return db.prepare(sql).all(...bindings); } finally { db.close(); } };
  return { root, selection, ledger, owners, manifest, parentManifest, args, read,
    run: (apply = false, approvedManifestSHA?: string) => runCompanionHostQualitativeRepair(selection, manifest, parentManifest, { ...args, mode: apply ? 'apply' : 'plan', approvedManifestSHA }) };
}

it('restores only the ten exact flags with one real fence generation, preserving data, old experiences, runtime and events', async () => {
  const f = await fixture(), runtime = f.read('SELECT * FROM companion_runtime_states'), events = f.read('SELECT * FROM companion_state_events'), notes = f.read('SELECT * FROM vcp_memory_notes'), plan = f.run();
  expect(f.read('SELECT id FROM companion_current_experiences WHERE active=1')).toHaveLength(0);
  const done = f.run(true, plan.manifestSHA); expect(done.head.generation).toBe(plan.head.generation + 1); expect(f.run(true, plan.manifestSHA).head).toEqual(done.head);
  expect(f.read('SELECT id FROM companion_current_experiences WHERE active=1')).toHaveLength(1); expect(f.read('SELECT id FROM companion_current_experiences WHERE active=0')).toHaveLength(6);
  expect(f.read('SELECT id FROM companion_relationship_records WHERE active=1')).toHaveLength(2); expect(f.read("SELECT id FROM companion_state_changes WHERE kind='memory' AND active=1")).toHaveLength(7);
  expect(f.read('SELECT * FROM companion_runtime_states')).toEqual(runtime); expect(f.read('SELECT * FROM companion_state_events')).toEqual(events); expect(f.read('SELECT * FROM vcp_memory_notes')).toEqual(notes);
});
it.each([{ replacement: true }, { expired: true }])('rejects a legitimately superseded or expiring record even with fresh exact manifest bindings (%j)', async options => {
  const f = await fixture(options); expect(() => f.run()).toThrow(/替代|到期/u); expect(f.read("SELECT id FROM companion_state_changes WHERE kind='memory' AND active=1")).toHaveLength(0);
});
it('rejects exact data/CAS drift and rolls every flag back if a real late SQL source withdrawal occurs', async () => {
  const f = await fixture(); f.manifest.flags[0]!.dataSHA = 'f'.repeat(64); expect(() => f.run()).toThrow('CAS');
  const g = await fixture({ lateForget: true }), plan = g.run(); expect(() => g.run(true, plan.manifestSHA)).toThrow(/SQL|来源|权限/u);
  expect(g.read('SELECT id FROM companion_current_experiences WHERE active=1')).toHaveLength(0); expect(g.read('SELECT * FROM vcp_source_blocks')).toHaveLength(0);
  expect(g.read('SELECT value FROM metadata WHERE key=?', 'host-incident-repair/' + g.manifest.operationId)).toHaveLength(0);
});
it('reconciles a committed unknown finish by its exact receipt and never repeats effects or the authority increment', async () => {
  const f = await fixture(), plan = f.run(), authority = new Database(companionRecoveryFencePath(f.selection));
  authority.exec("CREATE TRIGGER flags_test_finish BEFORE UPDATE OF pending ON recovery_authority WHEN OLD.pending=1 AND NEW.pending=0 BEGIN SELECT RAISE(ABORT,'unknown flags finish'); END");
  expect(() => f.run(true, plan.manifestSHA)).toThrow('unknown flags finish'); authority.exec('DROP TRIGGER flags_test_finish'); authority.close();
  const done = f.run(true, plan.manifestSHA); expect(done.head.generation).toBe(plan.head.generation + 1); expect(f.run(true, plan.manifestSHA).head).toEqual(done.head);
});
