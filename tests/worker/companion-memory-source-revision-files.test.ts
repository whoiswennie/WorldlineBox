import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { companionMemorySourceFilePath } from '../../src/main/companions/memory-source-files';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const filename = path.join(f.root, 'state.sqlite'), { store, scope } = f;
  const raw = f.source('同一原文的修订号更新不等于撤回原文。');
  const note = f.record('任务实际采用了这些固定事实。', [raw.id]);
  const sourceFile = (revision: number) => f.file(companionMemorySourceFilePath({ sourceId: raw.id, sourceRevision: revision, sourceChecksum: note.sources[0]!.checksum }));
  const sql = <T>(work: (db: CompanionConnection) => T): T => {
    const db = new (Database as { new(file: string): CompanionConnection })(filename);
    try { db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet); return work(db); }
    finally { db.close(); }
  };
  // No public message editor can currently change only a raw revision. This
  // controlled host mutation exercises the actual production intake afterward,
  // including changedSource, current-note retirement and all durable outboxes.
  const reviseSource = (content = raw.content) => sql(db => {
    db.prepare('UPDATE messages SET revision=revision+1,content=? WHERE id=?').run(content, raw.id);
    new CompanionMemoryStore(db, id => store.getMessage(id)).enqueueMessage(raw.id);
  });
  const ordinary = { id: note.id, contentRevision: note.contentRevision, sources: note.sources.map(reference => ({ id: reference.messageId, conversationId: reference.conversationId, checksum: reference.checksum })) };
  const native = { ...ordinary, sources: note.sources.map(reference => ({ id: reference.messageId, conversationId: reference.conversationId, checksum: reference.checksum, revision: reference.revision })) };
  const frozen = (strict: boolean) => store.request({ type: 'memory.frozen.valid', ...scope, memories: [strict ? native : ordinary] }).memoryFrozenValid;
  return { ...f, raw, note, sql, sourceFile, reviseSource, frozen };
}

it.each(['content', 'source-revoke', 'note-forget'] as const)('preserves identical published source/history/live task files while native revisions remain strict, then honors %s', async withdrawal => {
  const f = fixture(); await f.publish(); const receipt = (await f.live.materialize('alice', [f.note])).receipts;
  const original = f.sourceFile(1); expect(readFileSync(original, 'utf8')).toBe(f.raw.content);
  f.reviseSource();
  expect(f.sql(db => db.prepare("SELECT COUNT(*) AS n FROM companion_memory_source_outbox WHERE source_id=? AND source_revision=1 AND operation='retract'").get(f.raw.id))).toEqual({ n: 0 });
  expect(f.frozen(false)).toBe(true); expect(f.frozen(true)).toBe(false);
  await f.publish(); expect(existsSync(original)).toBe(true); expect(readFileSync(f.sourceFile(2), 'utf8')).toBe(f.raw.content);
  expect((await f.history.read(f.scope, f.note.id, 1)).content).toBe(f.note.content);
  expect(await f.live.validate('alice', receipt)).toBe(true); expect(f.frozen(true)).toBe(false);
  if (withdrawal === 'content') f.reviseSource('这次真实原文内容已被改动。');
  else f.store.request(withdrawal === 'source-revoke' ? { type: 'memory.forget', ...f.scope, sourceMessageIds: [f.raw.id] } : { type: 'memory.forget', ...f.scope, id: f.note.id });
  await f.publish(); expect(f.frozen(false)).toBe(false); expect(await f.live.validate('alice', receipt)).toBe(false);
  await expect(f.history.read(f.scope, f.note.id, 1)).rejects.toThrow();
  if (withdrawal !== 'note-forget') { expect(existsSync(original)).toBe(false); expect(existsSync(f.sourceFile(2))).toBe(false); }
});

it('does not sweep a legal published r1 when a late identical r2 publication loses its strict revision lease', async () => {
  const f = fixture(); await f.publish(); f.reviseSource();
  const r2 = f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice' }).memorySourceOutbox!;
  expect(r2).toMatchObject({ operation: 'publish', sourceRevision: 2 }); f.reviseSource();
  expect(() => f.store.request({ type: 'memory.sources.outbox.complete', id: r2.id, leaseToken: r2.leaseToken })).toThrow('租约');
  await f.publish(); expect(existsSync(f.sourceFile(1))).toBe(true); expect(existsSync(f.sourceFile(3))).toBe(true);
  expect((await f.history.read(f.scope, f.note.id, 1)).content).toBe(f.note.content);
  // Preservation never recreates an already published file deleted externally.
  unlinkSync(f.sourceFile(1)); await f.publish(); expect(existsSync(f.sourceFile(1))).toBe(false);
  await expect(f.history.read(f.scope, f.note.id, 1)).rejects.toThrow();
});
