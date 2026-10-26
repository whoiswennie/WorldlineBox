import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

it('physically removes reset-owner immutable SQL bodies and annotations while retaining another owners history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-reset-history-audit-')), filename = path.join(root, 'ledger.sqlite');
  const store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: 'Initial seed only', model: '', avatar: 'sister' as const, active: true, proactive: false })));
  const secret = 'SYNTHETIC_RESET_HISTORY_SECRET_82973', other = 'BOB_HISTORY_MUST_REMAIN_65184';
  const rows = (): Record<string, number> => {
    const db = new (Database as { new(file: string): CompanionConnection })(filename);
    try { return {
      contentBodies: (db.prepare('SELECT COUNT(*) AS n FROM companion_memory_content_revisions WHERE companion_id=?').get('alice') as { n: number }).n,
      secretBodies: (db.prepare('SELECT COUNT(*) AS n FROM companion_memory_content_revisions WHERE companion_id=? AND instr(data,?)>0').get('alice', secret) as { n: number }).n,
      versionAnnotations: (db.prepare('SELECT COUNT(*) AS n FROM companion_memory_version_revisions WHERE note_id IN(SELECT id FROM vcp_memory_notes WHERE companion_id=?)').get('alice') as { n: number }).n,
      secretAnnotations: (db.prepare('SELECT COUNT(*) AS n FROM companion_memory_version_revisions WHERE instr(annotations,?)>0').get(secret) as { n: number }).n,
      currentNotes: (db.prepare('SELECT COUNT(*) AS n FROM vcp_memory_notes WHERE companion_id=?').get('alice') as { n: number }).n,
      bobBodies: (db.prepare('SELECT COUNT(*) AS n FROM companion_memory_content_revisions WHERE companion_id=? AND instr(data,?)>0').get('bob', other) as { n: number }).n,
    }; } finally { db.close(); }
  };
  let before: Record<string, number> | undefined, after: Record<string, number> | undefined, reset: unknown;
  try {
    const room = store.openPrivate('alice'), bobRoom = store.openPrivate('bob');
    const bobNote = store.saveMemory({ companionId: 'bob', conversationId: bobRoom.id, content: other, tags: [] });
    const note = store.saveMemory({ companionId: 'alice', conversationId: room.id, content: secret + ' first body', tags: [secret] });
    const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: secret + ' corrected body', replyDirective: 'none' });
    store.request({ type: 'memory.revise', companionId: 'alice', conversationId: room.id, id: note.id, expectedVersion: note.version,
      candidate: { content: source.content, tags: [secret], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    before = rows(); expect(before.secretBodies).toBe(2);
    const job = store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: job.id });
    for (let step = 0; step < 1000; step++) {
      const current = store.request({ type: 'companion.reset.status', id: 'alice' }).reset!;
      if (current.status === 'failed') throw Error('Reset failed: ' + current.phase + ': ' + current.error);
      if (current.status === 'completed') { reset = current; break; }
      await store.advanceReset();
    }
    expect(reset).toBeDefined(); after = rows();
    expect(after).toEqual({ contentBodies: 0, secretBodies: 0, versionAnnotations: 0, secretAnnotations: 0, currentNotes: 0, bobBodies: 1 });
    expect(store.request({ type: 'memory.frozen.valid', companionId: 'alice', conversationId: room.id, memories: [{ id: note.id, contentRevision: note.contentRevision,
      sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) }] }).memoryFrozenValid).toBe(false);
    expect(store.request({ type: 'memory.read', companionId: 'bob', conversationId: bobRoom.id, id: bobNote.id }).memoryRead?.memory.content).toBe(other);
  } finally {
    after ??= rows();
    const output = path.resolve(`artifacts/vcp-validation/memory-reset-history-audit-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ syntheticFixtureOnly: true, userDataModified: false, before, after, reset }, null, 2));
    store.close(); await removeOwnedDirectory(root);
  }
});
