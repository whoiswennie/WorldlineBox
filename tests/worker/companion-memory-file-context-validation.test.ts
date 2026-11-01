import path from 'node:path';
import { stat, utimes, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import { verifyCompanionExecutionReadset, type CompanionAttestedMemoryFiles } from '../../src/main/companions/execution-evidence';
import { preloadCompanionMemoryFileContexts, type CompanionCurrentMemoryFileWitness } from '../../src/main/companions/memory-file-context-validation';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources, memoCompanionExecutionAdmission,
  preloadCompanionExecutionWitnesses, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));
type Context = { revision: string; profileKey: string; fileReceiptOnly: true; fileReceipts: CompanionMemoryFileReceipt[] };
type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Host = { sourceValidationRevision: number; memoryContextValid(scope: Scope, context: Context, files?: CompanionAttestedMemoryFiles): Promise<boolean>;
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
const sqlPort = (h: Awaited<ReturnType<typeof fixture>>) => (h.host as unknown as {
  storage: { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> } }).storage;

function attestedReader(h: Awaited<ReturnType<typeof fixture>>, context = h.context, available = true) {
  Object.assign(h.host, { requireCurrentAssets: async () => undefined }); // This fixture has no external learning grants.
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...h.f.scope,
    memories: [], sources: [], contexts: [context], knowledgeReads: [], topics: [],
    frozenMemories: context.fileReceipts.map(receipt => {
      const note = h.notes.find(note => note.id === receipt.noteId)!;
      return { id: note.id, contentRevision: note.contentRevision!, sources: note.sources.map(source => ({ id: source.messageId,
        conversationId: source.conversationId, checksum: source.checksum, revision: source.revision })) };
    }) };
  const message = h.f.store.appendMessage({ conversationId: h.f.scope.conversationId, authorId: 'alice', content: '有准确正式凭证的历史回复。', executionReadset: readset });
  const command = { type: 'message.get' as const, id: message.id };
  return async () => guardCompanionExecutionSources(command, h.f.store.request(command), {
    identity: sqlPort(h), revision: () => 0, storage: sqlPort(h).request,
    prepareFileContexts: proofs => preloadCompanionMemoryFileContexts(proofs.map(proof => ({ companionId: proof.companionId,
      contexts: proof.executionReadset?.contexts ?? [] })), { identity: sqlPort(h), request: sqlPort(h).request }),
    valid: (proof, sqliteSourcesValidated) => verifyCompanionExecutionReadset(proof.executionReadset, proof, {
      sqliteSourcesValidated, request: sqlPort(h).request,
      ...(proof.storageValidatedReadsetDigest && proof.storageValidatedAuthorityEpoch !== undefined ? { memoryFileAttestation: {
        readsetDigest: proof.storageValidatedReadsetDigest, authorityEpoch: proof.storageValidatedAuthorityEpoch } } : {}),
      contextValid: (scope, context, files) => h.host.memoryContextValid(scope, context as Context, files),
    }),
  }).then(result => { expect(result.message?.content).toBe(available ? message.content : ''); });
}

it('reuses consumed current SQL witnesses for canonical bytes without three extra scope/current-note RPCs', async () => {
  const h = await fixture();
  try {
    const read = attestedReader(h);
    h.authorityCommands.length = 0;
    await withCompanionExecutionValidation(async () => {
      await read(); await read();
      expect(h.validate).not.toHaveBeenCalled();
      for (const type of ['memory.library.scope.read', 'memory.records.filter', 'memory.revisions.describe'])
        expect(h.authorityCommands.filter(command => command.type === type)).toHaveLength(1);
    });
    for (const type of ['memory.library.scope.read', 'memory.records.filter', 'memory.revisions.describe'])
      expect(h.authorityCommands.filter(command => command.type === type)).toHaveLength(2); // The fresh final union remains mandatory.
    h.authorityCommands.length = 0;
    await withCompanionExecutionValidation(read);
    expect(h.authorityCommands.filter(command => command.type === 'memory.records.filter')).toHaveLength(2);
  } finally { await h.f.close(); }
});

it.each(['same_stat_bytes', 'SQL_exact_history_sources', 'SQL_source_room', 'forget'] as const)('rejects %s after current-witness canonical admission', async change => {
  const h = await fixture();
  try {
    const read = attestedReader(h); let admitted = false;
    await expect(withCompanionExecutionValidation(async () => {
      await read(); admitted = true;
      if (change === 'same_stat_bytes') {
        const file = h.f.noteFile(h.notes[0]!), before = await stat(file);
        await writeFile(file, h.notes[0]!.content.replace('准确', '篡改')); await utimes(file, before.atime, before.mtime);
      }
      if (change === 'SQL_exact_history_sources') h.sql(db => db.prepare("UPDATE companion_memory_history_files SET sources=json_set(sources,'$[0].checksum',?) WHERE note_id=?")
        .run('0'.repeat(64), h.notes[0]!.id));
      if (change === 'SQL_source_room') h.sql(db => db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.sourceConversationId',?) WHERE id=?")
        .run(h.f.store.openPrivate('bob').id, h.notes[0]!.id));
      if (change === 'forget') h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id] });
    })).rejects.toThrow();
    expect(admitted).toBe(true); expect(h.validate).not.toHaveBeenCalled();
  } finally { await h.f.close(); }
});

it('rejects a fabricated current-file token even while the actual SQL readset token is active', async () => {
  const h = await fixture();
  try {
    const read = attestedReader(h, h.context, false), original = h.f.live.validateAttested.bind(h.f.live);
    const admission = vi.spyOn(h.f.live, 'validateAttested').mockImplementation((authority, request, receipts) =>
      original(authority, request, receipts, {} as CompanionCurrentMemoryFileWitness));
    await withCompanionExecutionValidation(read);
    expect(admission).toHaveBeenCalledOnce(); expect(h.validate).not.toHaveBeenCalled();
  } finally { await h.f.close(); }
});

it('retains exact source audience checks with a consumed current-file SQL witness', async () => {
  const h = await fixture();
  try {
    const read = attestedReader(h, h.context, false), sourceId = `source:${h.source.id}:r${h.source.revision ?? 1}`;
    let changed = false;
    h.f.intercept(command => {
      if (changed || command.type !== 'cognition.registry.read' || !command.artifactIds?.includes(sourceId)) return;
      changed = true;
      h.sql(db => db.prepare("UPDATE companion_artifacts SET metadata=json_set(metadata,'$.visibility',json(?)) WHERE owner_id=? AND artifact_id=?")
        .run(JSON.stringify({ scope: 'audience', audienceIds: [h.f.store.openPrivate('bob').id] }), 'alice', sourceId));
    });
    await withCompanionExecutionValidation(read);
    expect(changed).toBe(true); expect(h.validate).not.toHaveBeenCalled();
  } finally { await h.f.close(); }
});

it('prefetches a receipt union once but consumes only each root complete dependency closure and rereads in the next task', async () => {
  const h = await fixture();
  try {
    const third = h.f.record('第三条依赖第二条真实旧修订。', [h.source.id], [h.notes[1]!.id]); await h.f.publish();
    const thirdReceipt = (await h.f.live.materialize('alice', [third])).receipts[0]!;
    const unused = { ...h.context, fileReceipts: [h.receipts[0]!] }, used = { ...h.context, fileReceipts: [thirdReceipt] };
    const roots = () => h.authorityCommands.flatMap(command => command.type === 'memory.revisions.describe' ? [command.roots.map(root => root.id).sort()] : []);
    await withCompanionExecutionValidation(async () => {
      await preloadCompanionMemoryFileContexts([{ companionId: 'alice', contexts: [unused, used] }], { identity: sqlPort(h), request: sqlPort(h).request });
      expect(roots()).toEqual([[h.notes[0]!.id, third.id].sort()]);
      expect(await h.host.memoryContextValid(h.f.scope, used)).toBe(true);
      expect(roots()).toHaveLength(1);
    });
    expect(roots()).toEqual([[h.notes[0]!.id, third.id].sort(), [third.id]]);
    h.authorityCommands.length = 0; expect(await h.host.memoryContextValid(h.f.scope, used)).toBe(true);
    expect(roots()).toEqual([[third.id], [third.id]]);
  } finally { await h.f.close(); }
});

it('never verifies an entirely unconsumed prefetch group', async () => {
  const h = await fixture(), verify = vi.fn(async () => { throw new Error('An unused group is not a source read.'); });
  try {
    await withCompanionExecutionValidation(async () => {
      await preloadCompanionExecutionWitnesses([h.notes[0]!.id], { identity: sqlPort(h), scope: 'unused-actual-SQL', phase: 'sql-authority', revision: () => 0,
        read: async ids => new Map(h.f.store.request({ type: 'memory.records.describe', ...h.f.scope, ids: [...ids] }).memoryDescriptors!.map(note => [note.id, note])), verify });
    });
    expect(verify).not.toHaveBeenCalled();
  } finally { await h.f.close(); }
});

it('does not turn metadata-prefetch availability failure into a withdrawal or cache a failed admission', async () => {
  const h = await fixture(); let unavailable = true;
  try {
    h.f.intercept(command => { if (unavailable && command.type === 'memory.revisions.describe') { unavailable = false; throw new Error('controlled transient metadata port failure'); } });
    await withCompanionExecutionValidation(async () => {
      await preloadCompanionMemoryFileContexts([{ companionId: 'alice', contexts: [h.context] }], { identity: sqlPort(h), request: sqlPort(h).request });
      expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true);
    });
    expect(h.validate).toHaveBeenCalledOnce();
    expect(h.f.commands.some(command => command.type === 'execution.invalidate')).toBe(false);
  } finally { await h.f.close(); }
});

it.each(['missing', 'cycle', 'extra'] as const)('refuses an incomplete %s descriptor closure without publishing or falling back to SQL prose', async fault => {
  const h = await fixture(), port = sqlPort(h), actual = port.request;
  try {
    vi.spyOn(port, 'request').mockImplementation(async command => {
      const response = await actual(command);
      if (command.type !== 'memory.revisions.describe' || !response.memoryHistoryDescriptors) return response;
      if (fault === 'extra') return { ...response, memoryHistoryDescriptors: [...response.memoryHistoryDescriptors,
        { ...response.memoryHistoryDescriptors[0]!, id: 'unrequested_history_descriptor', dependencies: [] }] };
      // Fault the metadata-only transport after an actual SQLite read. Neither
      // a missing edge nor a self-cycle may become a completed root witness.
      return { ...response, memoryHistoryDescriptors: response.memoryHistoryDescriptors.map(descriptor => descriptor.id === h.notes[0]!.id
        ? { ...descriptor, dependencies: [{ id: fault === 'cycle' ? descriptor.id : 'missing_exact_dependency', contentRevision: descriptor.contentRevision }] } : descriptor) };
    });
    await expect(withCompanionExecutionValidation(async () => {
      await preloadCompanionMemoryFileContexts([{ companionId: 'alice', contexts: [h.context] }], { identity: port, request: port.request });
      return h.host.memoryContextValid(h.f.scope, h.context);
    })).rejects.toThrow(fault === 'cycle' ? '环路' : fault === 'extra' ? '额外修订' : '缺少准确修订');
    expect(h.validate).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await h.f.close(); }
});

it.each(['external-history-SQL', 'same-stat-bytes'] as const)('retains prefetched authority fences across other-owner and external-asset work: %s', async change => {
  const h = await fixture();
  try {
    const bobScope = { companionId: 'bob', conversationId: h.f.store.openPrivate('bob').id }, source = h.f.source('Bob 独立真实来源。', 'bob');
    const note = h.f.store.request({ type: 'memory.record', ...bobScope, candidate: h.f.candidate('Bob 独立正式正文。', [source.id]) }).memories![0]!;
    h.f.index(); await h.f.publish('bob'); const registry = await h.f.artifacts('bob');
    const reader = registry as unknown as { bytes(relative: string, stamp?: (value: string) => void): Promise<Buffer> }, actual = reader.bytes.bind(reader);
    let initial = true, bobFinal = false, assetInitial = false, assetFinal = false;
    const bytes = vi.spyOn(reader, 'bytes').mockImplementation(async (...args) => { const result = await actual(...args); if (!initial) bobFinal = true; return result; });
    await expect(withCompanionExecutionValidation(async () => {
      await preloadCompanionMemoryFileContexts([{ companionId: 'alice', contexts: [h.context] }], { identity: sqlPort(h), request: sqlPort(h).request });
      expect(await h.host.memoryContextValid(h.f.scope, h.context)).toBe(true);
      await registry.read({ artifactId: 'memory:' + note.id, consumer: 'audit' }); initial = false;
      await memoCompanionExecutionAdmission('actual-external-asset-boundary', { identity: {}, read: async () => { assetInitial = true; return true; }, cacheable: () => true,
        verify: async () => {
          expect(bobFinal).toBe(true); assetFinal = true;
          if (change === 'external-history-SQL') h.sql(db => db.prepare("UPDATE companion_memory_history_files SET state='retracted' WHERE companion_id=? AND note_id=?").run('alice', h.notes[0]!.id));
        } });
      // File bytes have their final fence before asset-final/SQL-final. Mutate
      // after the other owner and asset initial reads, before that file fence.
      if (change === 'same-stat-bytes') { const file = h.f.noteFile(h.notes[0]!), before = await stat(file);
        await writeFile(file, h.notes[0]!.content.replace('准确', '篡改')); await utimes(file, before.atime, before.mtime); }
    })).rejects.toThrow();
    expect(assetInitial).toBe(true);
    if (change === 'external-history-SQL') expect(assetFinal).toBe(true);
    expect(h.validate).toHaveBeenCalledOnce(); bytes.mockRestore();
  } finally { await h.f.close(); }
});

it('keeps an unrelated healthy message readable when a prefetched second root becomes invalid before consumption', async () => {
  const h = await fixture();
  try {
    const badSource = h.f.source('独立的 B 来源，将在批量查询之后撤回。'), bad = h.f.record('B 的独立事实。', [badSource.id]); await h.f.publish();
    const badReceipt = (await h.f.live.materialize('alice', [bad])).receipts[0]!;
    const contextA = { ...h.context, fileReceipts: [h.receipts[0]!] }, contextB = { ...h.context, fileReceipts: [badReceipt] };
    const readset = (note: typeof bad, context: Context): CompanionExecutionReadset => ({ schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...h.f.scope,
      memories: [], frozenMemories: [{ id: note.id, contentRevision: note.contentRevision!, sources: note.sources.map(source => ({ id: source.messageId,
        conversationId: source.conversationId, checksum: source.checksum, revision: source.revision })) }], sources: [], contexts: [context], knowledgeReads: [], topics: [] });
    const a = h.f.store.appendMessage({ conversationId: h.f.scope.conversationId, authorId: 'alice', content: 'A 的合法正式回复。', executionReadset: readset(h.notes[0]!, contextA) });
    const b = h.f.store.appendMessage({ conversationId: h.f.scope.conversationId, authorId: 'alice', content: 'B 旧回复必须撤回。', executionReadset: readset(bad, contextB) });
    const command = { type: 'messages' as const, conversationId: h.f.scope.conversationId, limit: 50 };
    const raw = async (input: CompanionStorageCommand) => h.f.store.request(input); let prefetched = false;
    const result = await withCompanionExecutionValidation(() => guardCompanionExecutionSources(command, h.f.store.request(command), {
      identity: sqlPort(h), revision: () => 0, storage: raw,
      prepareFileContexts: async proofs => {
        await preloadCompanionMemoryFileContexts(proofs.map(proof => ({ companionId: proof.companionId, contexts: proof.executionReadset?.contexts ?? [] })),
          { identity: sqlPort(h), request: sqlPort(h).request });
        prefetched = true; expect(h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [badSource.id] }).ok).toBe(true);
      },
      // The real SQL frozen-source predicate rejects B before its file context
      // can consume the prefetched witness; A follows the normal canonical gate.
      valid: proof => verifyCompanionExecutionReadset(proof.executionReadset, proof, { request: raw,
        contextValid: (scope, context) => h.host.memoryContextValid(scope, context as Context) }),
    }));
    expect(prefetched).toBe(true);
    expect(result.messages?.find(message => message.id === a.id)?.content).toBe(a.content);
    expect(result.messages?.find(message => message.id === b.id)?.content).toBe('');
    expect(h.authorityCommands.filter(command => command.type === 'memory.revisions.describe').at(-1)).toMatchObject({ roots: [{ id: h.notes[0]!.id }] });
  } finally { await h.f.close(); }
});

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
