/** Actual memory-board request, actual Main and utility workers. Reports never
 * contain recalled bodies, source IDs, vectors or credentials. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Instruments private runtime boundaries without changing production interfaces. */
import { app, net, utilityProcess } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { COMPANIONS_CHANGED_CHANNEL, companionsRequestSchema } from '../../src/shared/companions';
import { COMPANION_MEMORY_PROBE_PROGRESS_CHANNEL } from '../../src/shared/companion-memory-probe-progress';
import { createCoalescedRefresh } from '../../src/renderer/companions/coalesced-refresh';
import { detachedCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { companionLearningAssets } from '../../src/main/companions/learning-assets';

const root = process.env.WORLDLINEBOX_PROBE_BENCH_ROOT!, workerPath = process.env.WORLDLINEBOX_PROBE_BENCH_WORKER!, project = process.env.WORLDLINEBOX_PROBE_BENCH_PROJECT!;
const mode = process.env.WORLDLINEBOX_PROBE_BENCH_MODE;
if (!root || !workerPath || !project || !path.isAbsolute(root) || !['active', 'passive'].includes(mode ?? '')) throw new Error('Invalid isolated probe inputs.');
app.setPath('userData', path.join(root, 'electron-user-data')); app.disableHardwareAcceleration();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const metrics: Record<string, { calls: number; totalMs: number; maxMs: number; errors: number }> = {};
let phase = 'initialization';
function record(operation: string, durationMs: number, failed = false, targetPhase = phase) {
  const value = metrics[targetPhase + ':' + operation] ??= { calls: 0, totalMs: 0, maxMs: 0, errors: 0 };
  value.calls++; value.totalMs += durationMs; value.maxMs = Math.max(value.maxMs, durationMs); if (failed) value.errors++;
}
function instrument(target: any, key: string, label = key, observe?: (value: any, args: any[]) => void) {
  const original = target[key];
  target[key] = async function (...args: any[]) {
    const start = performance.now(), current = phase;
    try { const value = await original.apply(this, args); observe?.(value, args); record(label, performance.now() - start, false, current); return value; }
    catch (error) { record(label, performance.now() - start, true, current); throw error; }
  };
}
// Isolate this button test from unrelated persisted semantic tasks. Physical
// world ticks, canonical publishing, native indexing and all read guards stay real.
const prototype = CompanionService.prototype as any;
prototype.restoreQueue = async () => undefined;
prototype.executeAgendaEvent = async () => ({ outcome: 'waiting', stage: 'Probe benchmark pauses unrelated semantic work.',
  nextCondition: 'benchmark.unpaused', notBefore: new Date(Date.now() + 600000).toISOString() });

void app.whenReady().then(async () => {
  let service: any, uiRefresh: ReturnType<typeof createCoalescedRefresh> | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let uiReadPending = Promise.resolve();
  const authorityPolls = new Set<Promise<unknown>>();
  let resultVisible = false, refreshFull = true, owner = '', modelNetworkCalls = 0, generationAdmissions = 0;
  let externalAssetWorkerCalls = 0, snapshotEntriesObserved = 0;
  const learningValidationRequests: Record<string, number> = {};
  const uiReads = { fullState: 0, runtimeProgress: 0, recallState: 0, failures: 0, fullChanges: 0, progressChanges: 0 };
  const failures: Array<{ phase: string; name: string; code?: string; stack?: string[] }> = [];
  const progress = new Map<string, any[]>(), queries: any[] = [], searches: any[] = [], nativeTransitions: any[] = [];
  const globalConfig = JSON.parse(await readFile(path.join(root, 'global-config.json'), 'utf8'));
  const verified = await readFile(path.join(root, 'embedding-device.json'), 'utf8').then(value => JSON.parse(value), () => undefined);
  const preference = verified?.state === 'supported' && ['cpu', 'gpu'].includes(verified.backend)
    ? { backend: verified.backend as 'cpu' | 'gpu', ...(verified.deviceId ? { deviceId: String(verified.deviceId) } : {}) } : undefined;
  const encoder = new GlobalEmbeddingService({ userDataPath: app.getPath('userData'), bundleDirectory: path.join(project, 'resources/embedding-models'),
    koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi'), ...(preference ? { devicePreference: () => preference } : {}) });
  instrument(encoder, 'embed', 'embedding.real_local', value => {
    if (value.vectors.some((vector: number[]) => vector.length !== value.profile.dimension || vector.some(component => !Number.isFinite(component)))) throw new Error('Invalid actual encoder vectors.');
  });
  instrument(encoder, 'prepare', 'embedding.physical_prepare');
  const embedding = new VcpEmbeddingGateway(encoder);
  const runtime = new CompanionVcpRuntime({ vendorRoot: path.join(project, 'vendor/vcp-memory'), workerPath: path.join(project, 'src/main/vcp-memory/worker.cjs'),
    resolveOwnerStorage: id => service.resolveOwnerStorage(id), resolveOwnerCleanupStorage: id => service.resolveOwnerCleanupStorage(id),
    resolveEmbedding: async () => { const profile = await encoder.resolveProfile(); return embedding.configuration(profile.selectionId, profile); },
    prepareEmbedding: signal => encoder.prepare({ signal }),
    resolveGenerationPlugins: async () => { generationAdmissions++; throw new Error('The memory-board default must not acquire a focusing model.'); },
    launch: file => {
      const child = utilityProcess.fork(file, [], { serviceName: 'WorldlineBox actual memory-board probe', stdio: 'pipe' });
      child.stdout?.resume(); child.stderr?.resume();
      const pending = new Map<string, { operation: string; started: number; phase: string }>();
      child.on('message', (value: any) => {
        const request = pending.get(value?.requestId); if (!request) return;
        pending.delete(value.requestId); record('native.' + request.operation, performance.now() - request.started, value.ok === false, request.phase);
        if (request.operation === 'projection-inspect' && value.ok) nativeTransitions.push({ phase: request.phase, operation: request.operation,
          upserts: value.value?.upsertIds?.length ?? 0, removals: value.value?.removedIds?.length ?? 0, reused: value.value?.reused ?? 0 });
      });
      return { postMessage: value => { const envelope = value as any;
        if (envelope?.requestId && envelope?.command?.type) {
          pending.set(envelope.requestId, { operation: envelope.command.type, started: performance.now(), phase });
          if (['replace', 'projection-delta'].includes(envelope.command.type)) nativeTransitions.push({ phase, operation: envelope.command.type,
            notes: envelope.command.notes?.length ?? 0, removals: envelope.command.removedIds?.length ?? 0 });
        }
        child.postMessage(value);
      }, on: (event: any, listener: any) => { child.on(event, listener); }, kill: () => { child.kill(); } };
    } });
  (net as any).fetch = async () => { modelNetworkCalls++; throw new Error('Unexpected model request from the unchanged memory-board defaults.'); };
  const report: any = { schema: 'worldlinebox.actual-memory-board-probe-benchmark-v1', mode, query: '早上好', sourceLibraryMutated: false,
    realMainService: true, realStorageUtilityProcess: true, realNativeUtilityProcess: true, browserWindowsCreated: 0,
    bundledEncoder: true, embeddingDevicePreference: preference, vectorMocking: false, learningAssetsAdapter: true,
    uiRequest: { type: 'memory.recall.test', query: '早上好', mode, limit: 8, retrievalOptions: 'omitted exactly as the renderer' },
    paused: ['unrelated persisted reply recovery', 'unrelated agenda semantic work'],
    coldMeaning: 'First query after the real startup idle prime in a new Electron process; physical/index preparation is reported separately, not included in button latency.',
    uiPolling: { parentChangedMinimumMs: 500, parentProgressRequest: 'state.progress', parentFullRequest: 'state',
      probeStateCheckDebounceMs: 750, probeStateCheckOnlyWhileAResultIsDisplayed: true } };
  const started = performance.now();
  try {
    service = new CompanionService({ userData: app.getPath('userData'), dataRoot: root, memoryLibraryRoot: path.join(root, 'owners'), workerPath, appPath: project,
      memoryRuntime: runtime, getConfig: () => ({ ...globalConfig, apiKey: 'unused-no-model-request' }), hasConfig: () => true, dsh: () => undefined,
      learningAssets: companionLearningAssets({ memoryRoot: path.join(root, 'owners'), storageRequest: async command => {
        learningValidationRequests[command.type] = (learningValidationRequests[command.type] ?? 0) + 1;
        const response = await service.requestAssetValidation(command);
        snapshotEntriesObserved += response.learningAssetSnapshot?.entries.length ?? 0;
        if (snapshotEntriesObserved) throw new Error('The copied corpus is no longer the verified empty learning-grant branch.');
        return response;
      }, request: async () => { externalAssetWorkerCalls++; throw new Error('The empty copied learning-grant branch unexpectedly requested an external asset worker.'); } }),
      window: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string, event: any) => {
        if (channel === COMPANION_MEMORY_PROBE_PROGRESS_CHANNEL) {
          const events = progress.get(event.requestId) ?? []; events.push({ sequence: event.sequence, state: event.state,
            stageId: event.stageId, elapsedMs: event.elapsedMs, stageElapsedMs: event.stageElapsedMs }); progress.set(event.requestId, events);
        }
        if (channel === COMPANIONS_CHANGED_CHANNEL) detachedCompanionExecutionValidation(() => {
          if (event?.kind === 'progress') uiReads.progressChanges++; else { uiReads.fullChanges++; refreshFull = true; }
          uiReadPending = uiRefresh?.trigger() ?? Promise.resolve();
          if (resultVisible && !pollTimer) pollTimer = setTimeout(() => {
            pollTimer = undefined; if (!resultVisible) return; uiReads.recallState++;
            const reading: Promise<unknown> = service.handle({ type: 'memory.recall.state', companionId: owner }).then((value: any) => {
              if (!value?.ok || !value.memoryCorpusStamp || !value.memoryRecallAuthorityStamp) uiReads.failures++;
            }, () => { uiReads.failures++; }).finally(() => { authorityPolls.delete(reading); });
            authorityPolls.add(reading);
          }, 750);
        });
      } } }) as any,
      onTiming: timing => { if (!timing.operation.endsWith('.wait')) record(timing.operation, timing.durationMs); },
      report: error => { if (failures.length < 40) failures.push({ phase, name: error instanceof Error ? error.name : typeof error,
        ...((error as any)?.code ? { code: String((error as any).code) } : {}),
        ...(error instanceof Error ? { stack: error.stack?.split('\n').slice(1, 8) } : {}) }); } });
    const raw = service.storage.request.bind(service.storage);
    service.storage.request = async (command: any) => { const at = performance.now(), current = phase;
      try { const response = await raw(command); record('ipc.' + command.type, performance.now() - at, !response.ok, current); return response; }
      catch (error) { record('ipc.' + command.type, performance.now() - at, true, current); throw error; } };
    instrument(service, 'memoryWarmupCandidates', 'memory.idle_candidates');
    instrument(service.memory, 'startWarmup', 'memory.idle_prime');
    instrument(service.memory, 'search', 'memory.search.default', (value, args) => searches.push({ phase,
      mode: args[1], optionsOmitted: args[0].retrievalOptions === undefined, historyOmitted: true,
      ok: value.ok, hits: value.memoryPage?.items.length ?? 0, timings: value.memorySearchTimings,
      referenceCount: value.memoryContext?.evidence?.references?.length ?? 0,
      referenceCoverage: value.memoryContext?.evidence?.referenceCoverage, fileReceipts: value.memoryContext?.fileReceipts?.length ?? 0,
      dependencyCount: value.memoryContext?.evidence?.dependencies?.length ?? 0,
      scopeSha256: hash(JSON.stringify([args[0].companionId, args[0].conversationId, args[0].beforeSequence ?? null])),
      authorizedCorpusHash: value.memoryContext?.evidence?.corpusHash,
      queryClock: value.memoryContext?.evidence?.queryClock,
      nativeDocuments: Number(value.memoryRetrieval?.stages.find((stage: any) => stage.id === 'scope')?.facts.find((fact: any) => fact.label === '获权记忆文档')?.value),
      nativeStages: value.memoryRetrieval?.stages.map((stage: any) => ({ id: stage.id, matches: stage.matches.length })) }));
    await service.initialization;
    const state = (await raw({ type: 'state', includeConversations: false })).state;
    const candidates = state?.companions ?? [];
    owner = process.env.WORLDLINEBOX_PROBE_BENCH_OWNER ?? candidates.find((candidate: any) => candidate.id.startsWith('d520'))?.id ?? '';
    if (!owner || !candidates.some((candidate: any) => candidate.id === owner)) throw new Error('Original owner is absent from the cloned library.');
    report.ownerSha256 = hash(owner);
    const status = await raw({ type: 'memory.status', companionId: owner });
    report.memoryStatusBefore = Object.fromEntries(Object.entries(status.memoryStatus ?? {}).filter(([, value]) => typeof value === 'number'));
    uiRefresh = createCoalescedRefresh(async () => {
      const full = refreshFull; refreshFull = false;
      if (full) uiReads.fullState++; else uiReads.runtimeProgress++;
      const response = await service.handle({ type: full ? 'state' : 'state.progress' });
      if (!response.ok || (full ? !response.state : !response.runtimeProgress)) throw new Error('The actual memory-page parent refresh failed.');
    }, () => { uiReads.failures++; }, 500);
    await uiRefresh.trigger();
    const primeStarted = performance.now(); phase = 'idle';
    await service.memory.primeIdle();
    report.idlePrimingMs = performance.now() - primeStarted;
    report.idlePrimeCompleted = service.memory.warmedViews.has(owner);
    report.initializationMs = performance.now() - started;
    report.encoderCallsBeforeCold = Object.entries(metrics).filter(([key]) => /^(initialization|idle):embedding\.real_local$/u.test(key))
      .reduce((sum, [, value]) => sum + value.calls, 0);
    for (const temperature of ['cold', 'warm']) {
      phase = temperature; resultVisible = false; if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
      const requestId = randomUUID(), request = companionsRequestSchema.parse({ type: 'memory.recall.test', companionId: owner, requestId, query: '早上好', mode, limit: 8 });
      const beforeUi = { ...uiReads }, beforeNetwork = modelNetworkCalls, beforeGeneration = generationAdmissions, begin = performance.now();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const response: any = await Promise.race([service.handle(request), new Promise((_, reject) => {
          deadline = setTimeout(() => reject(Object.assign(new Error('Memory probe timed out.'), { code: 'PROBE_TIMEOUT' })), 180000);
        })]);
        if (!response.ok || !response.memoryProbe) throw new Error('The actual button request did not return its typed result.');
        const probe = response.memoryProbe, ids = new Set(probe.memories.map((hit: any) => hit.memory.id));
        const referencesConsistent = !probe.memoryRetrieval || probe.memoryRetrieval.mode === mode
          && probe.memoryRetrieval.stages.every((stage: any) => stage.matches.every((match: any) => ids.has(match.memoryId)));
        const events = progress.get(requestId) ?? [], recorded = searches.at(-1);
        queries.push({ temperature, firstAfterIdle: temperature === 'cold', status: 'completed', durationMs: performance.now() - begin, timing: probe.timing,
          hits: probe.memories.length, pending: probe.pending, degraded: probe.degraded, contextBytes: Buffer.byteLength(probe.contextText), contextSha256: hash(probe.contextText),
          corpusStamp: probe.corpusStamp, authorityStamp: probe.authorityStamp, referencesConsistent,
          ownersConsistent: probe.memories.every((hit: any) => hit.memory.companionId === owner),
          events, progressCompleted: events.at(-1)?.state === 'completed',
          modelNetworkCalls: modelNetworkCalls - beforeNetwork, generationAdmissions: generationAdmissions - beforeGeneration,
          runtimeResources: runtime.resourceSnapshot(),
          uiReads: Object.fromEntries(Object.entries(uiReads).map(([key, count]) => [key, count - beforeUi[key as keyof typeof uiReads]])),
          referenceCount: recorded?.referenceCount, referenceCoverage: recorded?.referenceCoverage, fileReceipts: recorded?.fileReceipts });
        queries.at(-1).nativeDocuments = recorded?.nativeDocuments;
        queries.at(-1).nativeQueryExecuted = ['prepare-recall', 'preprocess', 'plugin', 'search'].some(operation => (metrics[phase + ':native.' + operation]?.calls ?? 0) > 0);
        resultVisible = true;
      } finally { if (deadline) clearTimeout(deadline); }
      console.log(JSON.stringify({ mode, ...queries.at(-1), events: undefined }));
    }
    report.status = queries.length === 2 && queries.every(sample => sample.status === 'completed' && !sample.degraded && sample.referencesConsistent && sample.ownersConsistent
      && sample.progressCompleted && sample.nativeDocuments > 0 && sample.nativeQueryExecuted && !sample.modelNetworkCalls && !sample.generationAdmissions)
      && report.idlePrimeCompleted && !failures.length && !uiReads.failures && !modelNetworkCalls && !generationAdmissions
      && !externalAssetWorkerCalls && !snapshotEntriesObserved ? 'completed' : 'incomplete';
  } catch (error) { report.status = 'failed'; report.failure = { name: error instanceof Error ? error.name : typeof error, code: (error as any)?.code,
    stack: error instanceof Error ? error.stack?.split('\n').slice(1, 6) : undefined }; }
  finally {
    resultVisible = false; if (pollTimer) clearTimeout(pollTimer); uiRefresh?.dispose();
    phase = 'cleanup'; const cleanup = performance.now();
    await Promise.allSettled([uiReadPending, ...authorityPolls]);
    if (report.failure?.code === 'PROBE_TIMEOUT') await Promise.allSettled([runtime.close(), encoder.close()]);
    const cleanupFailures: Array<{ operation: string; name: string; code?: string; stack?: string[] }> = [];
    for (const [operation, close] of [['service', () => service?.shutdown()], ['runtime', () => runtime.close()],
      ['embedding_gateway', () => embedding.close()], ['encoder', () => encoder.close()]] as const) {
      try { await close(); } catch (error) { cleanupFailures.push({ operation, name: error instanceof Error ? error.name : typeof error,
        code: (error as any)?.code, stack: error instanceof Error ? error.stack?.split('\n').slice(1, 8) : undefined }); }
    }
    const resources = runtime.resourceSnapshot();
    const cleanupCompleted = !cleanupFailures.length && !resources.pools.references && !resources.pools.hot && !resources.pools.cold && !resources.pools.generation
      && !resources.native.processes && !resources.native.outstanding && !resources.native.waiting;
    if (!cleanupCompleted && report.status === 'completed') report.status = 'incomplete';
    Object.assign(report, { queries, searches, metrics, uiReads, modelNetworkCalls, generationAdmissions, failures, externalAssetWorkerCalls, snapshotEntriesObserved, learningValidationRequests, nativeTransitions,
      cleanupMs: performance.now() - cleanup, cleanupCompleted, cleanupFailures,
      embeddingCache: embedding.cacheSnapshot(), runtimeResourcesAfterClose: resources, processes: app.getAppMetrics().map(value => ({ type: value.type })) });
    await writeFile(path.join(root, 'probe-result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ mode, status: report.status, coldMs: queries[0]?.durationMs, warmMs: queries[1]?.durationMs,
      modelNetworkCalls, generationAdmissions, cleanupCompleted, failure: report.failure?.name })); app.exit(report.status === 'completed' ? 0 : 1);
  }
}).catch(async error => {
  const failure = { name: error instanceof Error ? error.name : typeof error, code: error?.code,
    stack: error instanceof Error ? error.stack?.split('\n').slice(1, 8) : undefined };
  await writeFile(path.join(root, 'probe-result.json'), JSON.stringify({ status: 'setup_failed', mode, queries: [], failure, cleanupCompleted: false }, null, 2)).catch(() => undefined);
  console.error(JSON.stringify(failure)); app.exit(2);
});
