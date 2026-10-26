import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources, type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { buildCompanionContext } from '../../src/main/companions/context';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMessage } from '../../src/shared/companions';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

let root: string, file: string, store: CompanionsStore, scope: { companionId: string; conversationId: string };
const seeds = [{ id: 'alice', name: 'Alice', description: '', persona: '认真核验', model: '', avatar: 'sister' as const, active: true, proactive: false }];
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-source-closure-')); file = path.join(root, 'state.sqlite');
  store = new CompanionsStore(file, seeds); scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
});
afterEach(() => {
  store.close(); const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-source-closure-')) throw new Error('Unexpected owned fixture path');
  removeOwnedDirectorySync(resolved);
});
const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store.request(command);
function index() {
  for (let count = 0; count < 100; count++) {
    const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (!job) return;
    store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
  }
  throw new Error('Unexpected unbounded fixture index');
}
function record(source: CompanionMessage) {
  const note = store.request({ type: 'memory.record', ...scope, candidate: { content: 'HOST_ONLY_COLD_FACT', tags: ['合成执行结果'], sourceMessageIds: [source.id],
    evidence: [{ sourceMessageId: source.id, quote: 'HOST_ONLY_COLD_FACT' }] } }).memories![0]!;
  index(); return note;
}
function complete() {
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '根据资料执行任务。', replyDirective: 'none' });
  const executionReadset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ messages: [source] }) } });
  const action = store.request({ type: 'action.create', action: { ...scope, sourceMessageId: source.id, title: '合成任务', status: 'queued' },
    checkpoint: { prompt: '完成合成任务。', executionReadset } }).action!;
  store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: 'HOST_ONLY_COLD_FACT' } });
  const evidence = store.request({ type: 'messages', conversationId: scope.conversationId }).messages!.find(message => message.actionId === action.id)!;
  expect(evidence).toBeDefined(); return { source, action, evidence, executionReadset };
}

it('captures the actual buildCompanionContext dialogue bytes and rejects the readset after their source is withdrawn', async () => {
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '真实上下文中的逐字资料。', replyDirective: 'none' });
  const context = buildCompanionContext({ companion: store.state().companions[0]!, conversation: store.openPrivate(scope.companionId), messages: [source], sourceMessage: source, memories: [] });
  const serialized = JSON.parse(context.user) as { messages: Array<{ id: string; conversationId: string; content: string }> };
  expect(serialized.messages).toContainEqual(expect.objectContaining({ id: source.id, conversationId: scope.conversationId, content: source.content }));
  const captured = captureCompanionExecutionReadset(scope, { context });
  expect(captured.complete).toBe(true); expect(captured.sources.map(source => source.id)).toContain(source.id);
  expect(await verifyCompanionExecutionReadset(captured, scope, { request })).toBe(true);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id] });
  expect(await verifyCompanionExecutionReadset(captured, scope, { request })).toBe(false);
});

it('retires an actual action-result diary and changes its real snapshot revision when Main rejects an asynchronous dependency', async () => {
  const { action, evidence } = complete(), note = record(evidence);
  const command = { type: 'memory.snapshot', ...scope } as const;
  const original = store.request(command);
  expect(original.memorySnapshot!.notes.map(note => note.id)).toEqual([note.id]);
  const observed: CompanionExecutionSourceProof[] = [];
  const result = await guardCompanionExecutionSources(command, original, { storage: request, valid: async proof => { observed.push(proof); return false; } });
  expect(observed.map(proof => [proof.kind, proof.id])).toContainEqual(['action', action.id]);
  expect(result.memorySnapshot!.notes).toEqual([]); expect(result.memorySnapshot!.revision).not.toBe(original.memorySnapshot!.revision);
  expect(store.request({ type: 'memory.records.filter', ...scope, ids: [note.id] }).memories).toEqual([]);
  expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [evidence.id] }).memorySources).toEqual([]);
  expect(store.getAction(action.id)).toMatchObject({ status: 'succeeded', result: 'HOST_ONLY_COLD_FACT', contentAvailable: false, canResume: false });
  expect(store.request({ type: 'actions.page', conversationId: scope.conversationId }).actionPage!.items[0]).toMatchObject({ contentAvailable: false, canResume: false });
  store.close(); store = new CompanionsStore(file, seeds);
  expect(store.getAction(action.id)).toMatchObject({ status: 'succeeded', contentAvailable: false, canResume: false });
});

it('binds the final loop proof atomically and follows it when a derived ordinary reply becomes a diary', async () => {
  const { evidence } = complete();
  const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ messages: [evidence] }) } });
  const bubble = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
  const checkpoint = { ...scope, sourceMessageId: evidence.id, messageId: bubble.id, status: 'done' as const, turns: [{ text: 'HOST_ONLY_COLD_FACT', rawText: 'HOST_ONLY_COLD_FACT', calls: [] }] };
  expect(store.request({ type: 'loop.save', checkpoint, executionReadset: readset }).ok).toBe(true);
  const published = store.getMessage(bubble.id), note = record(published);
  const resolved = store.request({ type: 'execution.sources', sourceMessageIds: [published.id] }).executionSources!;
  expect(resolved.map(proof => proof.kind)).toEqual(['message', 'action']);
  const result = await guardCompanionExecutionSources({ type: 'memory.snapshot', ...scope }, store.request({ type: 'memory.snapshot', ...scope }), {
    storage: request, valid: proof => proof.kind === 'action' ? Promise.resolve(false) : verifyCompanionExecutionReadset(proof.executionReadset, proof, { request }),
  });
  expect(result.memorySnapshot!.notes.some(item => item.id === note.id)).toBe(false);
  expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [published.id] }).memorySources).toEqual([]);
});

it.each(['revise', 'forget'] as const)('retains an actual focused file-backed reply through soft changes, then honors the real source withdrawal after %s', async change => {
  const parentSource = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'group0 PARENT_FACT', replyDirective: 'none' });
  const parent = store.request({ type: 'memory.record', ...scope, candidate: { content: parentSource.content, tags: ['group0'], sourceMessageIds: [parentSource.id], evidence: [{ sourceMessageId: parentSource.id, quote: parentSource.content }] } }).memories![0]!;
  const parentRevision = parent.contentRevision;
  if (parentRevision === undefined) throw new Error('The canonical parent fixture requires its real content revision.');
  index();
  const canonical = await canonicalMemoryFiles(root, store, { apiFormat: 'openai_chat', model: 'controlled-local-focusing', apiKey: 'controlled-key', baseUrl: 'https://fixture.invalid' });
  const fileRequest = canonical.request, native = await nativeManagementHarness(root, fileRequest, { chatReply: '核验后的 PARENT_FACT。' });
  let profileKey = 'profile-one';
  const service = new CompanionMemoryService({ request: fileRequest, runtime: controlledMemoryRuntime({ get: async () => ({ client: native.client, profileKey }), close: () => native.client.close() }),
    configFor: canonical.configFor, fetchFn: fetch, busy: () => true, changed: () => undefined, report: () => undefined,
    prepareFiles: owner => canonical.library.prepareOwnerFiles(owner), validateFiles: (owner, receipts, window) => canonical.live.validate(owner, receipts, window),
    ...canonical.projection });
  try {
    const actual = await service.search({ ...scope, query: 'group0 parent fact' }, 'passive');
    expect(actual.memoryContext?.evidence?.dependencies).toEqual([{ id: parent.id, version: parent.version }]);
    expect(actual.memoryContext?.evidence?.dependencyCoverage).toBe('complete');
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请核对 parent fact。', replyDirective: 'none' });
    const context = buildCompanionContext({ companion: store.state().companions[0]!, conversation: store.openPrivate('alice'), sourceMessage: source, messages: [source], memories: [],
      memoryRecall: { context: actual.memoryContext, reasons: [], pending: false, degraded: false } });
    const readset = captureCompanionExecutionReadset(scope, { context });
    expect(actual.memoryContext!.fileReceipts?.length).toBeGreaterThan(0);
    expect(readset.contexts).toEqual([expect.objectContaining({ fileReceiptOnly: true, fileReceipts: actual.memoryContext!.fileReceipts })]);
    expect(readset.frozenMemories).toEqual([expect.objectContaining({ id: parent.id, contentRevision: parentRevision })]);
    const bubble = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
    store.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: source.id, messageId: bubble.id, status: 'done', turns: [{ text: 'group0 PARENT_FACT', rawText: 'group0 PARENT_FACT', calls: [] }] }, executionReadset: readset });
    const published = store.getMessage(bubble.id);
    const derived = store.request({ type: 'memory.record', ...scope, candidate: { content: published.content, tags: ['derived'], relatedMemoryIds: [parent.id], sourceMessageIds: [published.id], evidence: [{ sourceMessageId: published.id, quote: published.content }] } }).memories![0]!;
    const derivedRevision = derived.contentRevision;
    if (derivedRevision === undefined) throw new Error('The derived fixture requires its real immutable content revision.');
    const unrelated = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'A genuinely unrelated garden entry.', replyDirective: 'none' });
    store.request({ type: 'memory.record', ...scope, candidate: { content: unrelated.content, sourceMessageIds: [unrelated.id], evidence: [{ sourceMessageId: unrelated.id, quote: unrelated.content }] } });
    index(); profileKey = 'profile-two';
    await canonical.publish(scope.companionId);
    const historicalDerivedFiles = (await canonical.live.materialize(scope.companionId, [derived])).receipts;
    // This is the immutable prepared task, not a demand to rerun RAG after
    // unrelated additions or an embedding/model route change.
    expect(await service.contextFresh(scope, actual.memoryContext)).toBe(true);
    const valid = (proof: CompanionExecutionSourceProof) => verifyCompanionExecutionReadset(proof.executionReadset, proof, { request: fileRequest, contextValid: (scope, context) => service.contextValid(scope, context) });
    const read = () => guardCompanionExecutionSources({ type: 'memory.snapshot', ...scope }, store.request({ type: 'memory.snapshot', ...scope }), { storage: request, valid });
    expect((await read()).memorySnapshot!.notes.some(note => note.id === derived.id)).toBe(true);
    expect((await guardCompanionExecutionSources({ type: 'memory.sources.filter', ...scope, ids: [published.id] }, store.request({ type: 'memory.sources.filter', ...scope, ids: [published.id] }), { storage: request, valid })).memorySources?.map(source => source.id)).toContain(published.id);
    if (change === 'forget') store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [parentSource.id] });
    else {
      const revised = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'group0 REVISED_PARENT_FACT', replyDirective: 'none' });
      const revisedParent = store.request({ type: 'memory.revise', ...scope, id: parent.id, expectedVersion: parent.version, candidate: { content: revised.content, sourceMessageIds: [revised.id], evidence: [{ sourceMessageId: revised.id, quote: revised.content }] } }).memories![0]!;
      expect((await canonical.history.read(scope, parent.id, parentRevision)).content).toBe(parent.content);
      // A latest derived entry tied to the superseded body is retired from
      // current views. Its genuine old task/history receipts still survive.
      expect((await read()).memorySnapshot!.notes.some(note => note.id === derived.id)).toBe(false);
      expect(() => store.request({ type: 'memory.read', ...scope, id: derived.id })).toThrow('来源失效');
      expect((await canonical.history.read(scope, derived.id, derivedRevision)).content).toBe(derived.content);
      expect(await canonical.live.validate(scope.companionId, historicalDerivedFiles)).toBe(true);
      expect(await service.contextValid(scope, actual.memoryContext)).toBe(true);
      index();
      const fresh = await service.search({ ...scope, query: 'group0 parent fact' }, 'passive');
      expect(fresh.memoryContext?.evidence?.dependencyCoverage).toBe('complete');
      expect(fresh.memoryContext?.evidence?.dependencies).toContainEqual({ id: parent.id, version: revisedParent.version });
      expect(fresh.memoryContext?.evidence?.dependencies?.map(note => note.id)).not.toContain(derived.id);
      store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [parentSource.id] });
    }
    expect((await read()).memorySnapshot!.notes.some(note => note.id === derived.id)).toBe(false);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [published.id] }).memorySources).toEqual([]);
    expect(await service.contextValid(scope, actual.memoryContext)).toBe(false);
    expect(await canonical.live.validate(scope.companionId, historicalDerivedFiles)).toBe(false);
    expect(() => store.request({ type: 'memory.read', ...scope, id: derived.id })).toThrow('来源失效');
    await expect(canonical.history.read(scope, parent.id, parentRevision)).rejects.toThrow();
    await expect(canonical.history.read(scope, derived.id, derivedRevision)).rejects.toThrow();
  } finally { await service.close(); await native.close(); await canonical.close(); }
}, 120000);

it('rejects an obsolete proof at final publication and reports malformed legacy checkpoint proof without pretending to verify it', () => {
  const { action, source, executionReadset, evidence } = complete();
  const bubble = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: 'Existing draft', loopStep: 0 });
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id] });
  expect(() => store.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: source.id, messageId: bubble.id, status: 'done',
    turns: [{ text: 'HOST_ONLY_COLD_FACT', rawText: 'HOST_ONLY_COLD_FACT', calls: [] }] }, executionReadset })).toThrow('提交前已经变化');
  expect(store.getMessage(bubble.id).content).toBe('Existing draft');
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(file);
  try {
    const legacy = { ...executionReadset } as Partial<typeof executionReadset>; delete legacy.topics;
    db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ prompt: 'Legacy', executionReadset: legacy }), 'task-checkpoint/' + action.id);
  } finally { db.close(); }
  const resolved = store.request({ type: 'execution.sources', sourceMessageIds: [evidence.id] }).executionSources!;
  expect(resolved).toHaveLength(1); expect(resolved[0]!.executionReadset).toBeUndefined();
});

it('keeps an invalidated failed effect in history while refusing worker resume and exposing its permanent flag on updates', () => {
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '尝试合成计算。', replyDirective: 'none' });
  const executionReadset = captureCompanionExecutionReadset(scope);
  const action = store.request({ type: 'action.create', action: { ...scope, sourceMessageId: source.id, title: '合成失败任务', status: 'queued' }, checkpoint: { prompt: source.content, executionReadset } }).action!;
  store.request({ type: 'action.update', id: action.id, patch: { status: 'failed', error: 'Actual failed effect' } });
  expect(store.getAction(action.id).canResume).toBe(true);
  store.request({ type: 'execution.invalidate', kind: 'action', id: action.id, companionId: scope.companionId });
  expect(() => store.request({ type: 'action.resume', id: action.id })).toThrow('没有可用的恢复记录');
  expect(store.request({ type: 'action.update', id: action.id, patch: { stage: 'Actual failure retained' } }).action).toMatchObject({ status: 'failed', error: 'Actual failed effect', contentAvailable: false, canResume: false });
});

it.each(['indexed', 'leased'] as const)('settles a derived-action %s outbox and removes its native row using a sanitized deletion receipt', async state => {
  const { action, evidence } = complete();
  const note = store.request({ type: 'memory.record', ...scope, candidate: { content: 'group0 HOST_ONLY_COLD_FACT', tags: ['合成来源'], sourceMessageIds: [evidence.id],
    evidence: [{ sourceMessageId: evidence.id, quote: 'HOST_ONLY_COLD_FACT' }] } }).memories![0]!;
  const native = await nativeManagementHarness(root, request);
  try {
    const claim = { type: 'memory.outbox.claim' } as const, remember = store.request(claim);
    if (state === 'indexed') {
      await native.client.remember(remember.memoryOutbox!, { id: note.id, content: note.content, tags: note.tags });
      store.request({ type: 'memory.outbox.complete', id: remember.memoryOutbox!.id, leaseToken: remember.memoryOutbox!.leaseToken, indexed: true });
      expect((await native.client.search({ scopeId: note.scopeId }, { text: 'group0', topK: 8 })).results.map(hit => hit.id)).toContain(note.id);
      store.request({ type: 'execution.invalidate', kind: 'action', id: action.id, companionId: scope.companionId });
    } else {
      const revoked = await guardCompanionExecutionSources(claim, { ...remember, memoryInvalidatedCompanionIds: ['another_owner'], memoryInvalidatedScopeIds: ['another_scope'] }, { storage: request, valid: async () => false });
      expect(revoked.memoryOutbox).toBeUndefined();
      expect(revoked.memoryInvalidatedCompanionIds).toContain('another_owner'); expect(revoked.memoryInvalidatedScopeIds).toContain('another_scope');
    }
    const validate = vi.fn(async () => false);
    const removal = (await guardCompanionExecutionSources(claim, store.request(claim), { storage: request, valid: validate })).memoryOutbox!;
    expect(removal).toMatchObject({ operation: 'forget', noteId: note.id, maintenanceOnly: true, contentAvailable: false });
    expect(removal.note.sources).toEqual([]); expect(removal.note.tags).toEqual([]); expect(removal.note.metadata).toBeUndefined();
    expect(JSON.stringify(removal)).not.toContain('HOST_ONLY_COLD_FACT'); expect(validate).not.toHaveBeenCalled();
    await native.client.forget(removal, removal.noteId);
    store.request({ type: 'memory.outbox.complete', id: removal.id, leaseToken: removal.leaseToken, indexed: true });
    expect(store.request(claim).memoryOutbox).toBeUndefined();
    expect((await native.client.search({ scopeId: note.scopeId }, { text: 'group0', topK: 8 })).results).toEqual([]);
  } finally { await native.close(); }
}, 120000);
