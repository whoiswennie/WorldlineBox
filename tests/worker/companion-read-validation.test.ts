import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionMemoryKinds, COMPANION_MEMORY_SCOPE_MEANINGS } from '../../src/shared/companion-memory-scope';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
const typeScope = { schema: 'worldlinebox.memory-type-scope-v2' as const, consumer: 'facts' as const,
  contentKinds: companionMemoryKinds('facts'), meaning: COMPANION_MEMORY_SCOPE_MEANINGS.facts };
type Context = { revision: string; profileKey: string; typeScope: typeof typeScope };
let root: string, store: CompanionsStore, memory: CompanionMemoryService;
let host: { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse>; memoryContextValid(scope: Scope, context: Context): Promise<boolean>;
  memoryFilesValid(owner: string, receipts: readonly CompanionMemoryFileReceipt[]): Promise<boolean>; sourceValidationRevision: number };
let scope: Scope, commands: CompanionStorageCommand[], metadataReads: number;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-read-validation-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '核验资料', model: '', avatar: 'sister', active: true, proactive: false }]);
  scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  commands = []; metadataReads = 0;
  const instance = Object.create(CompanionService.prototype);
  host = instance;
  memory = new CompanionMemoryService({ request: command => host.call(command),
    validateFiles: (owner, receipts) => host.memoryFilesValid(owner, receipts),
    runtime: { describeEmbedding: async () => { metadataReads++; return { profileKey: 'fixture-profile' }; },
      get: async () => { throw new Error('A history read must not start native indexing or generation'); }, close: async () => undefined },
    configFor: async () => { throw new Error('A history read must not request a chat model'); },
    fetchFn: async () => { throw new Error('A history read must not call a model'); }, busy: () => true, changed: () => undefined,
    report: error => { throw error; } });
  Object.assign(instance, { storage: { request: async (command: CompanionStorageCommand) => { commands.push(command); return store.request(command); } },
    memory, resettingCompanions: new Set(), sourceValidationRevision: 0, evidenceRevision: 0, options: { report: (error: unknown) => { throw error; } } });
});

afterEach(async () => {
  await memory.close(); store.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-read-validation-')) throw new Error('Invalid owned fixture cleanup');
  removeOwnedDirectorySync(root);
});

function context(): Context {
  return { revision: store.request({ type: 'memory.snapshot', ...scope, contentKinds: typeScope.contentKinds }).memorySnapshot!.revision, profileKey: 'fixture-profile', typeScope };
}
const snapshotReads = () => commands.filter(command => command.type === 'memory.snapshot').length;

it('verifies seven real persisted reply contexts with one snapshot per actual history-page request', async () => {
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请核对这些实际资料。', replyDirective: 'none' });
  const current = context();
  for (let n = 0; n < 7; n++) {
    const bubble = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
    const readset = captureCompanionExecutionReadset(scope, { contexts: [current], context: { user: JSON.stringify({ messages: [source] }) } });
    expect(store.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: source.id, messageId: bubble.id, status: 'done',
      turns: [{ text: `经真实来源验证的答复 ${n}`, rawText: `经真实来源验证的答复 ${n}`, calls: [] }] }, executionReadset: readset }).ok).toBe(true);
  }
  // The original uncached verifier really performs seven SQLite snapshot reads.
  expect((await Promise.all(Array.from({ length: 7 }, () => memory.contextValid(scope, current)))).every(Boolean)).toBe(true);
  expect(snapshotReads()).toBe(7);
  commands.length = 0; metadataReads = 0;
  const page = await host.call({ type: 'messages', conversationId: scope.conversationId, limit: 50 });
  expect(page.messages?.filter(message => message.content.startsWith('经真实来源验证的答复'))).toHaveLength(7);
  expect(snapshotReads()).toBe(1); expect(metadataReads).toBe(1);
  await host.call({ type: 'messages', conversationId: scope.conversationId, limit: 50 });
  expect(snapshotReads()).toBe(2); expect(metadataReads).toBe(2);
});

it('keys actual snapshot validation by full scope/context and rechecks after a fenced storage write', async () => {
  const current = context();
  expect(await memory.contextValid(scope, { revision: current.revision, profileKey: current.profileKey })).toBe(false);
  expect(snapshotReads()).toBe(0);
  await withCompanionExecutionValidation(async () => {
    expect(await host.memoryContextValid(scope, current)).toBe(true);
    expect(await host.memoryContextValid(scope, current)).toBe(true);
    await host.call({ type: 'memory.tags.status', companionId: scope.companionId });
    await host.call({ type: 'routine.get', ...scope });
    expect(await host.memoryContextValid(scope, current)).toBe(true);
    expect(snapshotReads()).toBe(1);
    expect(await host.memoryContextValid({ ...scope, beforeSequence: 1 }, current)).toBe(false);
    expect(await host.memoryContextValid(scope, { ...current, revision: 'different-corpus' })).toBe(false);
    expect(snapshotReads()).toBe(3);
    await host.call({ type: 'conversation.read', id: scope.conversationId });
    expect(await host.memoryContextValid(scope, current)).toBe(true);
    expect(snapshotReads()).toBe(4);
  });
});

it('shares exact canonical files across distinct persisted historical contexts only during one page read', async () => {
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '核对旧答复的来源。', replyDirective: 'none' });
  const receipts: CompanionMemoryFileReceipt[] = [{ companionId: scope.companionId, noteId: 'shared_note', contentRevision: 1,
    path: '记忆/shared.txt', contentHash: 'a'.repeat(64) }];
  let available = true;
  const validate = vi.fn(async () => available);
  Object.assign(host, { liveFiles: { validate } });
  for (let n = 0; n < 8; n++) {
    const bubble = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
    const readset = captureCompanionExecutionReadset(scope, { contexts: [{ revision: 'historical-corpus-' + n, profileKey: 'historical-profile-' + n,
      beforeSequence: bubble.sequence, fileReceiptOnly: true, fileReceipts: n % 2 ? [...receipts, ...receipts] : receipts }],
    context: { user: JSON.stringify({ messages: [source] }) } });
    expect(store.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: source.id, messageId: bubble.id, status: 'done',
      turns: [{ text: '已核实的旧回复 ' + n, rawText: '已核实的旧回复 ' + n, calls: [] }] }, executionReadset: readset }).ok).toBe(true);
  }
  const page = await host.call({ type: 'messages', conversationId: scope.conversationId, limit: 50 });
  expect(page.messages?.filter(message => message.content.startsWith('已核实的旧回复'))).toHaveLength(8);
  expect(validate).toHaveBeenCalledOnce();
  await host.call({ type: 'messages', conversationId: scope.conversationId, limit: 50 });
  expect(validate).toHaveBeenCalledTimes(2);
  available = false;
  const withdrawn = await host.call({ type: 'messages', conversationId: scope.conversationId, limit: 50 });
  expect(withdrawn.messages?.some(message => message.content.startsWith('已核实的旧回复'))).toBe(false);
  expect(validate.mock.calls.length).toBeGreaterThan(2);
});

it('rechecks canonical files after a source mutation inside the same preparation', async () => {
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '将要撤回的原始依据。', replyDirective: 'none' });
  const receipts: CompanionMemoryFileReceipt[] = [{ companionId: scope.companionId, noteId: 'shared_note', contentRevision: 1,
    path: '记忆/shared.txt', contentHash: 'a'.repeat(64) }];
  let available = true;
  const validate = vi.fn(async () => available);
  Object.assign(host, { liveFiles: { validate } });
  await withCompanionExecutionValidation(async () => {
    expect(await host.memoryFilesValid(scope.companionId, receipts)).toBe(true);
    expect(await host.memoryFilesValid(scope.companionId, receipts)).toBe(true);
    expect(validate).toHaveBeenCalledOnce();
    available = false;
    await host.call({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id] });
    expect(await host.memoryFilesValid(scope.companionId, receipts)).toBe(false);
    expect(validate).toHaveBeenCalledTimes(2);
  });
});

it('checks each canonical file once when historical contexts contain overlapping file sets', async () => {
  const receipts = ['first_note', 'second_note', 'third_note'].map(noteId => ({ companionId: scope.companionId, noteId, contentRevision: 1,
    path: `记忆/${noteId}.txt`, contentHash: 'a'.repeat(64) }));
  const checked: string[] = [];
  Object.assign(host, { liveFiles: { validate: async (_owner: string, files: CompanionMemoryFileReceipt[]) => {
    checked.push(...files.map(file => file.noteId)); return true;
  } } });
  await withCompanionExecutionValidation(async () => {
    expect(await host.memoryFilesValid(scope.companionId, receipts.slice(0, 2))).toBe(true);
    expect(await host.memoryFilesValid(scope.companionId, receipts.slice(1))).toBe(true);
    expect(await host.memoryFilesValid(scope.companionId, [...receipts].reverse())).toBe(true);
    expect(checked).toEqual(['first_note', 'second_note', 'third_note']);
  });
  await host.memoryFilesValid(scope.companionId, receipts);
  expect(checked).toHaveLength(6);
});
