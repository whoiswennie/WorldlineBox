import path from 'node:path';
import { stat, utimes, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { createCompanionExecutionValidationSession, memoCompanionExecutionAdmission, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));
type Context = { revision: string; profileKey: string; fileReceiptOnly: true; fileReceipts: CompanionMemoryFileReceipt[] };
type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Host = { sourceValidationRevision: number; memoryContextValid(scope: Scope, context: Context): Promise<boolean>;
  memoryFilesValid(owner: string, receipts: readonly CompanionMemoryFileReceipt[]): Promise<boolean> };
async function fixture() {
  const f = managedMemoryFiles(), source = f.source('共同来源支持本任务的准确旧版本。'), notes = [f.record('第一条准确事实。', [source.id]), f.record('第二条准确事实。', [source.id])];
  await f.publish(); const receipts = (await f.live.materialize('alice', notes)).receipts;
  const host = Object.create(CompanionService.prototype) as Host;
  const validate = vi.fn((_scope: Scope, context: Context) => host.memoryFilesValid('alice', context.fileReceipts));
  const authorityCommands: CompanionStorageCommand[] = [];
  const request = async (command: CompanionStorageCommand) => { authorityCommands.push(command); return f.request(command); };
  Object.assign(host, { storage: { request }, liveFiles: f.live, sourceValidationRevision: 0, memory: { contextValid: validate } });
  const context: Context = { revision: 'initial_snapshot', profileKey: 'actual_encoder', fileReceiptOnly: true, fileReceipts: receipts };
  const sql = (work: (db: CompanionConnection) => void) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    try { work(db); } finally { db.close(); }
  };
  return { f, source, notes, receipts, host, validate, context, sql, authorityCommands };
}

it('shares exact file-only context despite unrelated generations, preserving scope and a batched final SQL proof', async () => {
  const h = await fixture();
  try {
    await withCompanionExecutionValidation(async () => {
      for (let count = 0; count < 20; count++) { h.host.sourceValidationRevision++; expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true); }
      expect(h.validate).toHaveBeenCalledTimes(1);
      expect(await h.host.memoryContextValid({ ...h.f.scope, beforeSequence: 99 }, h.context)).toBe(true);
      expect(h.validate).toHaveBeenCalledTimes(2); // Semantic scope is never dropped.
      expect(h.authorityCommands.filter(command => command.type === 'memory.records.filter')).toHaveLength(1);
      expect(h.authorityCommands.filter(command => command.type === 'memory.revisions.describe')).toHaveLength(1);
      h.f.commands.length = 0;
    });
    expect(h.f.commands.filter(command => command.type === 'memory.records.filter')).toHaveLength(1);
    expect(h.f.commands.filter(command => command.type === 'memory.revisions.describe')).toHaveLength(1);
    expect(h.f.commands.find(command => command.type === 'memory.revisions.describe')).toMatchObject({ roots: expect.arrayContaining(h.notes.map(note => ({ id: note.id, contentRevision: note.contentRevision }))) });
    expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true); expect(h.validate).toHaveBeenCalledTimes(3);
  } finally { await h.f.close(); }
});

it('admits only missing receipts for overlapping contexts and rechecks their complete dependency union once', async () => {
  const h = await fixture();
  try {
    const third = h.f.record('第三条事实依赖第二条旧版本。', [h.source.id], [h.notes[1]!.id]);
    await h.f.publish();
    const thirdReceipt = (await h.f.live.materialize('alice', [third])).receipts[0]!;
    const roots = (commands: readonly CompanionStorageCommand[]) => commands.flatMap(command => command.type === 'memory.revisions.describe'
      ? [command.roots.map(root => root.id).sort()] : []);
    const filtered = (commands: readonly CompanionStorageCommand[]) => commands.flatMap(command => command.type === 'memory.records.filter'
      ? [[...(command.ids ?? [])].sort()] : []);
    await withCompanionExecutionValidation(async () => {
      expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true);
      expect(await h.host.memoryContextValid(h.f.scope, { ...h.context, fileReceipts: [h.receipts[0]!, thirdReceipt] })).toBe(true);
      expect(await h.host.memoryContextValid({ ...h.f.scope, beforeSequence: 99 }, h.context)).toBe(true);
      const expected = [h.notes.map(note => note.id).sort(), [third.id]];
      expect(filtered(h.authorityCommands)).toEqual(expected);
      expect(roots(h.authorityCommands)).toEqual(expected);
      expect(h.validate).toHaveBeenCalledTimes(3); // Three semantic contexts; two SQL admissions.
    });
    const expected = [h.notes.map(note => note.id).sort(), [third.id], [...h.notes.map(note => note.id), third.id].sort()];
    expect(filtered(h.authorityCommands)).toEqual(expected);
    expect(roots(h.authorityCommands)).toEqual(expected);
    // Final describe also resolves the third root's shared dependency; no root
    // or previously consumed descriptor disappears when the missing batch is C.
    expect(h.authorityCommands.filter(command => command.type === 'memory.revisions.describe')).toHaveLength(3);
  } finally { await h.f.close(); }
});

it('keeps the same old task receipt valid when an ordinary SQL revision occurs between initial admission and final fence', async () => {
  const h = await fixture();
  try {
    await withCompanionExecutionValidation(async () => {
      expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true);
      h.f.store.request({ type: 'memory.revise', ...h.f.scope, id: h.notes[0]!.id, expectedVersion: h.notes[0]!.version,
        candidate: h.f.candidate('这属于下一个版本的新正文。', [h.source.id]) });
      h.f.index(); // Deliberately before canonical publication; history r1 remains lawful.
    });
    expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true);
  } finally { await h.f.close(); }
});

it.each(['forget', 'membership', 'history_withdrawal', 'same_stat_bytes'] as const)('rejects %s after cached admission without downgrading the final SQL proof', async change => {
  const h = await fixture(); let mutated = false;
  try {
    await expect(withCompanionExecutionValidation(async () => {
      expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true);
      if (change === 'forget') h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id] });
      if (change === 'membership') {
        const ownerScope = h.f.store.request({ type: 'memory.library.scope.read', companionId: 'alice' }).conversation!;
        h.sql(db => db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(ownerScope.id, 'alice'));
      }
      if (change === 'history_withdrawal') h.sql(db => db.prepare("UPDATE companion_memory_history_files SET state='retracted' WHERE companion_id=? AND note_id=?").run('alice', h.notes[0]!.id));
      if (change === 'same_stat_bytes') {
        const file = h.f.noteFile(h.notes[0]!), before = await stat(file);
        await writeFile(file, h.notes[0]!.content.replace('准确', '篡改')); await utimes(file, before.atime, before.mtime);
      }
      mutated = true;
    })).rejects.toThrow();
    expect(mutated).toBe(true);
    expect(h.validate).toHaveBeenCalledTimes(1); // No final denial invokes a weaker fallback.
  } finally { await h.f.close(); }
});

it('separates two owning storage ports and discards cancellation without reusing a closed task gate', async () => {
  const h = await fixture(), controller = new AbortController(), session = createCompanionExecutionValidationSession(controller.signal);
  try {
    await session.run(async () => {
      expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true);
      const other = Object.create(CompanionService.prototype) as Host, denied = vi.fn(async () => false);
      Object.assign(other, { storage: { request: h.f.request }, sourceValidationRevision: 0, memory: { contextValid: denied } });
      expect(await other.memoryContextValid(h.f.scope, h.context)).toBe(false); expect(denied).toHaveBeenCalledOnce();
    });
    controller.abort(); await expect(session.run(() => h.host.memoryContextValid(h.f.scope, h.context))).rejects.toMatchObject({ name: 'AbortError' });
    session.close(); expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true); expect(h.validate).toHaveBeenCalledTimes(2);
  } finally { session.close(); await h.f.close(); }
});

it('checks SQL only after another owner canonical file and external-asset final admission have completed', async () => {
  const h = await fixture();
  try {
    const scope = { companionId: 'bob', conversationId: h.f.store.openPrivate('bob').id }, source = h.f.source('Bob自己的独立资料。', 'bob');
    const note = h.f.store.request({ type: 'memory.record', ...scope, candidate: h.f.candidate('Bob的正式正文。', [source.id]) }).memories![0]!;
    h.f.index(); await h.f.publish('bob'); const registry = await h.f.artifacts('bob');
    const reader = registry as unknown as { bytes(relative: string, stamp?: (value: string) => void): Promise<Buffer> }, actual = reader.bytes.bind(reader);
    let initialRead = true, bobFinal = false, learningFinal = false;
    const bytes = vi.spyOn(reader, 'bytes').mockImplementation(async (...args) => { const value = await actual(...args); if (!initialRead) bobFinal = true; return value; });
    await expect(withCompanionExecutionValidation(async () => {
      expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true);
      await registry.read({ artifactId: 'memory:' + note.id, consumer: 'audit' }); initialRead = false;
      await memoCompanionExecutionAdmission('external-asset-final', { identity: {}, read: async () => true, cacheable: () => true,
        verify: async () => { expect(bobFinal).toBe(true); learningFinal = true; h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id] }); } });
    })).rejects.toThrow();
    expect(learningFinal).toBe(true);
    bytes.mockRestore();
  } finally { await h.f.close(); }
});
