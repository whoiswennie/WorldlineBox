import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import type { CompanionMemory } from '../../src/shared/companions';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

it('matches the original scoped status counts through source/owner revocation, archived notes, ACL, external SQL and reset with a bounded metadata cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-memory-status-metadata-')), filename = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: 'Synthetic status counter.', model: '', avatar: 'sister', active: true, proactive: false })));
  const queries: string[] = [];
  const Sqlite = Database as { new(file: string, options?: { verbose(sql: string): void }): CompanionConnection };
  const db = new Sqlite(filename, { verbose: (sql: string) => queries.push(sql) });
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const memory = new CompanionMemoryStore(db, id => store.getMessage(id));
  const alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const group = store.createConversation('Synthetic status group', ['alice', 'bob']);
  const check = (owner: string, conversationId?: string) => {
    // The previous implementation is retained here only as a counter oracle.
    const notes = (db.prepare('SELECT data FROM vcp_memory_notes WHERE companion_id=?' + (conversationId ? ' AND conversation_id=?' : ''))
      .all(...(conversationId ? [owner, conversationId] : [owner])) as Array<{ data: string }>).map(row => JSON.parse(row.data) as CompanionMemory);
    const expected = { memories: notes.filter(note => !['invalid', 'forgotten'].includes(note.status)).length,
      forgotten: notes.filter(note => note.status === 'forgotten').length, indexed: notes.filter(note => note.status === 'indexed').length,
      pendingIndex: notes.filter(note => note.status === 'queued' && !note.archivedAt).length };
    queries.length = 0; expect(memory.status(owner, conversationId)).toMatchObject(expected);
    expect(queries.some(sql => /SELECT data FROM vcp_memory_notes/iu.test(sql))).toBe(false);
    return queries.filter(sql => sql.includes('SUM(CASE')).length;
  };
  const acknowledge = () => { for (;;) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break;
    store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); } };
  try {
    const first = store.saveMemory({ ...alice, content: 'Synthetic queued body.', tags: [] });
    store.saveMemory({ ...bob, content: 'Bob remains independent.', tags: [] });
    store.saveMemory({ companionId: 'alice', conversationId: group.id, content: 'Group-only counted body.', tags: [] });
    expect(check('alice')).toBe(1); expect(check('alice')).toBe(0); check('alice', alice.conversationId); check('alice', group.id); check('bob');
    db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.archivedAt','2026-10-27T00:00:00Z') WHERE id=?").run(first.id);
    expect(check('alice')).toBe(1); expect(memory.status('alice').pendingIndex).toBe(1);
    acknowledge(); expect(check('alice')).toBe(1);
    const raw = [0, 1].map(index => store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: 'Synthetic original source ' + index, replyDirective: 'none' }));
    const derived = store.request({ type: 'memory.record', ...alice, candidate: { content: 'A source-backed memory.', sourceMessageIds: raw.map(source => source.id),
      evidence: raw.map(source => ({ sourceMessageId: source.id, quote: source.content })), tags: [] } }).memories![0]!;
    acknowledge(); check('alice');
    store.request({ type: 'memory.forget', ...alice, sourceMessageIds: [raw[0]!.id] }); expect(check('alice')).toBe(1);
    store.request({ type: 'memory.forget', ...alice, id: derived.id }); expect(check('alice')).toBe(1);
    db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(group.id, 'bob'); expect(check('bob')).toBe(1);
    store.deleteConversation(group.id, 'dissolve'); expect(check('alice')).toBe(1); check('alice', group.id);
    const external = new Sqlite(filename);
    try { external.prepare("INSERT INTO metadata(key,value) VALUES('synthetic-status-external-version','new')").run(); }
    finally { external.close(); }
    // No note/epoch changed: external data_version alone invalidates the memo.
    expect(check('alice')).toBe(1); expect(check('alice')).toBe(0);
    for (let index = 0; index < 24; index++) check('alice', 'synthetic_room_' + index);
    expect((memory as unknown as { statusNoteCounts: Map<string, unknown> }).statusNoteCounts.size).toBe(16);
    check('alice'); memory.invalidateOwner('alice'); expect(check('alice')).toBe(1);
    const reset = store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: reset.id });
    for (let step = 0; step < 1000; step++) { const job = store.request({ type: 'companion.reset.status', id: 'alice' }).reset!;
      if (job.status === 'failed') throw new Error('Synthetic reset failed: ' + job.error);
      if (job.status === 'completed') break; await store.advanceReset(); }
    expect(store.request({ type: 'companion.reset.status', id: 'alice' }).reset?.status).toBe('completed');
    check('alice'); expect(memory.status('alice').memories).toBe(0); check('bob'); expect(memory.status('bob').memories).toBe(1);
  } finally { db.close(); store.close(); await removeOwnedDirectory(root); }
});
