import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionMessagePublicationCandidate } from '../../src/shared/companion-message-publication';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const source = f.source('这条来源是已发生的真实记录。');
  const parent = f.record('共享原始来源的第一条事实。', [source.id]);
  const note = f.record('基于第一条事实的完整历史记录。', [source.id], [parent.id]);
  await f.publish();
  const receipts = (await f.live.materialize('alice', [note])).receipts;
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    memories: [], sources: [], knowledgeReads: [], topics: [], contexts: [{ revision: 'actual-published-context', profileKey: 'exact-encoder',
      fileReceiptOnly: true, fileReceipts: receipts }], frozenMemories: [{ id: note.id, contentRevision: note.contentRevision!,
      sources: note.sources.map(reference => ({ id: reference.messageId, conversationId: reference.conversationId,
        checksum: reference.checksum, revision: reference.revision })) }] };
  const append = (content = '本轮正式发言确实引用了这份历史。', proof = readset) => f.store.appendMessage({ conversationId: f.scope.conversationId,
    authorId: 'alice', content, executionReadset: proof });
  const message = append();
  const observe = (id = message.id) => f.store.request({ type: 'execution.sources', sourceMessageIds: [id] }).executionSources!.find(proof => proof.id === id)!;
  const certify = (candidate: CompanionMessagePublicationCandidate) => f.store.request({ type: 'execution.message.certify',
    messages: [{ ...candidate, mode: 'revalidated_historical' }] });
  const sql = (run: (db: CompanionConnection) => void) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try { run(db); } finally { db.close(); }
  };
  return { f, source, parent, note, receipts, readset, append, message, observe, certify, sql };
}

it('requires a private explicit Main certification and persists its exact publication tuple across restart', async () => {
  const h = await fixture(), before = h.observe();
  expect(before.publicationCandidate).toBeDefined(); expect(before.publicationCertificate).toBeUndefined();
  expect(companionsRequestSchema.safeParse({ type: 'execution.message.certify', messages: [{ ...before.publicationCandidate!, mode: 'new_publication' }] }).success).toBe(false);
  expect(await h.f.live.validate('alice', h.receipts)).toBe(true);
  const response = h.certify(before.publicationCandidate!);
  expect(response.messagePublicationCertificates).toHaveLength(1);
  expect(h.observe().publicationCertificate).toMatchObject(before.publicationCandidate!);
  const certifiedAt = h.observe().publicationCertificate!.certifiedAt;
  h.f.restart(); expect(h.observe().publicationCertificate!.certifiedAt).toBe(certifiedAt);
  expect(h.f.store.getMessage(h.message.id).createdAt).toBe(h.message.createdAt);
});

it('keeps the published historical statement while a current canonical file edit still fails the real RAG file gate', async () => {
  const h = await fixture(); h.certify(h.observe().publicationCandidate!);
  await writeFile(h.f.noteFile(h.note), '外部篡改当前正文，不能用于新回忆。');
  expect(h.observe().publicationCertificate).toBeDefined();
  expect(await h.f.live.validate('alice', h.receipts)).toBe(false);
});

it.each(['source', 'membership', 'history', 'ancestor-history'] as const)('rechecks live %s SQL authority before returning a certificate', async kind => {
  const h = await fixture(), candidate = h.observe().publicationCandidate!; h.certify(candidate);
  h.sql(db => {
    if (kind === 'source') db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('已改写的来源。', h.source.id);
    else if (kind === 'membership') db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(h.f.scope.conversationId, 'alice');
    else db.prepare("UPDATE companion_memory_history_files SET state='retracted' WHERE note_id=? AND content_revision=?")
      .run(kind === 'history' ? h.note.id : h.parent.id, kind === 'history' ? h.note.contentRevision! : h.parent.contentRevision!);
  });
  expect(h.observe().publicationCertificate).toBeUndefined();
  expect(() => h.certify(candidate)).toThrow();
});

it('binds body bytes and message revision while ignoring only JSON object insertion order', async () => {
  const h = await fixture(), candidate = h.observe().publicationCandidate!; h.certify(candidate);
  h.sql(db => db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(Object.fromEntries(Object.entries(h.readset).reverse())), 'message-execution-readset/' + h.message.id));
  expect(h.observe().publicationCertificate).toMatchObject(candidate);
  h.sql(db => db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('这已经是另一份正式正文。', h.message.id));
  expect(h.observe().publicationCertificate).toBeUndefined();
  expect(() => h.certify(candidate)).toThrow();
});

it('does not certify malformed, uncovered, cross-owner or wrong-byte file contexts', async () => {
  const h = await fixture();
  for (const change of ['legacy', 'coverage', 'owner', 'path', 'bytes', 'revision'] as const) {
    const readset = structuredClone(h.readset), context = readset.contexts[0]!;
    if (change === 'legacy') delete context.fileReceiptOnly;
    else if (change === 'coverage') readset.frozenMemories = [];
    else if (change === 'owner') context.fileReceipts![0]!.companionId = 'bob';
    else if (change === 'path') context.fileReceipts![0]!.path = '记忆/经历/unrelated.md';
    else if (change === 'bytes') context.fileReceipts![0]!.contentHash = '0'.repeat(64);
    else context.fileReceipts![0]!.contentRevision++;
    const message = h.append('不能凭空增加的历史证据：' + change, readset);
    expect(h.observe(message.id).publicationCandidate, change).toBeUndefined();
  }
});

it('certifies a consumed valid sibling only and rolls back a batch containing a drifted tuple', async () => {
  const h = await fixture(), other = h.append('另一个独立的正式结果。'), a = h.observe().publicationCandidate!, b = h.observe(other.id).publicationCandidate!;
  expect(() => h.f.store.request({ type: 'execution.message.certify', messages: [
    { ...a, mode: 'new_publication' }, { ...b, bodySHA: '0'.repeat(64), mode: 'new_publication' },
  ] })).toThrow();
  expect(h.observe().publicationCertificate).toBeUndefined(); expect(h.observe(other.id).publicationCertificate).toBeUndefined();
  h.certify(a); expect(h.observe().publicationCertificate).toBeDefined(); expect(h.observe(other.id).publicationCertificate).toBeUndefined();
  expect(() => h.certify({ ...b, companionId: 'bob' })).toThrow();
});

it('refuses a cyclic immutable history closure even if the old ordinary SQL readset attestation remains present', async () => {
  const h = await fixture(), candidate = h.observe().publicationCandidate!; h.certify(candidate);
  h.sql(db => {
    db.prepare('UPDATE companion_memory_history_files SET dependencies=? WHERE note_id=? AND content_revision=?')
      .run(JSON.stringify([{ id: h.note.id, contentRevision: h.note.contentRevision }]), h.parent.id, h.parent.contentRevision!);
  });
  expect(h.observe().publicationCertificate).toBeUndefined(); expect(() => h.certify(candidate)).toThrow();
});
