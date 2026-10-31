import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionMemoryLibrary, companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionsStore } from '../../src/companions/store';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { companionMemoryFileReceiptsSchema, type CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));

type Fixture = ReturnType<typeof managedMemoryFiles>;
interface BenchmarkHost {
  call(command: CompanionStorageCommand, signal?: AbortSignal, origin?: 'memory-files'): Promise<CompanionStorageResponse>;
  memory: CompanionMemoryService;
  assetProfiles: CompanionAssetProfileStore;
  requireCurrentAssets(owner: string): Promise<void>;
  memoryFilesValid(owner: string, receipts: readonly CompanionMemoryFileReceipt[], window?: object): Promise<boolean>;
  memoryContextValid(...args: Parameters<CompanionMemoryService['contextValid']>): Promise<boolean>;
}

/** Frozen pre-batching algorithm. Kept here only to measure the same real
 * SQLite and canonical files against both algorithms; no user library opens. */
async function sequentialBaseline(fixture: Pick<Fixture, 'library' | 'history'>, receipts: readonly CompanionMemoryFileReceipt[], owner = 'alice'): Promise<boolean> {
  const input = companionMemoryFileReceiptsSchema.safeParse(receipts);
  if (!input.success || input.data.some(receipt => receipt.companionId !== owner)) return false;
  try { return await withCompanionExecutionValidation(() => fixture.library.withDocuments(owner, async session => {
    for (const receipt of input.data) {
      const registered = await session.registry.get(`memory:${receipt.noteId}`, true);
      if (!registered || registered.relativePath !== receipt.path) return false;
      const current = registered.publicationState === 'committed' ? await session.registry.read({ artifactId: registered.artifactId, consumer: 'audit' }) : undefined;
      const actual = (await session.request({ type: 'memory.library.read', companionId: owner, id: receipt.noteId })).memoryRead?.memory;
      if (actual?.contentRevision === receipt.contentRevision && current?.artifact.contentHash === receipt.contentHash) {
        if (actual.companionId !== session.owner.id || !actual.contentRevision
          || current.artifact.kind !== actual.artifactKind || current.artifact.relativePath !== companionMemoryRegisteredPath(actual)
          || current.text !== actual.content) return false;
        for (const reference of current.artifact.sourceRefs) await session.registry.read({ artifactId: reference.artifactId,
          consumer: 'source_verification', audienceIds: [actual.sourceConversationId] });
        continue;
      }
      const scope = (await session.request({ type: 'memory.library.scope.read', companionId: owner })).conversation;
      if (!scope) return false;
      const history = await fixture.history.readInSession(session, { companionId: owner, conversationId: scope.id }, receipt.noteId, receipt.contentRevision);
      if (createHash('sha256').update(history.content).digest('hex') !== receipt.contentHash) return false;
    }
    return true;
  }, { readOnly: true, sourceDelivery: true })); } catch { return false; }
}

function operations(commands: readonly CompanionStorageCommand[]) {
  const counts: Record<string, number> = {};
  for (const command of commands) counts[command.type] = (counts[command.type] ?? 0) + 1;
  return { total: commands.length, counts };
}

const enabled = process.env.WORLDLINEBOX_MEMORY_VALIDATION_BENCHMARK === '1';
it.skipIf(!enabled)('compares canonical-file validation against the previous sequential algorithm', async () => {
  const fixture = managedMemoryFiles();
  try {
    // Read-only aggregate inspection of the affected library found ten notes,
    // sixteen unique sources and twenty-two edges. This fixture matches those
    // counts, but contains synthetic prose and no private source or key data.
    const sources = Array.from({ length: 16 }, (_, index) => fixture.source(`Synthetic source ${index}: verified observation.`));
    const membership = [[0, 1, 2, 3], [2, 3, 4, 5], [6], [7], [8], [9], [10], [11], [10, 11, 12, 13, 14, 15], [13, 15]];
    const notes = membership.map((indices, index) => fixture.record(`Synthetic memory ${index}: canonical episode.`, indices.map(id => sources[id]!.id)));
    await fixture.publish();
    const { receipts } = await fixture.live.materialize('alice', notes);
    const samples = [];
    for (let round = 0; round < 3; round++) for (const algorithm of round % 2 ? ['current', 'sequential'] as const : ['sequential', 'current'] as const) {
      fixture.commands.length = 0;
      const start = performance.now();
      const valid = algorithm === 'sequential' ? await sequentialBaseline(fixture, receipts) : await fixture.live.validate('alice', receipts);
      const durationMs = performance.now() - start;
      expect(valid).toBe(true);
      samples.push({ round, algorithm, durationMs, ...operations(fixture.commands) });
    }
    const report = { schema: 'worldlinebox.memory-validation-benchmark-v1', generatedAt: new Date().toISOString(),
      fixture: { notes: 10, uniqueSources: 16, sourceEdges: 22, realSqlite: true, realCanonicalFiles: true, syntheticText: true },
      limitations: ['Isolates the file validation layer; it does not reproduce service execution-source DAG expansion, encoder work, network inference or complete reply latency.',
        'Alternating sequential runs on the same temporary corpus; wall time depends on Windows filesystem cache and concurrent host load.'], samples };
    const output = path.resolve('artifacts/memory-latency-20261030/validation-benchmark.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.info(JSON.stringify(report));
  } finally { await fixture.close(); }
}, 120000);

const sourceLibrary = process.env.WORLDLINEBOX_MEMORY_VALIDATION_SOURCE_LIBRARY;
it.skipIf(!enabled || !sourceLibrary)('measures the production host DAG on an isolated SQLite backup and copied registered files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-memory-validation-backup-'));
  let store: CompanionsStore | undefined;
  const libraries: CompanionMemoryLibrary[] = [];
  try {
    execFileSync('python', [path.resolve('tests/fixtures/clone-memory-library.py'), sourceLibrary!, root], { stdio: 'pipe' });
    store = new CompanionsStore(path.join(root, 'messages.sqlite'));
    const owner = store.state().companions.find(item => store!.request({ type: 'memory.library.page', companionId: item.id, limit: 100 }).memoryPage?.items.length)?.id;
    if (!owner) throw new Error('The copied library has no canonical memories.');
    const notes = store.request({ type: 'memory.library.page', companionId: owner, limit: 100 }).memoryPage!.items.map(hit => hit.memory);
    const commands: CompanionStorageCommand[] = [];
    const raw = async (command: CompanionStorageCommand) => { commands.push(command); return store!.request(command); };
    const samples = [];
    // Prototype methods are the real service call, context and action proof
    // gates. The UI scheduler, model network and publishers never start.
    for (const algorithm of ['baseline', 'current'] as const) {
      const host = Object.assign(Object.create(CompanionService.prototype), { options: { report: () => undefined },
        storage: { request: raw }, closed: false, resettingCompanions: new Set(), dormantCompanions: new Set(),
        sourceValidationRevision: 0, evidenceRevision: 0, assetValidations: new Map(), assetProfileFailures: new Map(),
        assetIo: { run: <T>(work: () => Promise<T>) => work() } }) as BenchmarkHost;
      host.assetProfiles = new CompanionAssetProfileStore(path.join(root, 'owners'), { registryStorage: { request: raw },
        initialized: async id => (await raw({ type: 'companion.assets.initialized', companionId: id })).assetProfileInitialized === true });
      const library = new CompanionMemoryLibrary({ libraryDirectory: path.join(root, 'owners'),
        artifacts: async id => new CompanionArtifactRegistry(path.join(root, 'owners', id), id, { registryStorage: { request: raw } }),
        request: command => host.call(command, undefined, 'memory-files') });
      libraries.push(library);
      const history = new CompanionMemoryHistoryFiles({ library }), live = new CompanionMemoryLiveFiles({ library, history });
      Object.assign(host, { memoryLibrary: library, historyFiles: history, liveFiles: live });
      const memory = new CompanionMemoryService({ request: command => host.call(command), cacheRoot: path.join(root, algorithm + '-cache'),
        fetchFn: async () => { throw new Error('Offline validation benchmark forbids model/network requests.'); },
        configFor: async () => ({ apiFormat: 'openai_chat', model: 'unused-offline-benchmark', apiKey: 'unused' }),
        validateAssets: id => host.requireCurrentAssets(id), validateFiles: (id, receipts, window) => host.memoryFilesValid(id, receipts, window),
        busy: () => true, changed: () => undefined, report: () => undefined });
      host.memory = memory;
      if (algorithm === 'baseline') {
        host.memoryFilesValid = (id: string, receipts: readonly CompanionMemoryFileReceipt[]) => sequentialBaseline({ library, history }, receipts, id);
        host.memoryContextValid = (scope, context) => memory.contextValid(scope, context);
      }
      try {
        const registry = await library.withDocuments(owner, async session => session.registry, { readOnly: true });
        const artifacts = await registry.getMany(notes.map(note => `memory:${note.id}`));
        const receipts = notes.map(note => { const artifact = artifacts.find(value => value.artifactId === `memory:${note.id}`)!;
          return { companionId: owner, noteId: note.id, contentRevision: note.contentRevision!, path: artifact.relativePath, contentHash: artifact.contentHash }; });
        commands.length = 0;
        const started = performance.now();
        const valid = await withCompanionExecutionValidation(() => host.memoryFilesValid(owner, receipts));
        const durationMs = performance.now() - started;
        samples.push({ stage: 'file_gate', algorithm, valid, durationMs, ...operations(commands) });
        console.info(JSON.stringify({ benchmark: 'copied-production-dag', algorithm, valid, durationMs, ...operations(commands) }));
        expect(valid).toBe(true);
        commands.length = 0;
        const historyStarted = performance.now();
        const history = await host.call({ type: 'messages', conversationId: notes[0]!.sourceConversationId, limit: 100 });
        const historyMs = performance.now() - historyStarted;
        expect(history.ok).toBe(true);
        samples.push({ stage: 'messages', algorithm, valid: history.ok, durationMs: historyMs, returnedMessages: history.messages?.length ?? 0, ...operations(commands) });
        console.info(JSON.stringify({ benchmark: 'copied-production-dag', stage: 'messages', algorithm, valid: history.ok,
          durationMs: historyMs, returnedMessages: history.messages?.length ?? 0, ...operations(commands) }));
      } finally { await memory.close(); }
    }
    const report = { schema: 'worldlinebox.memory-production-dag-benchmark-v1', generatedAt: new Date().toISOString(),
      fixture: { notes: notes.length, sources: new Set(notes.flatMap(note => note.sources.map(source => source.messageId))).size,
        sourceEdges: notes.reduce((count, note) => count + note.sources.length, 0), sqliteOnlineBackup: true, copiedRegisteredBodies: true,
        originalLibraryMutated: false, realHostCallAndContextValidation: true, realAssetProfileHydration: true, backgroundPublishersStarted: false, modelNetworkCalls: 0 },
      limitations: ['Offline prototype host omits live IPC transport, ongoing source mutations and unrelated background contention.',
        'The baseline freezes the previous sequential file gate and direct memory-context dispatch; both samples use the current SQL source verifier and host read-only mutation classification.'], samples };
    await writeFile(path.resolve('artifacts/memory-latency-20261030/production-dag-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  } finally { for (const library of libraries) await library.close(); store?.close(); await removeOwnedDirectory(root); }
}, 240000);
