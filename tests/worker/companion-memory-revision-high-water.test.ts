import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { CompanionMemoryLedger } from '../../src/companions/memory-ledger';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionMemory } from '../../src/shared/companions';

it('keeps an invalid placeholder alias retired after exact-body repair and allocates a fresh revision for the next real edit', async () => {
  const f = managedMemoryFiles();
  const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  try {
    const source = f.source('已经确认事实甲，随后又确认事实乙。'), original = f.record('已经确认事实甲。', [source.id]);
    await f.publish();
    const memory = new CompanionMemoryStore(db, id => f.store.getMessage(id)), ledger = new CompanionMemoryLedger(db);
    memory.withdrawNote(original.id, 'invalid');
    const row = db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(original.id) as { data: string };
    const retired = JSON.parse(row.data) as CompanionMemory;
    expect(retired.contentRevision).toBe(2); expect(ledger.versionRevision(original.id, retired.version)).toBe(2);
    expect(ledger.readBody('alice', original.id, 2)).toBeUndefined();
    // This restricted fixture models a reviewed exact-body repair. It is not
    // a public restore command and never touches an actual user library.
    const body = await f.history.read(f.scope, original.id, 1);
    const restored: CompanionMemory = { ...body, status: 'queued', version: retired.version + 1,
      contentRevision: 1, semanticRevision: retired.semanticRevision! + 1, annotationRevision: retired.annotationRevision! + 1 };
    db.transaction(() => {
      expect(db.prepare('UPDATE vcp_memory_notes SET data=? WHERE id=? AND data=?').run(JSON.stringify(restored), original.id, row.data).changes).toBe(1);
      for (const reference of restored.sources) db.prepare('INSERT INTO vcp_note_sources(note_id,message_id,revision,checksum) VALUES(?,?,?,?)')
        .run(restored.id, reference.messageId, reference.revision, reference.checksum);
      ledger.recordVersion(restored);
    }).immediate();
    const changed = f.store.request({ type: 'memory.revise', ...f.scope, id: restored.id, expectedVersion: restored.version,
      candidate: f.candidate('已经确认事实甲，随后又确认事实乙。', [source.id]) }).memories![0]!;
    expect(changed.contentRevision).toBe(3);
    expect(ledger.versionRevision(original.id, retired.version)).toBe(2);
    expect(ledger.readBody('alice', original.id, 2)).toBeUndefined();
    expect(ledger.versionRevision(original.id, restored.version)).toBe(1);
    expect(ledger.versionRevision(original.id, changed.version)).toBe(3);
    expect(ledger.readBody('alice', original.id, 1)?.memory.content).toBe(original.content);
    f.index(); await f.publish();
    expect((await f.history.read(f.scope, original.id, 3)).content).toBe(changed.content);
    expect(f.store.request({ type: 'memory.revision.describe', ...f.scope, id: original.id, contentRevision: 1 }).memoryHistoryDescriptor).toBeDefined();
    expect(f.store.request({ type: 'memory.revision.describe', ...f.scope, id: original.id, contentRevision: 3 }).memoryHistoryDescriptor).toBeDefined();
  } finally { db.close(); await f.close(); }
});
