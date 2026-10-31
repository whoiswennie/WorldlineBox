import { fork } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { canonicalProjectionInputs } from '../../src/main/companions/canonical-projection-inputs';
import { loadInitialTimelinePrompts } from '../../src/main/vcp-memory/owner-prompts';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';
import { generateCompanionText } from '../../src/main/companions/model';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { fixtureOwnerRuntimePaths } from './owner-runtime-storage';
import { runNativeMemoryResourceScenario, type NativeMemoryResourceConfig } from './native-memory-resource-run';
import { canonicalInferenceHost } from './companion-canonical-inference';

const hostNativePids = new Set<number>();
let launches = 0;
async function runHost() {
const [root, endpoint, phase, benchmarkJson] = process.argv.slice(2);
if (!root || !endpoint || !phase || !path.isAbsolute(root)) throw new Error('Missing isolated prepared host parameters.');
const benchmark = phase.startsWith('benchmark-') ? JSON.parse(benchmarkJson!) as NativeMemoryResourceConfig : undefined;
const frozenNativeFiles = new Map<string, string>();
if (benchmark?.implementation) {
  const raw = await readFile(benchmark.implementation.manifestFile);
  if (createHash('sha256').update(raw).digest('hex') !== benchmark.implementation.manifestSha256) throw new Error('Frozen native manifest fingerprint changed.');
  const manifest = JSON.parse(raw.toString('utf8')) as { schema: string; hostCjs: Array<{ frozenPath: string; sha256: string }> };
  if (manifest.schema !== 'worldlinebox.memory-soak-implementation-v1') throw new Error('Unknown frozen native manifest.');
  for (const entry of manifest.hostCjs) frozenNativeFiles.set(path.resolve(entry.frozenPath), entry.sha256);
}
const initialOwners = Array.from({ length: benchmark?.owners ?? 1 }, (_, index) => ({ id: index ? `owner_${index.toString().padStart(4, '0')}` : 'alice',
  name: index ? `Synthetic owner ${index}` : 'Alice', description: 'Synthetic resource/recovery owner',
  persona: 'Use actual sources.', model: '', avatar: 'sister' as const, active: true, proactive: false }));
const store = new CompanionsStore(path.join(root, 'ledger.sqlite'), initialOwners);
const hostPortCalls: Record<string, number> = {}, storagePortCalls: Record<string, number> = {};
type OperationTiming = { calls: number; totalMs: number; maxMs: number; failures: number; abandoned: number };
type PhaseOperationTimings = { storage: Record<string, OperationTiming>; native: Record<string, OperationTiming>; nativePending: number; pairingAnomalies: number };
let operationTimingPhase = 'host_initialization';
const phaseOperationTimings = new Map<string, PhaseOperationTimings>();
const phaseTimings = (name: string): PhaseOperationTimings => {
  let value = phaseOperationTimings.get(name);
  if (!value) { value = { storage: {}, native: {}, nativePending: 0, pairingAnomalies: 0 }; phaseOperationTimings.set(name, value); }
  return value;
};
const recordOperationTiming = (target: Record<string, OperationTiming>, operation: string, durationMs: number, outcome: 'ok' | 'failed' | 'abandoned') => {
  const value = target[operation] ??= { calls: 0, totalMs: 0, maxMs: 0, failures: 0, abandoned: 0 };
  value.calls++; value.totalMs += durationMs; value.maxMs = Math.max(value.maxMs, durationMs);
  if (outcome === 'failed') value.failures++; else if (outcome === 'abandoned') value.abandoned++;
};
const operationTimingsSnapshot = (name = operationTimingPhase) => ({ schema: 'worldlinebox.native-resource-operation-timings-v1',
  hostPid: process.pid, phase: name, ...phaseTimings(name) });
const rawRequest = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
  storagePortCalls[command.type] = (storagePortCalls[command.type] ?? 0) + 1;
  if (!benchmark) return structuredClone(store.request(command));
  const startedAt = performance.now(), phase = operationTimingPhase; let outcome: 'ok' | 'failed' = 'failed';
  try { const result = structuredClone(store.request(command)); outcome = 'ok'; return result; }
  finally { recordOperationTiming(phaseTimings(phase).storage, command.type, performance.now() - startedAt, outcome); }
};
const workspaceRoot = path.join(root, 'owner-assets'), vendorRoot = benchmark?.implementation?.vendorRoot ?? path.resolve('vendor/vcp-memory');
const activeBenchmarkOwners = new Set(benchmark ? store.state(false, { includeConversations: false }).companions.slice(0, benchmark.activeOwners).map(owner => owner.id) : []);
const profiles = new CompanionAssetProfileStore(workspaceRoot, { loadInitialFocusPrompt: () => readFile(path.join(vendorRoot, 'Plugin/RAGDiaryPlugin/AIMemoPrompt.txt'), 'utf8'),
  registryStorage: { request: async command => {
    const response = await rawRequest(command); if (!response.ok) throw new Error(response.error ?? 'Prepared host registry request failed.'); return response;
  } },
  loadInitialTimelinePrompts: () => loadInitialTimelinePrompts(vendorRoot), loadInitialTagPrompt: async () => 'Synthetic tag instructions.',
  ...(benchmark ? {
    initialized: async (companionId: string) => {
      const response = await rawRequest({ type: 'companion.assets.initialized', companionId });
      if (!response.ok) throw new Error(response.error ?? 'Synthetic owner initialization receipt is unavailable.');
      return response.assetProfileInitialized === true;
    },
    markInitialized: async (companionId: string) => {
      const response = await rawRequest({ type: 'companion.assets.mark-initialized', companionId });
      if (!response.ok) throw new Error(response.error ?? 'Synthetic owner initialization receipt was not persisted.');
    },
  } : {}) });
const owner = store.state().companions.find(owner => owner.id === 'alice')!;
await profiles.bootstrap(owner);
const library = new CompanionMemoryLibrary({ libraryDirectory: workspaceRoot, request: rawRequest, profileStore: profiles });
const sourceFiles = new CompanionMemorySourceFiles({ library }), historyFiles = new CompanionMemoryHistoryFiles({ library });
const liveFiles = new CompanionMemoryLiveFiles({ library, history: historyFiles });
const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
  hostPortCalls[command.type] = (hostPortCalls[command.type] ?? 0) + 1;
  if (command.type === 'memory.revision.read') {
    const note = await historyFiles.read(command, command.id, command.contentRevision); return { ok: true, memories: note ? [note] : [] };
  }
  const response = await rawRequest(command);
  if (response.memorySnapshot) {
    const materialized = await liveFiles.materialize(command.type === 'memory.snapshot' ? command.companionId : 'alice', response.memorySnapshot.notes);
    response.memorySnapshot = { ...response.memorySnapshot, notes: materialized.notes, fileReceipts: materialized.receipts };
  }
  if (response.state) response.state.companions = await Promise.all(response.state.companions.map(async owner => benchmark
    ? profiles.hydrateProfileFromSnapshot(owner, await profiles.bootstrapProfile(owner)) : profiles.hydrate(owner)));
  return response;
};
const gateway = new VcpChatGateway(), nativePids = hostNativePids; let nativeCommands = 0, nativeInputBytes = 0;
const nativeWrites = { replaceCalls: 0, replaceNotes: 0, deltaCalls: 0, deltaUpserts: 0, deltaRemovals: 0, rememberCalls: 0 };
const config = { apiFormat: 'openai_chat' as const, model: phase === 'resume-model' ? 'synthetic-recovery-provider-changed' : 'synthetic-recovery-provider',
  baseUrl: endpoint + '/provider', apiKey: 'synthetic-local-provider' };
// Recovery model work uses the actual Main context compiler/dispatch snapshots.
// The resource-only benchmark retains its separately frozen host pipeline.
const inference = benchmark ? undefined : await canonicalInferenceHost(root, store, config);
const modelConfig = inference ? await inference.configFor(owner) : config;
const runtime = new CompanionVcpRuntime({ vendorRoot, workerPath: benchmark?.implementation?.workerPath ?? (phase === 'resume-algorithm' ? path.join(root, 'changed-host', 'worker.cjs') : path.resolve('src/main/vcp-memory/worker.cjs')),
  resolveOwnerCleanupStorage: fixtureOwnerRuntimePaths(workspaceRoot), resolveOwnerStorage: async ownerId => {
    const currentOwner = store.state(false).companions.find(owner => owner.id === ownerId);
    if (!currentOwner) throw new Error('Unknown synthetic runtime owner.'); await profiles.bootstrap(currentOwner);
    const profile = await profiles.load(ownerId); return { ownerId, workspaceRoot, ownerRoot: profile.root, indexRoot: path.join(profile.root, '.运行', '索引'),
      ownerPrompts: { aimemoTemplate: profile.nativeFocusTemplate, timelineTemplate: profile.nativeTimelineTemplate, summaryTemplate: profile.nativeSummaryTemplate } };
  }, resolveEmbedding: async () => ({ baseUrl: endpoint + '/document', queryBaseUrl: endpoint + '/query', model: 'synthetic-recovery-vector',
    modelSignature: `synthetic-recovery-${benchmark?.dimension ?? 16}-v1`, dimension: benchmark?.dimension ?? 16, apiKey: 'synthetic-vector' }),
  launch: file => {
    if (benchmark?.implementation && (frozenNativeFiles.get(path.resolve(file)) !== createHash('sha256').update(readFileSync(file)).digest('hex')))
      throw new Error('Native launch differs from the frozen host manifest.');
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH;
    const child = fork(file, [], { execPath: process.execPath, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const pendingTimings = new Map<string, { operation: string; phase: string; startedAt: number }>();
    const finishNativeTiming = (requestId: string, outcome: 'ok' | 'failed' | 'abandoned') => {
      const pending = pendingTimings.get(requestId); if (!pending) return;
      pendingTimings.delete(requestId); const metrics = phaseTimings(pending.phase); metrics.nativePending--;
      recordOperationTiming(metrics.native, pending.operation, performance.now() - pending.startedAt, outcome);
      // A request is charged to its send phase, even if it settles later.
      if (pending.phase !== operationTimingPhase) process.send?.({ stage: 'operation-timings', phase: pending.phase,
        operationTimings: operationTimingsSnapshot(pending.phase) });
    };
    if (benchmark) child.on('message', value => {
      const response = value as { requestId?: unknown; ok?: boolean };
      if (typeof response?.requestId === 'string') finishNativeTiming(response.requestId, response.ok === false ? 'failed' : 'ok');
    });
    launches++; nativePids.add(child.pid!); process.send?.({ stage: 'native-launch', pid: child.pid, hostPid: process.pid, workerPath: file,
      launchedAt: Date.now(), nativePids: [...nativePids] });
    child.on('exit', () => { for (const requestId of pendingTimings.keys()) finishNativeTiming(requestId, 'abandoned');
      nativePids.delete(child.pid!); process.send?.({ stage: 'native-exit', pid: child.pid, nativePids: [...nativePids] }); });
    return { postMessage: value => { nativeCommands++; nativeInputBytes += Buffer.byteLength(JSON.stringify(value));
      const envelope = value as { requestId?: string; command?: { type: string; notes?: unknown[]; removedIds?: string[]; configuration?: { dataRoot?: string } } };
      const command = envelope.command;
      if (benchmark && command?.type === 'initialize') {
        const dataRoot = command.configuration?.dataRoot;
        if (!dataRoot) throw new Error('Native benchmark initialization lacks its trusted owner path.');
        const relative = path.relative(workspaceRoot, dataRoot), parts = relative.split(path.sep), ownerId = parts[0]!;
        if (path.isAbsolute(relative) || parts.length !== 5 || parts[1] !== '.运行' || parts[2] !== '索引' || !['hot', 'generation'].includes(parts[3]!)
          || !/^[a-f0-9]{64}$/u.test(parts[4]!) || !activeBenchmarkOwners.has(ownerId)) throw new Error('An inactive or unbound benchmark owner attempted to open a native process.');
        process.send?.({ stage: 'native-owner', pid: child.pid, ownerId, lane: parts[3], activeOwners: [...activeBenchmarkOwners] });
      }
      if (command?.type === 'replace') { nativeWrites.replaceCalls++; nativeWrites.replaceNotes += command.notes?.length ?? 0; }
      if (command?.type === 'projection-delta') { nativeWrites.deltaCalls++; nativeWrites.deltaUpserts += command.notes?.length ?? 0; nativeWrites.deltaRemovals += command.removedIds?.length ?? 0; }
      if (command?.type === 'remember') nativeWrites.rememberCalls++;
      const requestId = envelope.requestId;
      if (benchmark && command && typeof requestId === 'string') {
        if (pendingTimings.has(requestId)) phaseTimings(operationTimingPhase).pairingAnomalies++;
        else { pendingTimings.set(requestId, { operation: command.type, phase: operationTimingPhase, startedAt: performance.now() });
          phaseTimings(operationTimingPhase).nativePending++; }
      }
      try { child.send(value as object); }
      catch (error) { if (benchmark && typeof requestId === 'string') finishNativeTiming(requestId, 'failed'); throw error; }
    }, on: child.on.bind(child), kill: () => { child.kill(); } };
  }, resolveGenerationPlugins: async input => {
    const route = await gateway.registerOwnerRoute({ ownerId: input.ownerId, semanticProfile: { profileKey: input.profileKey }, credential: config.apiKey,
      generate: async (context, signal, work) => generateCompanionText(context, { ...(inference ? await inference.configFor({ id: input.ownerId }) : config),
        ...(inference ? { resolveAssetContext: (value, kind) => inference.prepare(input.ownerId, value, kind, work?.nativePrompt,
          work?.nativePrompt ? work.nativePrompt.kind === 'timeline' ? 'native_timeline' : 'native_summary' : 'vcp_focus_guidance') } : {}),
        ownerId: input.ownerId, workPriority: work?.priority }, signal) });
    return { plugins: { chat: route.chat }, dispose: route.dispose };
  } });
const errors: string[] = [];
const queryTiming = new AsyncLocalStorage<{ startedAt: number; firstFocusSendAt?: number }>();
const timingSummary: Record<string, { calls: number; totalMs: number; maxMs: number }> = {};
const memory = new CompanionMemoryService({ request, runtime, cacheRootFor: async ownerId => path.join(workspaceRoot, ownerId, '.运行', '索引', 'views'),
  configFor: async companion => inference ? inference.configFor(companion) : config, fetchFn: (input, init) => { const timing = queryTiming.getStore();
    if (timing && timing.firstFocusSendAt === undefined) timing.firstFocusSendAt = performance.now(); return fetch(input, init); },
  validateFiles: (ownerId, receipts, window) => liveFiles.validate(ownerId, receipts, window),
  prepareFiles: async ownerId => { await library.prepareOwnerFiles(ownerId); await sourceFiles.flush(ownerId); await historyFiles.flush(ownerId); },
  materializeNotes: (ownerId, notes) => liveFiles.projectionNotes(ownerId, notes), canonicalInputs: (scope, notes) => canonicalProjectionInputs(historyFiles, scope, notes, library),
  onTiming: benchmark ? ({ operation, durationMs }) => { const value = timingSummary[operation] ??= { calls: 0, totalMs: 0, maxMs: 0 };
    value.calls++; value.totalMs += durationMs; value.maxMs = Math.max(value.maxMs, durationMs); } : undefined,
  busy: () => false, changed: () => undefined, report: error => errors.push(String(error)) });
memory.schedule = () => undefined; // Recovery harness does not create unrelated background cognition.
const resourceTimer = benchmark ? setInterval(() => process.send?.({ stage: 'resources', host: process.memoryUsage(), nativePids: [...nativePids],
  nativeCommands, nativeInputBytes, nativeWrites, hostPortCalls, storagePortCalls, timingSummary,
  operationTimings: operationTimingsSnapshot(), resources: memory.resourceSnapshot() }), 100) : undefined;
try {
  if (benchmark) {
    await runNativeMemoryResourceScenario(phase === 'benchmark-seed' ? 'seed' : 'run', { store, memory, runtime, liveFiles, profiles, sourceFiles, historyFiles,
      endpoint, config: benchmark, emit: value => {
        if (value.stage === 'phase' && typeof value.phase === 'string') operationTimingPhase = value.phase;
        process.send?.({ ...value, ...(['phase-complete', 'phase-failed'].includes(String(value.stage))
          ? { operationTimings: operationTimingsSnapshot() } : {}) });
      }, measureQuery: async (operation, startedAt) => {
        const timing: { startedAt: number; firstFocusSendAt?: number } = { startedAt };
        return queryTiming.run(timing, async () => { const result = await operation();
          return { ...result, localPreparationMs: (timing.firstFocusSendAt ?? performance.now()) - startedAt,
            preparationBoundary: timing.firstFocusSendAt === undefined ? 'validated_cached_receipt' : 'before_first_focus_http_send' }; });
      } });
    process.send?.({ stage: 'benchmark-complete', nativePids: [...nativePids], launches, errors }); return;
  }
  let checkpoint: CompanionLoopCheckpoint;
  if (phase.startsWith('seed')) {
    const conversation = store.openPrivate('alice');
    for (let index = 0; index < 3; index++) {
      const content = `group0 Actual source ${index}: the blue umbrella is still borrowed, return Wednesday.`;
      const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content, replyDirective: 'none' });
      store.request({ type: 'memory.record', companionId: 'alice', conversationId: conversation.id,
        candidate: { artifactKind: 'episode_memory', content, tags: ['group0', 'umbrella'], diaryName: '资料',
          sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    }
    while ((await sourceFiles.flush('alice')).pending) { /* Publish the complete original source outbox. */ }
    while ((await historyFiles.flush('alice')).pending) { /* Publish the complete immutable historical outbox. */ }
    if (phase.endsWith('-annotations')) for (const { memory: note } of store.request({ type: 'memory.library.page', companionId: 'alice', cursor: 0, limit: 64 }).memoryPage!.items) {
      store.request({ type: 'memory.library.organize', companionId: 'alice', id: note.id, expectedVersion: note.version,
        diaryName: '资料', tags: ['group0', 'umbrella', 'captured_annotation_v2'] });
    }
    await liveFiles.flush('alice'); await memory.drainDeliveries();
    const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: 'group0 What is the borrowed umbrella agreement?', replyDirective: 'none' });
    checkpoint = { companionId: 'alice', conversationId: conversation.id, sourceMessageId: source.id, status: 'running', turns: [], supplements: [] };
    store.request({ type: 'loop.save', checkpoint });
    await writeFile(path.join(root, 'task.json'), JSON.stringify({ conversationId: conversation.id, sourceMessageId: source.id }));
  } else {
    const task = JSON.parse(await readFile(path.join(root, 'task.json'), 'utf8'));
    checkpoint = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: task.sourceMessageId }).loop!;
  }
  const conversation = store.state().conversations.find(room => room.id === checkpoint.conversationId)!;
  const source = store.request({ type: 'message.get', id: checkpoint.sourceMessageId }).message!;
  const isCurrent = async () => store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: checkpoint.sourceMessageId }).loop?.status === 'running';
  const result = await memory.recall({ companion: owner, conversation, messages: [source], currentMessage: source, config: modelConfig,
    recovery: { taskKey: createHash('sha256').update('host-task:' + checkpoint.sourceMessageId).digest('hex'), reference: checkpoint.memoryPreparation, isCurrent,
      onPrepared: async reference => {
        if (!await isCurrent()) throw new Error('Synthetic durable task was stopped.');
        if (reference) checkpoint.memoryPreparation = reference; else delete checkpoint.memoryPreparation;
        store.request({ type: 'loop.save', checkpoint });
        const stage = reference?.focusHash ? 'focused' : 'prepared';
        process.send?.({ stage, nativePids: [...nativePids], launches, reference });
        if (phase === 'seed-' + stage || phase === 'seed-' + stage + '-annotations') await new Promise<void>(() => undefined);
      } } });
  if (!result.context) throw new Error('Restored recall has no verified context.');
  const prepared = checkpoint.memoryPreparation;
  checkpoint.context = { system: 'Synthetic task context', user: JSON.stringify({ memoryRecall: result }) }; delete checkpoint.memoryPreparation;
  store.request({ type: 'loop.save', checkpoint }); await memory.acknowledgeTaskRecall(prepared);
  process.send?.({ stage: 'complete', launches, context: result.context, errors });
} catch (error) { process.send?.({ stage: 'rejected', error: error instanceof Error ? error.message : String(error), launches, nativePids: [...nativePids] }); }
finally { if (resourceTimer) clearInterval(resourceTimer); operationTimingPhase = 'host_shutdown';
  await memory.close(); await inference?.close(); await library.close(); await gateway.close(); store.close();
  if (benchmark) process.send?.({ stage: 'operation-timings', phase: operationTimingPhase, operationTimings: operationTimingsSnapshot() }); }
}
void runHost().catch(error => { process.send?.({ stage: process.argv[4]?.startsWith('resume') ? 'rejected' : 'fatal',
  error: error instanceof Error ? error.message : String(error), launches, nativePids: [...hostNativePids] }); process.exitCode = 1; });
