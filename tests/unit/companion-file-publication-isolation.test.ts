import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources,
  memoCompanionExecutionAuthorities, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
type PumpHost = { wakeMemoryFiles(owner: string): void; filePublicationPumps: Map<string, Promise<void>> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const f = managedMemoryFiles(), entered = deferred(), proceed = deferred(), assetIo = new CompanionAssetIo(), reports = vi.fn();
  const original = f.source('确实发生过的原始事件。');
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    memories: [], sources: [{ id: original.id, conversationId: original.conversationId,
      checksum: createHash('sha256').update(original.content).digest('hex') }], knowledgeReads: [], contexts: [], topics: [] };
  const derived = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '依据该原始事件形成的正式回复。', executionReadset: readset });
  const note = f.record('等待正式发布的有据记忆。', [derived.id]);
  const raw = vi.fn<Request>(async command => f.store.request(command));
  const valid = vi.fn<NonNullable<Parameters<typeof guardCompanionExecutionSources>[2]>['valid']>((proof, sqliteSourcesValidated) =>
    verifyCompanionExecutionReadset(proof.executionReadset, proof, { sqliteSourcesValidated, request: command => request(command) }));
  const request: Request = command => withCompanionExecutionValidation(async () => guardCompanionExecutionSources(command, await raw(command), {
    identity: f.store, storage: raw, revision: () => 0, valid,
    actionAuthorities: proofs => memoCompanionExecutionAuthorities(proofs, async selected => {
      const response = f.store.request({ type: 'execution.capabilities.validate', actions: selected.map(proof => ({ id: proof.id,
        companionId: proof.companionId, conversationId: proof.conversationId, ...(proof.capability ? { capability: proof.capability } : {}) })) });
      if (!response.ok || !response.capabilityAuthorityResults) throw new Error('Actual SQL action authorities were unavailable.');
      return new Map(response.capabilityAuthorityResults.map(result => [result.id, result.valid]));
    }, f.store),
  }));
  const library = new CompanionMemoryLibrary({ libraryDirectory: f.directory, artifacts: f.artifacts, request });
  const sources = new CompanionMemorySourceFiles({ library }), history = new CompanionMemoryHistoryFiles({ library, report: reports });
  const host = Object.assign(Object.create(CompanionService.prototype), { closed: false, resettingCompanions: new Set(),
    filePublicationPumps: new Map<string, Promise<void>>(), assetIo, options: { report: reports },
    sourceFiles: { flush: async (...args: Parameters<CompanionMemorySourceFiles['flush']>) => {
      entered.resolve(); await proceed.promise; return sources.flush(...args);
    } }, historyFiles: history, memory: { schedule: vi.fn() } }) as PumpHost;
  cleanups.push(async () => { proceed.resolve(); await assetIo.close(); await library.close(); await f.close(); });
  return { f, note, original, derived, host, request, raw, valid, reports, entered, proceed };
}

it.each(['sealed', 'closed-and-cancelled'] as const)('publishes a durable outbox after its originating frame is %s, with fresh SQL proof admission', async phase => {
  const t = fixture(), controller = new AbortController(), parent = createCompanionExecutionValidationSession(controller.signal);
  let admitted = 0;
  try {
    await parent.run(async () => {
      expect((await t.request({ type: 'memory.library.read', companionId: 'alice', id: t.note.id })).memoryRead?.memory.id).toBe(t.note.id);
      admitted = t.valid.mock.calls.length; expect(admitted).toBeGreaterThan(0);
      t.host.wakeMemoryFiles('alice'); await t.entered.promise;
    });
    await parent.validate();
    if (phase === 'closed-and-cancelled') { parent.close(); controller.abort(new DOMException('Originating reader stopped.', 'AbortError')); }
    const pump = t.host.filePublicationPumps.get('alice'); expect(pump).toBeDefined();
    t.proceed.resolve(); await pump;
    expect(t.reports).not.toHaveBeenCalled();
    // This is an actual source-backed Registry publication, not a mocked
    // completion callback. The parent's completed input proof was not reused.
    expect(t.valid.mock.calls.length).toBeGreaterThan(admitted);
    const artifact = await (await t.f.artifacts('alice')).read({ artifactId: `memory:${t.note.id}`, consumer: 'audit' });
    expect(artifact.text).toBe(t.note.content);
    expect(t.raw.mock.calls.some(([command]) => command.type === 'memory.history.outbox.complete')).toBe(true);
  } finally { parent.close(); }
});

it('does not carry an earlier successful source proof into the independent pump after actual withdrawal', async () => {
  const t = fixture(), parent = createCompanionExecutionValidationSession();
  try {
    await parent.run(async () => {
      expect((await t.request({ type: 'memory.library.read', companionId: 'alice', id: t.note.id })).memoryRead?.memory.id).toBe(t.note.id);
      t.host.wakeMemoryFiles('alice'); await t.entered.promise;
    });
    await parent.validate(); parent.close();
    const forgotten = t.f.store.request({ type: 'memory.forget', ...t.f.scope, sourceMessageIds: [t.original.id] }); expect(forgotten.ok).toBe(true);
    const pump = t.host.filePublicationPumps.get('alice'); expect(pump).toBeDefined(); t.proceed.resolve(); await pump;
    const result = await t.request({ type: 'message.get', id: t.derived.id });
    expect(result.message?.content).not.toBe(t.derived.content);
    expect((await t.request({ type: 'memory.library.read', companionId: 'alice', id: t.note.id })).memoryRead).toBeUndefined();
    const artifact = await (await t.f.artifacts('alice')).get(`memory:${t.note.id}`, true);
    expect(artifact?.publicationState).not.toBe('committed');
  } finally { parent.close(); }
});
