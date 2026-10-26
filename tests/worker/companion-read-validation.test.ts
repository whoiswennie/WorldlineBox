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

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Context = { revision: string; profileKey: string };
let root: string, store: CompanionsStore, memory: CompanionMemoryService;
let host: { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse>; memoryContextValid(scope: Scope, context: Context): Promise<boolean>; sourceValidationRevision: number };
let scope: Scope, commands: CompanionStorageCommand[], metadataReads: number;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-read-validation-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '核验资料', model: '', avatar: 'sister', active: true, proactive: false }]);
  scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  commands = []; metadataReads = 0;
  const instance = Object.create(CompanionService.prototype);
  host = instance;
  memory = new CompanionMemoryService({ request: command => host.call(command),
    runtime: { describeEmbedding: async () => { metadataReads++; return { profileKey: 'fixture-profile' }; },
      get: async () => { throw new Error('A history read must not start native indexing or generation'); }, close: async () => undefined },
    configFor: async () => { throw new Error('A history read must not request a chat model'); },
    fetchFn: async () => { throw new Error('A history read must not call a model'); }, busy: () => true, changed: () => undefined,
    report: error => { throw error; } });
  Object.assign(instance, { storage: { request: async (command: CompanionStorageCommand) => { commands.push(command); return store.request(command); } },
    memory, sourceValidationRevision: 0, evidenceRevision: 0, options: { report: (error: unknown) => { throw error; } } });
});

afterEach(async () => {
  await memory.close(); store.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-read-validation-')) throw new Error('Invalid owned fixture cleanup');
  removeOwnedDirectorySync(root);
});

function context(): Context {
  return { revision: store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.revision, profileKey: 'fixture-profile' };
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
