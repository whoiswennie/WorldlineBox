import { app } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { CompanionStorageClient } from '../../src/main/companions/storage-client';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryFileReadiness } from '../../src/main/companions/memory-file-readiness';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';

interface Host {
  call(command: CompanionStorageCommand, signal?: AbortSignal, origin?: 'memory-files'): Promise<CompanionStorageResponse>;
  memory: CompanionMemoryService; assetProfiles: CompanionAssetProfileStore;
  requireCurrentAssets(owner: string): Promise<void>;
  memoryFilesValid(owner: string, receipts: readonly CompanionMemoryFileReceipt[], window?: object): Promise<boolean>;
}
const root = process.env.WORLDLINEBOX_IPC_BENCH_ROOT!, workerPath = process.env.WORLDLINEBOX_IPC_BENCH_WORKER!, algorithm = process.env.WORLDLINEBOX_IPC_BENCH_ALGORITHM!;
if (!root || !workerPath || !algorithm) throw new Error('Missing isolated benchmark inputs.');
app.setPath('userData', path.join(root, 'electron-user-data')); app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  const counts: Record<string, number> = {}, slow: Array<{ operation: string; durationMs: number }> = [];
  const errors: string[] = [];
  let tickTimer: ReturnType<typeof setInterval> | undefined, ticking: Promise<void> | undefined;
  let library: CompanionMemoryLibrary | undefined, memory: CompanionMemoryService | undefined;
  let tickStarted = 0, tickCompleted = 0, foregroundCalls = 0, backgroundCalls = 0;
  const report: Record<string, unknown> = { schema: 'worldlinebox.actual-utility-ipc-memory-benchmark-v1', algorithm,
    actualElectronMain: true, actualUtilityProcessStorage: true, browserWindowsCreated: 0, modelNetworkCalls: 0,
    sourceLibraryMutated: false, tickIntervalMs: 500, timeoutMs: 30000 };
  const client = new CompanionStorageClient(workerPath, path.join(root, 'messages.sqlite'), () => undefined,
    error => { errors.push(error.name); });
  try {
    await client.start();
    const raw = async (command: CompanionStorageCommand) => { counts[command.type] = (counts[command.type] ?? 0) + 1;
      if (command.type === 'world.tick') backgroundCalls++; else foregroundCalls++;
      return client.request(command); };
    const host = Object.assign(Object.create(CompanionService.prototype), { options: { report: (error: Error) => errors.push(error.name),
      onTiming: (timing: { operation: string; durationMs: number }) => { if (!timing.operation.endsWith('.wait')) slow.push(timing); } },
      storage: { request: raw }, closed: false, resettingCompanions: new Set(), dormantCompanions: new Set(),
      sourceValidationRevision: 0, evidenceRevision: 0, assetValidations: new Map(), assetProfileFailures: new Map(),
      assetIo: new CompanionAssetIo() }) as Host;
    host.assetProfiles = new CompanionAssetProfileStore(path.join(root, 'owners'), { registryStorage: { request: raw },
      initialized: async id => (await raw({ type: 'companion.assets.initialized', companionId: id })).assetProfileInitialized === true });
    library = new CompanionMemoryLibrary({ libraryDirectory: path.join(root, 'owners'),
      artifacts: async id => new CompanionArtifactRegistry(path.join(root, 'owners', id), id, { registryStorage: { request: raw } }),
      request: command => host.call(command, undefined, 'memory-files') });
    const history = new CompanionMemoryHistoryFiles({ library }), live = new CompanionMemoryLiveFiles({ library, history }), sources = new CompanionMemorySourceFiles({ library });
    const fileReadiness = new CompanionMemoryFileReadiness({ library, sources, history,
      request: command => host.call(command, undefined, 'memory-files') });
    Object.assign(host, { memoryLibrary: library, historyFiles: history, liveFiles: live, sourceFiles: sources, fileReadiness });
    memory = host.memory = new CompanionMemoryService({ request: command => host.call(command), cacheRoot: path.join(root, 'views'),
      fetchFn: async () => { throw new Error('Offline benchmark forbids network/model requests.'); },
      configFor: async () => ({ apiFormat: 'openai_chat', model: 'unused-offline', apiKey: 'unused' }),
      validateAssets: id => host.requireCurrentAssets(id), validateFiles: (id, receipts, window) => host.memoryFilesValid(id, receipts, window),
      busy: () => true, changed: () => undefined, report: error => errors.push(error instanceof Error ? error.name : 'Unknown') });
    const state = (await raw({ type: 'state', includeConversations: false })).state;
    let owner: string | undefined, conversationId: string | undefined, noteCount = 0;
    let receipts: CompanionMemoryFileReceipt[] = [];
    for (const candidate of state?.companions ?? []) {
      const page = (await raw({ type: 'memory.library.page', companionId: candidate.id, limit: 100 })).memoryPage;
      if (page?.items.length) { owner = candidate.id; conversationId = page.items[0]!.memory.sourceConversationId; noteCount = page.items.length;
        const registry = await library.withDocuments(owner, async session => session.registry, { readOnly: true });
        const artifacts = await registry.getMany(page.items.map(hit => `memory:${hit.memory.id}`));
        receipts = page.items.flatMap(hit => { const artifact = artifacts.find(value => value.artifactId === `memory:${hit.memory.id}`);
          if (!artifact || !hit.memory.contentRevision) return [];
          return [{ companionId: owner!, noteId: hit.memory.id, contentRevision: hit.memory.contentRevision, path: artifact.relativePath, contentHash: artifact.contentHash }]; });
        Object.assign(report, { publishedCanonicalNotes: receipts.length, pendingOrUnavailableCanonicalNotes: noteCount - receipts.length });
        break; }
    }
    if (!owner || !conversationId) throw new Error('Copied corpus has no authorized memories.');
    // Start the production world's real interval, without adding artificial
    // transport delay or using mutation-free stubs. Only this physical tick
    // runs; autonomous/model jobs and publishers never start.
    const tick = () => { if (ticking) return; tickStarted++;
      ticking = host.call({ type: 'world.tick' }).then(() => { tickCompleted++; }, error => { errors.push(error.name); })
        .finally(() => { ticking = undefined; }); };
    tickTimer = setInterval(tick, 500); tick();
    const samples: Array<Record<string, unknown>> = [];
    const operations = (process.env.WORLDLINEBOX_IPC_BENCH_OPERATIONS ?? 'messages,file_gate,memory.snapshot').split(',');
    for (const operation of operations) {
      for (const key of Object.keys(counts)) delete counts[key]; foregroundCalls = 0; backgroundCalls = 0; slow.length = 0;
      const tickStart = tickStarted, tickEnd = tickCompleted;
      const controller = new AbortController(); let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(new Error('BENCHMARK_TIMEOUT')); }, 30000);
      const started = performance.now(), sample: Record<string, unknown> = { operation };
      try {
        if (operation === 'file_gate') {
          const valid = await withCompanionExecutionValidation(() => host.memoryFilesValid(owner!, receipts), controller.signal);
          Object.assign(sample, { status: valid ? 'completed' : 'failed', valid, checkedFiles: receipts.length });
        } else {
          const command: CompanionStorageCommand = operation === 'messages' ? { type: 'messages', conversationId, limit: 100 }
            : { type: 'memory.snapshot', companionId: owner, conversationId };
          const response = await host.call(command, controller.signal);
          Object.assign(sample, { status: response.ok ? 'completed' : 'failed',
            ...(operation === 'messages' ? { returnedMessages: response.messages?.length ?? 0 } : { returnedNotes: response.memorySnapshot?.notes.length ?? 0 }) });
        }
      } catch (error) { Object.assign(sample, { status: timedOut ? 'timeout' : 'failed', errorName: error instanceof Error ? error.name : 'Unknown' }); }
      finally { clearTimeout(deadline); }
      Object.assign(sample, { durationMs: performance.now() - started, ticksStarted: tickStarted - tickStart, ticksCompleted: tickCompleted - tickEnd,
        foregroundIpcCalls: foregroundCalls, backgroundIpcCalls: backgroundCalls, ipcCounts: { ...counts },
        slowOperations: [...slow].sort((a, b) => b.durationMs - a.durationMs).slice(0, 12) });
      samples.push(sample); console.log(JSON.stringify({ algorithm, ...sample }));
    }
    Object.assign(report, { status: samples.every(sample => sample.status === 'completed') ? 'completed' : 'incomplete', samples, noteCount, errors,
      processes: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type })) });
  } catch (error) { Object.assign(report, { status: 'setup_failed', errorName: error instanceof Error ? error.name : 'Unknown',
    setupError: error instanceof Error ? error.message.slice(0, 200) : undefined,
    errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined }); }
  finally {
    if (tickTimer) clearInterval(tickTimer);
    const cleanupStarted = performance.now();
    await ticking?.catch(() => undefined);
    await client.close();
    await memory?.close(); await library?.close();
    Object.assign(report, { cleanupMs: performance.now() - cleanupStarted, cleanupCompleted: true });
    await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report)); app.exit(report.status === 'setup_failed' || report.status === 'failed' ? 1 : 0);
  }
}).catch(error => { console.error(error.name); app.exit(2); });
