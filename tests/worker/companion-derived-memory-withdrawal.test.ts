import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { companionQueueJobAdapter, controlCompanionJob, initializeCompanionJobControlReceipts } from '../../src/companions/job-control-store';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  initializeCompanionJobControlReceipts(db);
  return { ...f, db };
}
const derivedTables = ['vcp_memory_notes', 'companion_memory_content_revisions', 'companion_memory_version_revisions',
  'companion_capture_proposals', 'vcp_memory_outbox', 'companion_memory_history_outbox', 'companion_memory_history_files',
  'companion_memory_source_outbox', 'companion_memory_tag_jobs', 'vcp_operation_receipts', 'companion_memory_changes', 'companion_document_catalog', 'companion_job_control_receipts'];
function assertNoDerivedSql(db: CompanionConnection, secret: string) {
  for (const table of derivedTables) expect(JSON.stringify(db.prepare('SELECT * FROM ' + table).all()), table).not.toContain(secret);
}
function assertNoDerivedFiles(directory: string, secret: string) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    expect(item.name).not.toContain(secret);
    if (item.isDirectory()) assertNoDerivedFiles(file, secret);
    else expect(readFileSync(file).toString('utf8'), file).not.toContain(secret);
  }
}

it.each(['note_forget', 'source_revoke', 'source_edit'] as const)('erases derived SQL/history/proposal bytes and files after %s while retaining only lawful original chat', async mode => {
  const f = fixture(), secret = 'PRIVATE_CANARY_BLUE_PATH_9724';
  try {
    const raw = f.source('原始聊天允许保留：' + secret);
    const candidate = { artifactKind: 'procedure' as const, content: '读取并核对 ' + secret, diaryName: secret, tags: [], metadata: { autoTags: true },
      sourceMessageIds: [raw.id], evidence: [{ sourceMessageId: raw.id, quote: raw.content }], procedure: {
        applicability: '只在处理 ' + secret + ' 时使用。', steps: ['读取 ' + secret + ' 的文件。'], limitations: [secret + ' 之外不适用。'],
        verification: { kind: 'artifact_delivery' as const, artifactRequirements: [{ path: secret + '.md', minBytes: 1 }] } } };
    const note = f.store.request({ type: 'memory.record', ...f.scope, operationId: 'private_procedure_write', candidate }).memories![0]!;
    const indexing = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    f.store.request({ type: 'memory.outbox.fail', id: indexing.id, leaseToken: indexing.leaseToken, error: secret, retryAfterMs: 0 });
    const capture = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
    const checkpoint = { identityHash: 'a'.repeat(64), sourceVersions: capture.sourceMessageIds.map(id => f.store.getMessage(id)).map(source => ({ id: source.id, revision: source.revision!, checksum: digest(source.content) })),
      readMemories: [{ id: note.id, version: note.version, contentRevision: note.contentRevision! }],
      sourceContributionIds: [], proposal: { notes: [candidate] }, checks: [] };
    f.store.request({ type: 'memory.jobs.proposal.save', id: capture.id, leaseToken: capture.leaseToken, proposal: checkpoint });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM companion_capture_proposals').all())).toContain(secret);
    f.store.request({ type: 'memory.jobs.fail', id: capture.id, leaseToken: capture.leaseToken, error: secret, retryAfterMs: 0, preserveProposal: true });
    const safeSource = f.source('可以继续保留的独立教材。'), safe = f.record('可以继续保留的独立知识。', [safeSource.id]);
    await f.publish();
    const safeBody = f.db.prepare('SELECT data FROM companion_memory_content_revisions WHERE note_id=?').get(safe.id);
    const oldFile = f.noteFile(note), oldHistory = f.historyFile(note.id, 1);
    expect(existsSync(oldFile)).toBe(true); expect(existsSync(oldHistory)).toBe(true);
    f.store.request({ type: 'memory.index.rebuild', companionId: 'alice' });
    const failedIndex = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    expect(failedIndex.note.id).toBe(note.id);
    f.store.request({ type: 'memory.outbox.fail', id: failedIndex.id, leaseToken: failedIndex.leaseToken, error: secret, retryAfterMs: 0 });
    const adapter = companionQueueJobAdapter(f.db, 'vcp_memory_outbox'), failed = adapter.read('alice', failedIndex.id)!;
    expect(failed.lastError).toBe(secret);
    const parked = controlCompanionJob(f.db, { type: 'jobs.control', ownerId: 'alice', kind: 'index', id: failed.id,
      inputVersion: failed.inputVersion, expectedRevision: failed.revision, operationId: randomUUID(), action: 'park' }, adapter);
    controlCompanionJob(f.db, { type: 'jobs.control', ownerId: 'alice', kind: 'index', id: parked.id,
      inputVersion: parked.inputVersion, expectedRevision: parked.revision, operationId: randomUUID(), action: 'resume' }, adapter);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM companion_job_control_receipts').all())).toContain(secret);
    const lateIndex = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    expect(lateIndex.note.id).toBe(note.id);
    if (mode === 'source_edit') {
      f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('用户已明确编辑成不包含旧私密内容的新聊天。', raw.id);
      new CompanionMemoryStore(f.db, id => f.store.getMessage(id)).enqueueMessage(raw.id);
    } else f.store.request(mode === 'note_forget' ? { type: 'memory.forget', ...f.scope, id: note.id }
      : { type: 'memory.forget', ...f.scope, sourceMessageIds: [raw.id] });
    assertNoDerivedSql(f.db, secret);
    const retired = JSON.parse((f.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(note.id) as { data: string }).data);
    expect(retired.diaryName).toBeUndefined(); expect(retired.procedure).toBeUndefined();
    expect(() => f.store.request({ type: 'memory.jobs.proposal.save', id: capture.id, leaseToken: capture.leaseToken, proposal: checkpoint })).toThrow();
    // A revoked lease's late failure is deliberately an inert host no-op.
    f.store.request({ type: 'memory.outbox.fail', id: lateIndex.id, leaseToken: lateIndex.leaseToken, error: secret });
    assertNoDerivedSql(f.db, secret);
    expect(adapter.read('alice', failedIndex.id)?.failureCount).toBe(failed.failureCount);
    expect(f.db.prepare('SELECT data FROM companion_memory_content_revisions WHERE note_id=?').get(safe.id)).toEqual(safeBody);
    await f.publish();
    const cleanup = await f.library.purgeRevoked('alice'); expect(cleanup.conflicts).toEqual([]); expect(cleanup.pending).toBe(false);
    assertNoDerivedSql(f.db, secret); assertNoDerivedFiles(f.directory, secret);
    expect(existsSync(oldFile)).toBe(false); expect(existsSync(oldHistory)).toBe(false);
    await expect(f.history.read(f.scope, note.id, 1)).rejects.toThrow();
    await expect(f.live.materialize('alice', [note])).rejects.toThrow();
    expect((await f.history.read(f.scope, safe.id, 1)).content).toBe(safe.content);
    if (mode !== 'source_edit') expect(f.store.getMessage(raw.id).content).toContain(secret);
    else expect(f.store.getMessage(raw.id).content).not.toContain(secret);
  } finally { f.db.close(); }
}, 30000);

it.each(['source_revoke', 'source_edit'] as const)('erases only revoked checksum history after %s and retains a lawful independent earlier revision byte-for-byte', async mode => {
  const f = fixture(), secret = 'PRIVATE_REVISION_CANARY_6201';
  try {
    const first = f.source('独立来源A继续有效。'), original = f.record('独立原稿A。', [first.id]); await f.publish();
    const originalBody = f.db.prepare('SELECT data FROM companion_memory_content_revisions WHERE note_id=? AND content_revision=1').get(original.id);
    const originalAnnotations = f.db.prepare('SELECT annotations FROM companion_memory_version_revisions WHERE note_id=? AND version=?').get(original.id, original.version);
    const second = f.source('只在新修订B存在的 ' + secret);
    f.store.request({ type: 'memory.revise', ...f.scope, id: original.id, expectedVersion: original.version,
      candidate: { artifactKind: 'episode_memory', content: secret, diaryName: secret, tags: [secret], sourceMessageIds: [second.id], evidence: [{ sourceMessageId: second.id, quote: second.content }] } });
    await f.publish();
    if (mode === 'source_revoke') f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [second.id] });
    else { f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('新修订B不再含旧内容。', second.id);
      new CompanionMemoryStore(f.db, id => f.store.getMessage(id)).enqueueMessage(second.id); }
    assertNoDerivedSql(f.db, secret);
    expect(f.db.prepare('SELECT data FROM companion_memory_content_revisions WHERE note_id=? AND content_revision=1').get(original.id)).toEqual(originalBody);
    expect(f.db.prepare('SELECT annotations FROM companion_memory_version_revisions WHERE note_id=? AND version=?').get(original.id, original.version)).toEqual(originalAnnotations);
    await f.publish(); expect((await f.history.read(f.scope, original.id, 1)).content).toBe(original.content);
    await expect(f.history.read(f.scope, original.id, 2)).rejects.toThrow();
    f.store.request({ type: 'memory.forget', ...f.scope, id: original.id });
    assertNoDerivedSql(f.db, original.content); await f.publish(); await f.library.purgeRevoked('alice');
    await expect(f.history.read(f.scope, original.id, 1)).rejects.toThrow();
    expect(f.store.getMessage(first.id).content).toBe(first.content);
  } finally { f.db.close(); }
}, 30000);

it('erases a dependent revision through the actual history dependency closure when its original source is revoked', async () => {
  const f = fixture(), secret = 'PRIVATE_DEPENDENT_CANARY_8893';
  try {
    const source = f.source(secret), parent = f.record(secret, [source.id]), other = f.source('根据已经读过的记录继续整理。');
    const child = f.store.request({ type: 'memory.record', ...f.scope,
      readMemories: [{ id: parent.id, version: parent.version, contentRevision: parent.contentRevision! }],
      candidate: { artifactKind: 'knowledge', content: '从原文得到的认识：' + secret, sourceMessageIds: [other.id], relatedMemoryIds: [parent.id],
        evidence: [{ sourceMessageId: other.id, quote: other.content }], tags: [] } }).memories![0]!;
    await f.publish();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM companion_memory_history_dependencies WHERE note_id=? AND parent_id=?').get(child.id, parent.id)).toEqual({ n: 1 });
    f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] });
    assertNoDerivedSql(f.db, secret);
    await f.publish(); await f.library.purgeRevoked('alice'); assertNoDerivedFiles(f.directory, secret);
    await expect(f.history.read(f.scope, child.id, 1)).rejects.toThrow();
    expect(f.store.getMessage(source.id).content).toBe(secret);
  } finally { f.db.close(); }
}, 30000);
