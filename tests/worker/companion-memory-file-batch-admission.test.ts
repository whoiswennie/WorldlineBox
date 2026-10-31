import { stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import { companionMemorySourceArtifactId } from '../../src/main/companions/memory-source-files';
import { createCompanionExecutionValidationSession, memoCompanionExecutionValidationBatch, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));

async function fixture() {
  const f = managedMemoryFiles(), source = f.source('同一条原始资料支持三个独立、正式的记忆文件。');
  const notes = ['第一条准确正式事实。', '第二条准确正式事实。', '第三条准确正式事实。'].map(text => f.record(text, [source.id]));
  await f.publish();
  const receipts = (await f.live.materialize('alice', notes)).receipts;
  const host = Object.create(CompanionService.prototype) as { memoryFilesValid(owner: string, input: readonly CompanionMemoryFileReceipt[]): Promise<boolean> };
  Object.assign(host, { storage: { request: f.request }, liveFiles: f.live });
  const validate = vi.spyOn(f.live, 'validate'); f.commands.length = 0;
  return { f, source, notes, receipts, host, validate };
}

it('batches real SQL/file admission only for unfinished receipts across overlapping historical contexts', async () => {
  const h = await fixture();
  try {
    await withCompanionExecutionValidation(async () => {
      expect(await h.host.memoryFilesValid('alice', h.receipts.slice(0, 2))).toBe(true);
      expect(await h.host.memoryFilesValid('alice', h.receipts.slice(1))).toBe(true);
      expect(await h.host.memoryFilesValid('alice', h.receipts)).toBe(true);
      expect(h.validate.mock.calls.map(([, files]) => files.map(file => file.noteId))).toEqual([
        h.receipts.slice(0, 2).map(file => file.noteId), [h.receipts[2]!.noteId],
      ]);
      expect(h.f.commands.filter(command => command.type === 'memory.library.scope.read')).toHaveLength(2);
      expect(h.f.commands.filter(command => command.type === 'memory.records.filter')).toHaveLength(4);
    });
    // No completed receipt crosses into another gate or task.
    expect(await h.host.memoryFilesValid('alice', h.receipts)).toBe(true);
    expect(h.validate).toHaveBeenCalledTimes(3);
    expect(h.validate.mock.calls[2]![1]).toHaveLength(3);
  } finally { await h.f.close(); }
});

it('allows acyclic member dependencies without sharing a batch pending promise and rejects an actual cycle', async () => {
  const calls: string[][] = [];
  await withCompanionExecutionValidation(async () => {
    expect(await memoCompanionExecutionValidationBatch(['a', 'b'], () => 0, async missing => {
      calls.push([...missing]);
      return memoCompanionExecutionValidationBatch(['b'], () => 0, async inner => { calls.push([...inner]); return true; });
    })).toBe(true);
    expect(await memoCompanionExecutionValidationBatch(['b', 'c'], () => 0, async missing => { calls.push([...missing]); return true; })).toBe(true);
  });
  expect(calls).toEqual([['a', 'b'], ['b'], ['c']]);
  await expect(withCompanionExecutionValidation(() => memoCompanionExecutionValidationBatch(['a', 'b'], () => 0,
    () => memoCompanionExecutionValidationBatch(['b'], () => 0,
      () => memoCompanionExecutionValidationBatch(['a', 'b'], () => 0, async () => { throw new Error('Cycle must not execute'); }))))).resolves.toBe(false);
});

it('does not mark every member invalid when only the whole attempted batch failed', async () => {
  await withCompanionExecutionValidation(async () => {
    expect(await memoCompanionExecutionValidationBatch(['a', 'b'], () => 0, async () => false)).toBe(false);
    const healthy = vi.fn(async () => true);
    expect(await memoCompanionExecutionValidationBatch(['b'], () => 0, healthy)).toBe(true);
    expect(healthy).toHaveBeenCalledWith(['b']);
  });
});

it('retains the final real-byte fence after a cached exact receipt despite same-size same-mtime tampering', async () => {
  const h = await fixture();
  try {
    await expect(withCompanionExecutionValidation(async () => {
      expect(await h.host.memoryFilesValid('alice', h.receipts)).toBe(true);
      const file = h.f.noteFile(h.notes[0]!), before = await stat(file);
      await writeFile(file, h.notes[0]!.content.replace('准确', '篡改'), 'utf8'); await utimes(file, before.atime, before.mtime);
      expect(await h.host.memoryFilesValid('alice', h.receipts)).toBe(true);
    })).rejects.toThrow();
    expect(await h.host.memoryFilesValid('alice', h.receipts)).toBe(false);
  } finally { await h.f.close(); }
});

it('rechecks a hard SQL source withdrawal and never carries a cancelled frame into a fresh admission', async () => {
  const h = await fixture(), controller = new AbortController(), session = createCompanionExecutionValidationSession(controller.signal);
  try {
    expect(await session.run(() => h.host.memoryFilesValid('alice', h.receipts))).toBe(true);
    controller.abort();
    await expect(session.run(() => h.host.memoryFilesValid('alice', h.receipts))).rejects.toMatchObject({ name: 'AbortError' });
    session.close();
    h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id] });
    expect(await h.host.memoryFilesValid('alice', h.receipts)).toBe(false);
  } finally { session.close(); await h.f.close(); }
});

it('rejects external SQLite source-artifact withdrawal at the final fence after every receipt was already admitted', async () => {
  const h = await fixture();
  try {
    await expect(withCompanionExecutionValidation(async () => {
      expect(await h.host.memoryFilesValid('alice', h.receipts)).toBe(true);
      const db = new (Database as { new(filename: string): CompanionConnection })(path.join(h.f.root, 'state.sqlite'));
      try {
        const id = companionMemorySourceArtifactId(h.source.id, 1);
        const source = db.prepare('SELECT metadata FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get('alice', id) as { metadata: string };
        db.prepare('UPDATE companion_artifacts SET metadata=? WHERE owner_id=? AND artifact_id=?')
          .run(JSON.stringify({ ...JSON.parse(source.metadata), publicationState: 'revoked' }), 'alice', id);
      } finally { db.close(); }
    })).rejects.toThrow();
    expect(await h.host.memoryFilesValid('alice', h.receipts)).toBe(false);
  } finally { await h.f.close(); }
});
