import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionStorageClient } from '../../src/main/companions/storage-client';
import { guardCompanionExecutionSources, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionStorageBusinessFailure } from '../../src/shared/companion-storage-failure';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import type { CompanionConnection } from '../../src/companions/store';

const transport = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: transport.fork } }));

it.each([
  { code: 'SQLITE_BUSY', port: 'memory.records.filter' }, { code: 'SQLITE_IOERR_READ', port: 'memory.records.filter' },
  { code: 'SQLITE_IOERR_READ', port: 'memory.frozen.valid' },
] as const)('propagates a real Store SQL $code from $port through Client and source guard without withdrawing canonical history', async ({ code, port }) => {
  const f = managedMemoryFiles(), original = f.source('仍然正式存在的事件。'), note = f.record('经过正式发布的记忆。', [original.id]);
  await f.publish();
  const noteBeforeFault = f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] }).memories![0]!;
  const receipts = (await f.live.materialize('alice', [note])).receipts;
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    sources: [], memories: [], topics: [], knowledgeReads: [], frozenMemories: [{ id: note.id, contentRevision: note.contentRevision!,
      sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) }],
    contexts: [{ revision: 'actual-history', profileKey: 'canonical-files', fileReceiptOnly: true, fileReceipts: receipts }] };
  const derived = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '根据仍有效的正式记忆形成的发言。', executionReadset: readset });
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  const statementPrototype = Object.getPrototypeOf(db.prepare('SELECT 1')), nativeGet = statementPrototype.get;
  let faultEnabled = true, checkingCurrentNote = false, faultHits = 0;
  const sqlFailure = Object.assign(new Error('isolated SQL reader unavailable'), { code });
  const nativeFault = vi.spyOn(statementPrototype, 'get').mockImplementation(function (this: object, ...args: unknown[]) {
    const targetSql = port === 'memory.records.filter' ? 'SELECT data FROM vcp_memory_notes WHERE id=?' : 'SELECT data FROM vcp_memory_notes WHERE id=? AND companion_id=?';
    if (faultEnabled && checkingCurrentNote && Reflect.get(this, 'source') === targetSql && args[0] === note.id) {
      faultHits++; throw code === 'SQLITE_BUSY' ? sqlFailure : new Error('wrapped SQL reader unavailable', { cause: sqlFailure });
    }
    return Reflect.apply(nativeGet, this, args);
  });
  const commands: CompanionStorageCommand[] = [];
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), postMessage: vi.fn(), kill: vi.fn() });
  child.postMessage.mockImplementation((message: { type?: string; requestId?: string; command?: CompanionStorageCommand }) => {
    if (message.type === 'storage.initialize') child.emit('message', { type: 'storage.ready' });
    else if (message.type === 'storage.close') { child.emit('message', { type: 'storage.closed' }); queueMicrotask(() => child.emit('exit', 0)); }
    else if (message.command) setImmediate(() => {
      commands.push(message.command!); checkingCurrentNote = message.command!.type === port;
      try { child.emit('message', { requestId: message.requestId, response: f.store.request(message.command!) }); }
      catch (error) { child.emit('message', { requestId: message.requestId, ...companionStorageBusinessFailure(error) }); }
      finally { checkingCurrentNote = false; }
    });
  });
  transport.fork.mockImplementation(() => { queueMicrotask(() => child.emit('message', { type: 'storage.booted' })); return child; });
  const client = new CompanionStorageClient('isolated-worker.js', path.join(f.root, 'state.sqlite'));
  const raw = (command: CompanionStorageCommand) => client.request(command);
  const command = { type: 'message.get', id: derived.id } as const;
  const guarded = () => withCompanionExecutionValidation(async () => guardCompanionExecutionSources(command, await raw(command), {
    identity: client, revision: () => 0, storage: raw,
    valid: async (proof, sqliteSourcesValidated) => {
      const current = await raw(port === 'memory.records.filter' ? { type: 'memory.records.filter', ...f.scope, ids: [note.id] }
        : { type: 'memory.frozen.valid', ...f.scope, memories: readset.frozenMemories! });
      if (!current.ok || (port === 'memory.records.filter' ? !current.memories?.length : !current.memoryFrozenValid)) return false;
      return verifyCompanionExecutionReadset(proof.executionReadset, proof, { sqliteSourcesValidated, request: raw,
        contextValid: (scope: { companionId: string }, context: { revision: string; profileKey: string; fileReceipts?: readonly CompanionMemoryFileReceipt[] }) =>
          f.live.validate(scope.companionId, context.fileReceipts ?? []) });
    },
  }));
  try {
    await expect(guarded()).rejects.toMatchObject({ code: 'EXECUTION_VALIDATION_UNAVAILABLE' });
    expect(faultHits).toBe(1); expect(commands.some(request => request.type === 'execution.invalidate')).toBe(false);
    faultEnabled = false;
    expect(f.store.request({ type: 'execution.sources', sourceMessageIds: [derived.id], memoryIds: [] }).executionSources?.find(proof => proof.id === derived.id)?.invalidated).not.toBe(true);
    expect(f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] }).memories?.[0]).toEqual(noteBeforeFault);
    expect((await guarded()).message?.content).toBe(derived.content);
    // A normal business refusal still resolves as the original domain result.
    await expect(raw({ type: 'action.get', id: 'missing_action' })).resolves.toEqual({ ok: false, error: '行动不存在。' });
    f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [original.id], persistent: true });
    expect((await guarded()).message?.content).toBe('');
    expect(commands.some(request => request.type === 'execution.invalidate')).toBe(true);
    expect(f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] }).memories).toEqual([]);
  } finally { faultEnabled = false; nativeFault.mockRestore(); child.emit('exit', 0); await client.close(); db.close(); await f.close(); }
}, 15000);
