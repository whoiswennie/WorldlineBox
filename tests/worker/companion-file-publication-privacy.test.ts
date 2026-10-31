import { randomUUID } from 'node:crypto';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

it.each(['note_forget', 'source_revoke', 'source_edit'] as const)('erases exact source/history job diagnostic copies after %s without clearing peer errors or failure counts', async mode => {
  const f = managedMemoryFiles(); fixtures.push(f);
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const secret = 'PRIVATE_FILE_PUBLICATION_DIAGNOSTIC_8112', peerError = 'LAWFUL_PEER_DIAGNOSTIC_REMAINS';
  try {
    const setup = async (owner: 'alice' | 'bob', diagnostic: string) => {
      const source = f.source(`原始${owner}来源 ${diagnostic}`, owner), conversationId = source.conversationId;
      const note = f.store.request({ type: 'memory.record', companionId: owner, conversationId,
        candidate: f.candidate(`实际派生记忆 ${diagnostic}`, [source.id]) }).memories![0]!; f.index();
      const jobs: Array<{ kind: 'source_files' | 'history_files'; id: string }> = [];
      for (const kind of ['source_files', 'history_files'] as const) {
        const commandType = kind === 'source_files' ? 'memory.sources.outbox.complete' : 'memory.history.outbox.complete';
        let first = true;
        f.intercept(command => { if (first && command.type === commandType) { first = false; throw new Error(diagnostic); } });
        if (kind === 'source_files') await f.sources.flush(owner); else await f.history.flush(owner);
        f.intercept();
        const table = kind === 'source_files' ? 'companion_memory_source_outbox' : 'companion_memory_history_outbox';
        const match = db.prepare(`SELECT id FROM ${table} WHERE companion_id=? AND operation='publish' AND ${kind === 'source_files' ? 'source_id' : 'note_id'}=?`)
          .get(owner, kind === 'source_files' ? source.id : note.id) as { id: string };
        const before = f.store.request({ type: 'jobs.inspect', ownerId: owner, kind, id: match.id }).jobDisposition!;
        expect(before).toMatchObject({ state: 'failed', failureCount: 1, lastError: diagnostic });
        const parked = f.store.request({ type: 'jobs.control', ownerId: owner, kind, id: match.id, inputVersion: before.inputVersion,
          expectedRevision: before.revision, operationId: randomUUID(), action: 'park' }).jobDisposition!;
        f.store.request({ type: 'jobs.control', ownerId: owner, kind, id: match.id, inputVersion: parked.inputVersion,
          expectedRevision: parked.revision, operationId: randomUUID(), action: 'resume' });
        if (kind === 'source_files') await f.sources.flush(owner); else await f.history.flush(owner);
        const completed = f.store.request({ type: 'jobs.inspect', ownerId: owner, kind, id: match.id }).jobDisposition!;
        expect(completed).toMatchObject({ state: 'completed', failureCount: 1, lastError: diagnostic }); jobs.push({ kind, id: match.id });
      }
      return { source, note, jobs };
    };
    const withdrawn = await setup('alice', secret), peer = await setup('bob', peerError);
    expect(JSON.stringify(db.prepare('SELECT * FROM companion_job_control_receipts WHERE owner_id=?').all('alice'))).toContain(secret);
    const peerSources = db.prepare('SELECT * FROM companion_memory_source_outbox WHERE companion_id=?').all('bob');
    const peerHistory = db.prepare('SELECT * FROM companion_memory_history_outbox WHERE companion_id=?').all('bob');
    const peerReceipts = db.prepare('SELECT * FROM companion_job_control_receipts WHERE owner_id=?').all('bob');
    if (mode === 'source_edit') {
      db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('用户明确改为无旧私密正文的新版本。', withdrawn.source.id);
      new CompanionMemoryStore(db, id => f.store.getMessage(id)).enqueueMessage(withdrawn.source.id);
    } else f.store.request(mode === 'note_forget' ? { type: 'memory.forget', ...f.scope, id: withdrawn.note.id }
      : { type: 'memory.forget', ...f.scope, sourceMessageIds: [withdrawn.source.id] });
    for (const table of ['companion_memory_source_outbox', 'companion_memory_history_outbox', 'companion_job_control_receipts'])
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE ${table === 'companion_job_control_receipts' ? 'owner_id' : 'companion_id'}=?`).all('alice')), table).not.toContain(secret);
    for (const job of withdrawn.jobs) expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', ...job }).jobDisposition).toMatchObject({ failureCount: 1 });
    expect(db.prepare('SELECT * FROM companion_memory_source_outbox WHERE companion_id=?').all('bob')).toEqual(peerSources);
    expect(db.prepare('SELECT * FROM companion_memory_history_outbox WHERE companion_id=?').all('bob')).toEqual(peerHistory);
    expect(db.prepare('SELECT * FROM companion_job_control_receipts WHERE owner_id=?').all('bob')).toEqual(peerReceipts);
    await f.publish(); await f.library.purgeRevoked('alice');
    await expect(f.history.read(f.scope, withdrawn.note.id, 1)).rejects.toThrow();
    expect((await f.live.materialize('bob', [peer.note])).notes[0]?.content).toContain(peerError);
    expect(f.store.getMessage(withdrawn.source.id).content).toBe(mode === 'source_edit' ? '用户明确改为无旧私密正文的新版本。' : withdrawn.source.content);
  } finally { db.close(); }
}, 30000);
