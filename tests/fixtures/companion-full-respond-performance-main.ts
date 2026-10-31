/** Isolated, real CompanionService → agenda claim → respond → provider boundary probe.
 * No corpus text, credentials or provider bodies are written to the report.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- A diagnostic fixture deliberately instruments private runtime methods without widening production APIs. */
import { app, net, safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { fork, type Serializable } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';
import { generateCompanionText, companionNativeProviderLifecycle, COMPANION_TEXT_GENERATION_PROFILE } from '../../src/main/companions/model';
import { createCoalescedRefresh } from '../../src/renderer/companions/coalesced-refresh';
import { COMPANIONS_CHANGED_CHANNEL } from '../../src/shared/companions';
import { createFullRespondCancellationProbe } from './companion-full-respond-cancellation';
import { waitForFullRespondCompletions } from './companion-full-respond-online-completion';
import { companionModelQuota } from '../../src/main/companions/model-quota';
import { createFullRespondSchedulingProbe } from './companion-full-respond-scheduling';
import { detachedCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { observeFullRespondProviderResponse, type FullRespondProviderObservation } from './companion-full-respond-provider-observation';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import { companionLearningAssets } from '../../src/main/companions/learning-assets';
import { createPeerToolDiagnostics } from './companion-full-respond-peer-diagnostics';
import { createAutomaticRecallAudit } from './companion-full-respond-automatic-recall-audit';

const root = process.env.WORLDLINEBOX_RESPOND_BENCH_ROOT!;
const workerPath = process.env.WORLDLINEBOX_RESPOND_BENCH_WORKER!;
const project = process.env.WORLDLINEBOX_RESPOND_BENCH_PROJECT!;
if (!root || !workerPath || !project || !path.isAbsolute(root)) throw new Error('Missing isolated benchmark inputs.');
app.setPath('userData', path.join(root, 'electron-user-data')); app.disableHardwareAcceleration();
const metrics: Record<string, { calls: number; totalMs: number; maxMs: number; errors: number }> = {};
const events: Array<{ phase?: string; atMs: number; stage: string; durationMs?: number }> = [];
const nativeTransitions: Array<{ phase: string; operation: string; upserts?: number; removals?: number; notes?: number }> = [];
const rawCallsites = new Map<string, { operation: string; phase: string; samples: number; stack: string[] }>();
const rawStackCounts = new Map<string, number>();
const rawShapes = new Map<string, { phase: string; operation: string; shape: Record<string, string | number>; calls: number }>();
const commandTrace = new AsyncLocalStorage<readonly string[]>();
const rawCommandChains = new Map<string, { phase: string; operation: string; chain: readonly string[]; calls: number }>();
const changeOrigins = new Map<string, { phase: string; kind: string; chain: readonly string[]; stack: string[]; calls: number }>();
const projectedResponseShapes = new Map<string, { phase: string; operation: string; shape: Record<string, number>; calls: number }>();
function observeProjection(owner: string, operation: string, value: any) {
  const actions = value?.actions ?? value?.actionPage?.items, messages = value?.messages;
  if (!Array.isArray(actions) && !Array.isArray(messages)) return;
  const shape: Record<string, number> = {};
  if (Array.isArray(actions)) { shape.actions = actions.length; shape.unavailableActions = actions.filter(action => action.contentAvailable === false).length; }
  if (Array.isArray(messages)) { shape.messages = messages.length; shape.unavailableMessages = messages.filter(message => !!message.sourceUnavailable).length; }
  const identity = owner + ':' + operation + ':' + JSON.stringify(shape), row = projectedResponseShapes.get(identity) ?? { phase: owner, operation, shape, calls: 0 };
  row.calls++; projectedResponseShapes.set(identity, row);
}
const stackOperations = new Set(['action.get', 'state', 'loop.for-message', 'message.get', 'memory.sources.filter', 'cognition.registry.read', 'cognition.registry.refs.validate',
  'execution.capabilities.validate', 'execution.sources', 'memory.revisions.describe', 'memory.revision.describe']);
const errors: Array<{ phase?: string; name: string; code?: string; stack?: string[] }> = [];
const recallOutcomes: Array<{ phase: string; label?: string; degraded: boolean; pending: boolean; hasFailure: boolean; references: number }> = [];
const diagnosticProfile = process.env.WORLDLINEBOX_RESPOND_CAUSE_PROFILE === '1';
const methodDiagnostics: unknown[] = [], sourceRevisionWrites = new Map<string, { phase: string; operation: string; writes: number; increment: number; stack: string[] }>();
function callerStack(): string[] {
  const prior = Error.stackTraceLimit;
  try { Error.stackTraceLimit = 28; return new Error().stack?.split('\n').slice(2, 20) ?? []; }
  finally { Error.stackTraceLimit = prior; }
}
function profileTask(value: any) {
  let packet: any; try { if (typeof value?.taskAssets === 'string') packet = JSON.parse(value.taskAssets); } catch { /* Only the original parser decides validity. */ }
  return { preparedTask: !!value?.preparedTask, taskAssets: !!value?.taskAssets, turns: value?.turns?.length ?? 0,
    assetModules: packet?.snapshot?.modules?.length ?? 0, fileRevisionKeys: Object.keys(packet?.snapshot?.fileRevisions ?? {}).length,
    promptKeys: Object.keys(packet?.snapshot?.prompts ?? {}).length };
}
let phase = 'initialization', phaseStarted = performance.now(), foregroundStarted = 0;
function record(operation: string, durationMs: number, failed = false, recordedPhase = phase) {
  const value = metrics[recordedPhase + ':' + operation] ??= { calls: 0, totalMs: 0, maxMs: 0, errors: 0 };
  value.calls++; value.totalMs += durationMs; value.maxMs = Math.max(value.maxMs, durationMs); if (failed) value.errors++;
}
function instrument(target: any, name: string, label = name) {
  const original = target?.[name]; if (typeof original !== 'function') return;
  target[name] = function (...args: any[]) {
    const started = performance.now(); let result: any;
    const tracked = diagnosticProfile && ['memoryInference', 'configFor', 'taskEvidenceCurrent', 'prepareModelAssetContext', 'memory.contextValid', 'memory.contextFresh', 'memory.contextFilesValid'].includes(label);
    const context = tracked ? { phase, operation: label, startedAtMs: started - foregroundStarted, caller: callerStack(),
      ...(name === 'memoryInference' ? { taskBefore: profileTask(args[0]), continuityAttempt: args[5] ?? 0, capacityFeedback: args[6] === true } : {}),
      ...(name === 'configFor' ? { taskBefore: profileTask(args[2]) } : {}) } : undefined;
    if (name === 'respond' && targetSources.has(args[5])) {
      const timing = taskTimings.get(args[5]); if (timing) timing.preparationStartedMs ??= started - foregroundStarted;
    }
    try { result = original.apply(this, args); } catch (error) { record(label, performance.now() - started, true);
      if (context) methodDiagnostics.push({ ...context, outcome: 'throw', errorName: error instanceof Error ? error.name : typeof error, code: (error as any)?.code }); throw error; }
    return Promise.resolve(result).then(value => { record(label, performance.now() - started);
      if (label === 'memory.recall') recallOutcomes.push({ phase, label: targetLabels.get(args[0]?.currentMessage?.id), degraded: value?.degraded === true,
        pending: value?.pending === true, hasFailure: !!value?.failure, references: value?.context?.evidence?.references?.length ?? 0 });
      if (context) methodDiagnostics.push({ ...context, durationMs: performance.now() - started, outcome: typeof value === 'boolean' ? value : 'returned',
        ...(name === 'memoryInference' ? { taskAfter: profileTask(args[0]) } : {}), ...(name === 'configFor' ? { configKeys: Object.keys(value ?? {}).length } : {}) });
      return value; }, error => { record(label, performance.now() - started, true);
      if (context) methodDiagnostics.push({ ...context, durationMs: performance.now() - started, outcome: 'throw', errorName: error instanceof Error ? error.name : typeof error, code: error?.code }); throw error; });
  };
}
const prototype = CompanionService.prototype as any;
const scenario = process.env.WORLDLINEBOX_RESPOND_SCENARIO ?? 'single';
const online = process.env.WORLDLINEBOX_RESPOND_ONLINE === '1';
const requestedMessage = process.env.WORLDLINEBOX_RESPOND_MESSAGE;
if (requestedMessage !== undefined && (!requestedMessage.trim() || requestedMessage.length > 4000 || requestedMessage.includes('\0')))
  throw new Error('WORLDLINEBOX_RESPOND_MESSAGE must contain nonblank text of at most 4000 UTF-16 code units without NUL characters.');
const peerDiagnostic = process.env.WORLDLINEBOX_RESPOND_PEER_DIAGNOSTIC === '1';
const toolDiagnostic = peerDiagnostic || process.env.WORLDLINEBOX_RESPOND_TOOL_DIAGNOSTIC === '1';
// This probe does not resume unrelated old semantic tasks or dispatch their models.
// New message.send, agenda chat admission, history and source gates remain real.
prototype.restoreQueue = async () => undefined;
const originalAgenda = prototype.executeAgendaEvent;
const targetSources = new Set<string>();
const targetLabels = new Map<string, string>();
const taskTimings = new Map<string, { label: string; receivedMs: number; preparationStartedMs?: number; dispatchMs?: number; queueMs?: number; preparationMs?: number }>();
const targetSocialOwners = new Set<string>();
const relatedSocialChains = new Set<string>(), relatedNotificationSources = new Set<string>();
let observeNativeSocialJob: (jobId: string) => void = () => undefined;
const relatedSocialJob = (job: any) => !!job && (targetSources.has(job.sourceMessageId) || relatedSocialChains.has(job.chainId));
let releaseWorldInitialization!: () => void;
const worldInitialization = new Promise<void>(resolve => { releaseWorldInitialization = resolve; });
let worldInitializationReleased = false;
const initializationWorldRuns = new Set<string>();
prototype.executeAgendaEvent = async function (claim: any, ...rest: any[]) {
  // The real generic outbox pump must not be parked for ten minutes merely
  // because the probe has not selected its copied participants yet. Hold its
  // first entrance only while installing the isolation observers, then let
  // its original run, clock and native claims continue unchanged.
  if (scenario === 'concurrent' && claim.rule.executor === 'world' && claim.rule.referenceId === 'system_world_v1') {
    if (!worldInitializationReleased) initializationWorldRuns.add(claim.run.id);
    await worldInitialization;
  }
  let allowed = claim.rule.executor === 'chat' && targetSources.has(claim.rule.sourceMessageId);
  if (!allowed && scenario === 'concurrent' && claim.rule.executor === 'world' && claim.rule.referenceVersion === 'world-native-v1') {
    const response = await this.storage.request({ type: 'social.job.read', companionId: claim.rule.companionId, id: claim.rule.referenceId });
    observeNativeSocialJob(claim.rule.referenceId);
    allowed = relatedSocialJob(response.socialJob);
    if (!allowed) {
      const notification = (await this.storage.request({ type: 'social.notification.read', companionId: claim.rule.companionId, id: claim.rule.referenceId })).socialNotification;
      allowed = !!notification && relatedNotificationSources.has(notification.sourceMessageId);
    }
  }
  if (!allowed && scenario === 'concurrent' && claim.rule.executor === 'world' && claim.rule.referenceId === 'system_world_v1') allowed = targetSocialOwners.has(claim.rule.companionId);
  if (!allowed)
    return Promise.resolve({ outcome: 'waiting', stage: 'Isolated benchmark pauses unrelated semantic work.', nextCondition: 'benchmark.unpaused', notBefore: new Date(Date.now() + 600000).toISOString() });
  return originalAgenda.call(this, claim, ...rest);
};
for (const name of ['respond', 'memoryInference', 'captureExecutionEvidence', 'taskEvidenceCurrent', 'prepareModelAssetContext', 'requireCurrentAssets', 'prepareOwnerMemoryFiles', 'recentDialogue', 'configFor', 'replyTaskState', 'visibleFiles', 'toolImages', 'memoryFilesAttestedValid']) instrument(prototype, name);
const originalCall = prototype.callInValidation;
prototype.callInValidation = function (command: any, ...rest: any[]) {
  const started = performance.now(), owner = phase;
  return commandTrace.run([...(commandTrace.getStore() ?? []), command.type].slice(-16), () =>
    originalCall.call(this, command, ...rest).then((value: any) => { const saved = phase; phase = owner; record('call.' + command.type, performance.now() - started); phase = saved;
      observeProjection(owner, command.type, value); return value; }, (error: any) => { const saved = phase; phase = owner; record('call.' + command.type, performance.now() - started, true); phase = saved; throw error; }));
};
void app.whenReady().then(async () => {
  let service: any, statusTimer: ReturnType<typeof setInterval> | undefined;
  let emitProgress: (stage: string) => void = () => undefined;
  let refresh: ReturnType<typeof createCoalescedRefresh> | undefined, uiReads = 0, statusReads = 0;
  let refreshContent = true, uiContentReads = 0;
  const uiReadFailures: Array<{ phase: string; operation: string; name: string; code?: string; message?: string }> = [];
  let scheduling: ReturnType<typeof createFullRespondSchedulingProbe> | undefined;
  const schedulingOwners = new Map<string, string>(), socialAuthorizations = new Map<string, string>();
  const dispatches: any[] = [], progress: any[] = [];
  const preparationCounterSnapshots: unknown[] = [];
  const dispatchedTargets = new Set<string>(), transportFrames = new Map<string, { source?: string; purpose: string; owner: string; contextCounts?: Record<string, number> }>();
  const targetOwners = new Map<string, string>(), targetSocialJobs = new Map<string, { id: string; companionId: string }>();
  const providerOrigins = new Set<string>(); let modelNetworkCalls = 0;
  const automaticRecallAudit = createAutomaticRecallAudit();
  const providerFormats = new Map<string, AiApiFormat>(), providerObservations: FullRespondProviderObservation[] = [];
  const providerDrains = new Set<Promise<void>>(), publishedModelEvents = new Map<string, Record<string, unknown>>();
  const relatedTaskOutcomes: Array<{ phase: string; kind: 'social' | 'notification'; measured: boolean; completed: boolean; status?: string }> = [];
  const boundaryDrains = new Set<Promise<void>>(), boundaryStopFailures: string[] = [];
  const cancellation = scenario === 'cancel' ? createFullRespondCancellationProbe({ host: () => service,
    isTarget: sourceId => targetSources.has(sourceId), didDispatch: sourceId => dispatchedTargets.has(sourceId), nowMs: () => performance.now() - foregroundStarted,
    triggerPhase: 'memory', requirePriority: process.env.WORLDLINEBOX_RESPOND_CANCEL_URGENT === '1',
    resources: event => { if (!scheduling) throw new Error('Cancellation scheduling observer is not ready.');
      return scheduling.resources(event.companionId, event.sourceMessageId); } }) : undefined;
  const expectedDispatches = scenario === 'concurrent' && !peerDiagnostic ? 4 : 1;
  let finishDispatch!: () => void;
  let dispatched = new Promise<void>(resolve => { finishDispatch = resolve; });
  const globalConfig = JSON.parse(await readFile(path.join(root, 'global-config.json'), 'utf8'));
  const verifiedDevice = await readFile(path.join(root, 'embedding-device.json'), 'utf8').then(text => JSON.parse(text), () => undefined);
  const embeddingDevicePreference = verifiedDevice?.state === 'supported' && ['cpu', 'gpu'].includes(verifiedDevice.backend)
    ? { backend: verifiedDevice.backend as 'cpu' | 'gpu', ...(verifiedDevice.deviceId ? { deviceId: String(verifiedDevice.deviceId) } : {}) } : undefined;
  const globalApiKey = online ? safeStorage.decryptString(await readFile(path.join(root, 'global-provider-key.enc.bin'))) : 'offline-dispatch-boundary-only';
  providerOrigins.add(new URL(globalConfig.baseUrl ?? 'https://api.openai.com').origin);
  const providerFetch = net.fetch.bind(net);
  const observeProviderFetch = async (url: any, init: any, frame?: { source?: string; purpose: string; owner: string }) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const value: FullRespondProviderObservation & { actualToolNames: string[] } = { phase, label: frame?.source ? targetLabels.get(frame.source) : undefined,
      actualToolNames: automaticRecallAudit.provider(body),
      purpose: frame?.purpose, format: providerFormats.get(frame?.owner ?? '') ?? globalConfig.apiFormat ?? 'openai_chat',
      requestCharacters: body.length, requestBytes: Buffer.byteLength(body), startedAtMs: performance.now() - foregroundStarted };
    providerObservations.push(value);
    const response = await providerFetch(url, init); value.headersAtMs = performance.now() - foregroundStarted; value.status = response.status;
    const drain = observeFullRespondProviderResponse(response, value, () => performance.now() - foregroundStarted);
    providerDrains.add(drain); void drain.then(() => providerDrains.delete(drain), error => {
      providerDrains.delete(drain); value.observationFailure = error instanceof Error ? error.name : 'UnknownObservationFailure'; });
    return response;
  };
  const quotaRun = companionModelQuota.run.bind(companionModelQuota);
  (companionModelQuota as any).run = (work: any, operation: () => Promise<unknown>, signal?: AbortSignal) => {
    const queued = performance.now(); return quotaRun(work, () => { record('modelQuota.admissionWait', performance.now() - queued); return operation(); }, signal);
  };
  const settleTargetBoundary = async (sourceMessageId: string) => {
    const reason = Object.assign(new Error('BENCHMARK_FIRST_DISPATCH'), { code: 'BENCHMARK_FIRST_DISPATCH' });
    const social = targetSocialJobs.get(sourceMessageId);
    if (social) {
      const job = service.world.jobs.get(social.id); if (!job) throw new Error('The exact social boundary has no running task controller.');
      job.controller.abort(reason); await job.promise; return;
    }
    const works = (await service.storage.request({ type: 'work.list', sourceMessageId })).works ?? [];
    const active = works.map((work: any) => service.replies.get(work.id)).filter(Boolean);
    if (active.length !== 1) throw new Error('The exact reply boundary has no unique running task controller.');
    active[0].controller.abort(reason); await active[0].promise;
  };
  const encoder = new GlobalEmbeddingService({ userDataPath: app.getPath('userData'), bundleDirectory: path.join(project, 'resources', 'embedding-models'),
    ...(embeddingDevicePreference ? { devicePreference: () => embeddingDevicePreference } : {}),
    koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi') });
  instrument(encoder, 'embed', 'embedding.real_local');
  instrument(encoder, 'prepare', 'embedding.real_prepare');
  const embedding = new VcpEmbeddingGateway(encoder), chat = new VcpChatGateway();
  const runtime = new CompanionVcpRuntime({ vendorRoot: path.join(project, 'vendor/vcp-memory'), workerPath: path.join(project, 'src/main/vcp-memory/worker.cjs'),
    generationProfile: COMPANION_TEXT_GENERATION_PROFILE,
    resolveOwnerStorage: id => service.resolveOwnerStorage(id), resolveOwnerCleanupStorage: id => service.resolveOwnerCleanupStorage(id),
    prepareEmbedding: signal => encoder.prepare({ signal }),
    resolveEmbedding: async () => { const profile = await encoder.resolveProfile(); return embedding.configuration(profile.selectionId, profile); },
    resolveGenerationPlugins: async input => {
      const config = Object.freeze({ ...input.config });
      const route = await chat.registerOwnerRoute({ ownerId: input.ownerId, semanticProfile: { ownerId: input.ownerId, profileKey: input.profileKey, generation: COMPANION_TEXT_GENERATION_PROFILE }, credential: config.apiKey,
        generate: async (context, signal, work) => {
          await service.validateAssetsForModel(input.ownerId);
          return generateCompanionText(context, service.bindModelTransport(input.ownerId, { ...config, ownerId: input.ownerId, workPriority: work?.priority ?? 'foreground', requestPurpose: work?.nativePrompt ? 'timeline' : 'other',
            providerLifecycle: companionNativeProviderLifecycle(config, work?.nativeDispatchToken),
            resolveAssetContext: (context: any, kind: any) => service.prepareModelAssetContext(input.ownerId, context, kind, work?.nativePrompt, work?.nativePrompt ? work.nativePrompt.kind === 'timeline' ? 'native_timeline' : 'native_summary' : 'vcp_focus_guidance') }), signal,
            { fetchFn: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, { ...init, credentials: 'omit' }), timeoutMs: 120000 });
        } }); return { plugins: { chat: route.chat }, dispose: route.dispose };
    }, launch: file => { const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH;
      const child = fork(file, [], { execPath: process.execPath, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const pending = new Map<string, { operation: string; started: number; phase: string }>();
      child.on('message', (value: any) => { const request = pending.get(value?.requestId); if (!request) return;
        pending.delete(value.requestId); const saved = phase; phase = request.phase; record('native.' + request.operation, performance.now() - request.started, value.ok === false); phase = saved;
        if (Array.isArray(value.value?.upsertIds)) nativeTransitions.push({ phase: request.phase, operation: request.operation,
          upserts: value.value.upsertIds.length, removals: value.value.removedIds?.length ?? 0 });
      });
      return { postMessage: value => { const envelope = value as any;
        if (envelope?.requestId && envelope?.command?.type) {
          const command = envelope.command; pending.set(envelope.requestId, { operation: command.type, started: performance.now(), phase });
          if (command.type === 'replace' || command.type === 'projection-delta') nativeTransitions.push({ phase, operation: command.type, notes: command.notes?.length ?? 0, removals: command.removedIds?.length ?? 0 });
          if (command.type === 'projection-inspect') nativeTransitions.push({ phase, operation: 'projection-inspect-request', notes: command.descriptors?.length ?? 0 });
        }
        child.send(value as Serializable);
      }, on: (event: any, listener: any) => { child.on(event, listener); }, kill: () => { child.kill(); } }; } });
  (net as any).fetch = async (_url: any, init: any) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const sha256 = createHash('sha256').update(body).digest('hex'), frame = transportFrames.get(sha256);
    const target = frame?.source && ['companion_reply', 'world_social'].includes(frame.purpose) && targetSources.has(frame.source) ? frame.source : undefined;
    dispatches.push({ phase, atMs: performance.now() - foregroundStarted, target: !!target, label: target ? targetLabels.get(target) : undefined, purpose: frame?.purpose, bytes: Buffer.byteLength(body), sha256,
      contextCounts: frame?.contextCounts });
    if (target) {
      const firstDispatch = !dispatchedTargets.has(target);
      const timing = taskTimings.get(target); if (timing && firstDispatch) { timing.dispatchMs = performance.now() - foregroundStarted;
        if (timing.preparationStartedMs !== undefined) { timing.queueMs = timing.preparationStartedMs - timing.receivedMs; timing.preparationMs = timing.dispatchMs - timing.preparationStartedMs; } }
      dispatchedTargets.add(target); if (dispatchedTargets.size === expectedDispatches) finishDispatch();
      if (firstDispatch) preparationCounterSnapshots.push({ phase, label: targetLabels.get(target), elapsedMs: performance.now() - foregroundStarted,
        metrics: Object.entries(metrics).filter(([key]) => key.startsWith(phase + ':')).map(([key, value]) => [key, { ...value }]) });
      emitProgress('provider_dispatch');
      if (online) {
        if (!providerOrigins.has(new URL(String(_url)).origin)) throw new Error('Online validation refused an unconfigured provider origin.');
        modelNetworkCalls++; return observeProviderFetch(_url, init, frame);
      }
      // End only this measured task at its first boundary. This releases the
      // real model quota while the other independently admitted tasks prepare.
      return new Promise<Response>((_resolve, reject) => { const abort = () => reject(Object.assign(new Error('BENCHMARK_FIRST_DISPATCH'), { code: 'BENCHMARK_FIRST_DISPATCH' }));
        init?.signal?.addEventListener('abort', abort, { once: true }); if (init?.signal?.aborted) abort();
        if (scenario === 'concurrent') queueMicrotask(() => { const drain = settleTargetBoundary(target);
          boundaryDrains.add(drain); void drain.then(() => boundaryDrains.delete(drain), error => { boundaryDrains.delete(drain); boundaryStopFailures.push(error instanceof Error ? error.message : 'Boundary stop failed.'); }); });
      });
    }
    if (online && frame && providerOrigins.has(new URL(String(_url)).origin)) { modelNetworkCalls++; return observeProviderFetch(_url, init, frame); }
    throw Object.assign(new Error('Offline benchmark stops at the real model transport boundary.'), { code: 'BENCHMARK_NETWORK_DISABLED' });
  };
  const report: any = { schema: 'worldlinebox.full-respond-real-library-benchmark-v1', sourceLibraryMutated: false, realService: true, realUtilityProcess: true,
    realChatAgendaClaim: true, embedding: 'real bundled local encoder; no vectors mocked', modelNetworkCalls: 0, realProviderRoundTrip: online,
    embeddingDevicePreference, embeddingDeviceGate: embeddingDevicePreference
      ? 'Reuses the original verified device preference; no synthetic device test or vectors.' : 'No verified preference was available; production automatic device selection applies.',
    plaintextCredentialsStored: false, messageInput: requestedMessage === undefined
      ? online ? 'new casual test message' : 'latest real user message copied in the isolated library' : 'caller-supplied test message; only its digest and lengths are reported',
    userToolPolicy: online && process.env.WORLDLINEBOX_RESPOND_TOOLS_DISABLED === '1' ? 'all-disabled comparison only' : 'copied from the latest real user source; undefined preserves the configured default',
    credentialContextReady: online ? !!globalApiKey : undefined,
    learningAssetsAdapter: true,
    learningAssetValidation: { snapshotRequests: 0, validateRequests: 0, snapshotEntries: 0, externalWorkerRequests: 0 },
    externalAssetWorker: 'The real adapter validates the empty grant snapshot. Any grant entry or external asset Worker request fails this benchmark instead of returning simulated assets.',
    paused: ['unrelated old queue recovery', 'unrelated agenda semantic execution'],
    relatedPeerPolicy: 'Actual descendants of measured peer chains and notifications from their real delegation sources continue normally. Pair chains retain the production four-message bound; no later task waits behind a test-deferred related message.',
    algorithm: process.env.WORLDLINEBOX_RESPOND_BENCH_ALGORITHM,
    modelQuotaLimits: companionModelQuota.snapshot().limits, offlineBoundaryPolicy: 'Each concurrent task stops separately at its first dispatch; actual quota is released before waiting for later tasks.',
    measurementEndpoint: online ? 'Actual durable reply completion; no target is aborted at its model dispatch.' : 'Each target first actual model transport dispatch.',
    dispatchAggregate: 'toFirstDispatchMs is the time until all measured targets have reached their own first model transport dispatch; taskTimings preserves each task separately.',
    scenario, expectedDispatches, uiRefreshMinimumMs: 500, uiProgressRequest: 'state.progress', uiRefreshTrigger: 'actual companions-changed IPC through production createCoalescedRefresh', worldTickMs: 500 };
  const started = performance.now();
  emitProgress = stage => {
    const observed = providerObservations.filter(value => value.phase === phase);
    process.stdout.write(JSON.stringify({ kind: 'worldlinebox-benchmark-progress', stage, phase,
      elapsedMs: foregroundStarted ? performance.now() - foregroundStarted : performance.now() - started,
      dispatched: dispatchedTargets.size, expected: expectedDispatches,
      providerResponses: observed.filter(value => value.status !== undefined).length,
      firstContent: observed.filter(value => value.firstContentDeltaAtMs !== undefined).length,
      taskCounts: scheduling?.progress([...targetSources], [...relatedSocialChains]) }) + '\n');
  };
  const progressTimer = setInterval(() => { if (foregroundStarted) emitProgress('waiting'); }, 15000); progressTimer.unref();
  try {
    service = new CompanionService({ userData: app.getPath('userData'), dataRoot: root, memoryLibraryRoot: path.join(root, 'owners'), workerPath, appPath: project, memoryRuntime: runtime,
      learningAssets: companionLearningAssets({ memoryRoot: path.join(root, 'owners'), storageRequest: async command => {
        if (!service) throw new Error('The real companion asset-validation service is not initialized.');
        if (command.type === 'learning.assets.snapshot') report.learningAssetValidation.snapshotRequests++;
        if (command.type === 'learning.assets.validate') report.learningAssetValidation.validateRequests++;
        const response = await service.requestAssetValidation(command);
        const entries = response.learningAssetSnapshot?.entries.length ?? 0;
        report.learningAssetValidation.snapshotEntries += entries;
        if (entries) throw new Error('The real cloned corpus has external learning grants; its canonical asset Worker is required before benchmarking.');
        return response;
      }, request: async () => {
        report.learningAssetValidation.externalWorkerRequests++;
        throw new Error('An unexpected external asset Worker request cannot be simulated by this real-corpus benchmark.');
      } }),
      window: () => ({ isDestroyed: () => false, webContents: { send: (channel: string, event: any) => {
        if (channel === COMPANIONS_CHANGED_CHANNEL) {
          const kind = event?.kind === 'progress' ? 'progress' : 'full', chain = commandTrace.getStore() ?? [];
          const stack = kind === 'full' ? new Error().stack?.split('\n').slice(2, 7) ?? [] : [];
          const identity = phase + ':' + kind + ':' + chain.join('>') + ':' + stack.join('\n');
          const origin = changeOrigins.get(identity) ?? { phase, kind, chain, stack, calls: 0 }; origin.calls++; changeOrigins.set(identity, origin);
          // A real renderer receives this on another process and its next IPC
          // starts a new validation entrance. Never lend it this task's ALS.
          detachedCompanionExecutionValidation(() => { if (event?.kind !== 'progress') refreshContent = true; void refresh?.trigger(); });
        }
        if (channel.includes('reply-stream') && targetSources.has(event?.sourceMessageId)) {
          const label = targetLabels.get(event.sourceMessageId)!, summary = publishedModelEvents.get(label) ?? { label };
          if (event.phase === 'streaming' && event.text) summary.firstPublishedTextAtMs ??= performance.now() - foregroundStarted;
          if (event.modelUsage) { summary.actualUsage = event.modelUsage.current?.actual; summary.estimatedInput = event.modelUsage.current?.estimate; }
          publishedModelEvents.set(label, summary);
        }
        if (channel.includes('reply-stream') && event?.progress) {
          detachedCompanionExecutionValidation(() => cancellation?.observe(event));
          if (progress.at(-1)?.detail !== event.progress.detail) progress.push({ atMs: performance.now() - foregroundStarted, phase: event.progress.phase, detail: event.progress.detail });
        }
      } } }) as any,
      getConfig: () => ({ ...globalConfig, apiKey: globalApiKey }), hasConfig: () => true, dsh: () => undefined,
      onTiming: timing => { if (timing.durationMs >= 100) events.push({ phase, atMs: performance.now() - phaseStarted, stage: timing.operation, durationMs: timing.durationMs }); },
      report: error => { if ((error as any)?.code === 'BENCHMARK_FIRST_DISPATCH') return;
        if (errors.length < 80) errors.push({ phase, name: error instanceof Error ? error.name : typeof error,
        ...(error instanceof Error ? { stack: error.stack?.split('\n').slice(1, 6) } : {}), ...((error as any)?.code ? { code: String((error as any).code) } : {}) }); } });
    if (diagnosticProfile) {
      let revision = service.sourceValidationRevision;
      Object.defineProperty(service, 'sourceValidationRevision', { configurable: true, enumerable: true,
        get: () => revision, set: next => {
          const difference = next - revision; revision = next;
          if (!difference) return;
          const operation = commandTrace.getStore()?.at(-1) ?? '<outside-call>', stack = callerStack().slice(1, 7);
          const identity = phase + ':' + operation + ':' + stack.join('\n');
          const row = sourceRevisionWrites.get(identity) ?? { phase, operation, writes: 0, increment: 0, stack };
          row.writes++; row.increment += difference; sourceRevisionWrites.set(identity, row);
        } });
    }
    const raw = service.storage.request.bind(service.storage);
    service.storage.request = async (command: any) => { const started = performance.now(), requestPhase = phase;
      if (['execution.capabilities.validate', 'execution.sources', 'cognition.registry.read'].includes(command.type)) {
        const chain = commandTrace.getStore() ?? [], identity = requestPhase + ':' + command.type + ':' + chain.join('>');
        const value = rawCommandChains.get(identity) ?? { phase: requestPhase, operation: command.type, chain, calls: 0 }; value.calls++; rawCommandChains.set(identity, value);
      }
      if (['execution.capabilities.validate', 'execution.sources', 'memory.revisions.describe', 'memory.revision.describe', 'cognition.registry.read'].includes(command.type)) {
        const shape: Record<string, string | number> = {};
        for (const name of ['actions', 'sourceMessageIds', 'memoryIds', 'roots', 'relativePaths', 'artifactIds']) if (Array.isArray(command[name])) shape[name] = command[name].length;
        if (command.type === 'cognition.registry.read') shape.mode = command.relativePaths ? 'paths' : command.artifactIds ? 'ids' : command.relativePath ? 'path' : 'id';
        const identity = requestPhase + ':' + command.type + ':' + JSON.stringify(shape);
        const value = rawShapes.get(identity) ?? { phase: requestPhase, operation: command.type, shape, calls: 0 }; value.calls++; rawShapes.set(identity, value);
      }
      if (process.env.WORLDLINEBOX_RESPOND_STACKS === '1' && stackOperations.has(command.type)) {
        const key = phase + ':' + command.type, count = (rawStackCounts.get(key) ?? 0) + 1; rawStackCounts.set(key, count);
        if (count <= 128 || count % 16 === 0) {
          const stack = new Error().stack?.split('\n').slice(2, ['execution.capabilities.validate', 'execution.sources'].includes(command.type) ? 18 : 8) ?? [], identity = key + ':' + stack.join('\n');
          const entry = rawCallsites.get(identity) ?? { operation: command.type, phase, samples: 0, stack }; entry.samples++; rawCallsites.set(identity, entry);
        }
      }
      try { const response = await raw(command); scheduling?.observe(command, response); return response; }
      finally { const saved = phase; phase = requestPhase; record('raw.' + command.type, performance.now() - started); phase = saved; } };
    // The production world clock, integrity work and physical idle prime stay
    // live. Only unrelated semantic agenda events are paused above.
    service.topicCompaction.start = () => undefined;
    const state = (await service.handle({ type: 'state' })).state;
    for (const owner of state.companions) {
      if (owner.llm?.baseUrl) providerOrigins.add(new URL(owner.llm.baseUrl).origin);
      providerFormats.set(owner.id, owner.llm?.apiFormat ?? globalConfig.apiFormat ?? 'openai_chat');
    }
    report.initializationMs = performance.now() - started;
    let source: any, room: any;
    for (const candidate of [...state.conversations].sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (candidate.kind !== 'private' || candidate.peerOnly) continue;
      const owner = state.companions.find((value: any) => candidate.memberIds.includes(value.id) && value.active !== false); if (!owner) continue;
      const found = await service.storage.request({ type: 'messages', conversationId: candidate.id, topicId: candidate.activeTopicId ?? undefined, limit: 100 });
      const latest = found.messages?.findLast((message: any) => message.authorId === 'user' && message.content.trim() && message.status === 'sent');
      if (latest) { source = latest; room = candidate; break; }
    }
    if (!source || !room) throw new Error('Copied real library has no usable current private user message.');
    if (scenario === 'cancel') {
      schedulingOwners.set(room.memberIds[0], 'original');
      scheduling = createFullRespondSchedulingProbe({ root, nowMs: () => performance.now() - foregroundStarted,
        phase: () => phase, owners: () => schedulingOwners, targetSources: () => targetSources });
    }
    let newPeer: any;
    if (scenario === 'concurrent') {
      const created = await service.handle({ type: 'companion.create', operationId: randomUUID(), companionId: randomUUID(), companion: {
        name: '大肥鱼', description: '参与伙伴交流的独立伙伴。', persona: '你叫大肥鱼。你性格沉稳、亲切，依据实际经历和消息自然交流。',
        avatar: 'sister', model: '', proactive: true, inputMode: 'queue',
      } });
      if (!created.ok || !created.companion) throw new Error('Official creation did not commit the isolated 大肥鱼 instance.');
      newPeer = created.companion; report.createdPeerOfficially = true;
      const activated = await service.handle({ type: 'companion.set-active', id: newPeer.id, active: true, expectedRevision: newPeer.revision });
      if (!activated.ok) throw new Error('The officially created isolated peer could not be activated.');
      newPeer = activated.companion ?? newPeer; report.activatedPeerOfficially = true;
      if (process.env.WORLDLINEBOX_RESPOND_CREATION_ONLY === '1') { report.creationOnly = true; return; }
      // The measured peer contacts are explicit user delegations, separate
      // from autonomous initiative and its real cooldown. Publish each source
      // through the official entrance, then stop only its redundant chat task.
      // The immutable user source remains the actual continuity authority.
      for (const [owner, recipientName] of [[room.memberIds[0], newPeer.name], [newPeer.id, state.companions.find((value: any) => value.id === room.memberIds[0])?.name ?? '小肥鱼']]) {
        const opened = await service.handle({ type: 'conversation.open', companionId: owner });
        if (!opened.ok || !opened.conversation) throw new Error('The official user delegation has no private conversation.');
        const setup = await service.handle({ type: 'message.send', conversationId: opened.conversation.id,
          content: `请向${recipientName}发一句问候，并接收对方的回复。这是我明确委托的伙伴交流。`,
          toolPolicy: { dsh: false, browser: false, memory: false, world: false, social: true, planning: false, observation: false, files: false },
          clientId: 'full_respond_authorized_setup_' + owner, delivery: 'queue' });
        if (!setup.ok || !setup.message) throw new Error('The official user delegation was not published.');
        socialAuthorizations.set(owner, setup.message.id);
        relatedNotificationSources.add(setup.message.id);
        const works = (await service.storage.request({ type: 'work.list', sourceMessageId: setup.message.id })).works ?? [];
        if (!works.length) throw new Error('The official delegation did not create its independent task.');
        for (const work of works) {
          await service.handle({ type: 'reply.cancel', conversationId: work.conversationId, workId: work.id });
          await service.replies.get(work.id)?.promise;
        }
        if ((await service.storage.request({ type: 'work.list', sourceMessageId: setup.message.id })).works?.some((work: any) => !['cancelled', 'done'].includes(work.status)))
          throw new Error('A delegation setup task still occupies capacity.');
      }
      report.peerContactAuthority = 'Two real official user delegation sources; their independent setup reply tasks were cancelled before the measured cohort.';
      schedulingOwners.set(room.memberIds[0], 'original'); schedulingOwners.set(newPeer.id, 'new_peer');
      scheduling = createFullRespondSchedulingProbe({ root, nowMs: () => performance.now() - foregroundStarted,
        phase: () => phase, owners: () => schedulingOwners, targetSources: () => targetSources });
      targetSocialOwners.add(room.memberIds[0]); targetSocialOwners.add(newPeer.id);
      const processSocial = service.world.processSocial.bind(service.world);
      service.world.processSocial = async (job: any, signal: AbortSignal) => {
        if (relatedSocialJob(job)) {
          const outcome = { phase, kind: 'social' as const, measured: targetSources.has(job.sourceMessageId), completed: false, status: undefined as string | undefined };
          relatedTaskOutcomes.push(outcome);
          const timing = taskTimings.get(job.sourceMessageId); if (timing) timing.preparationStartedMs ??= performance.now() - foregroundStarted;
          await processSocial(job, signal);
          outcome.status = (await service.storage.request({ type: 'social.job.read', companionId: job.companionId, id: job.id })).socialJob?.status;
          outcome.completed = outcome.status === 'done'; return;
        }
        await service.call({ type: 'social.job.defer', companionId: job.companionId, id: job.id, leaseToken: job.leaseToken,
          error: 'Isolated benchmark pauses unrelated semantic work.', retryAfterMs: 600000 });
      };
      const processNotification = service.world.processNotification.bind(service.world);
      service.world.processNotification = async (job: any, signal: AbortSignal) => {
        if (relatedNotificationSources.has(job.sourceMessageId)) {
          const outcome = { phase, kind: 'notification' as const, measured: false, completed: false, status: undefined as string | undefined };
          relatedTaskOutcomes.push(outcome); await processNotification(job, signal);
          outcome.status = (await service.storage.request({ type: 'social.notification.read', companionId: job.companionId, id: job.id })).socialNotification?.status;
          outcome.completed = outcome.status === 'done'; return;
        }
        await service.call({ type: 'social.notification.defer', companionId: job.companionId, id: job.id, leaseToken: job.leaseToken,
          error: 'Isolated benchmark pauses unrelated semantic work.', retryAfterMs: 600000 });
      };
      service.world.process = async (job: any) => {
        await service.call({ type: 'world.job.defer', id: job.id, leaseToken: job.leaseToken,
          error: 'Isolated benchmark pauses unrelated semantic work.', retryAfterMs: 600000 });
      };
    }
    const journalTrace = new AsyncLocalStorage<{ phase: string; originMs: number }>();
    const journalContext = () => journalTrace.getStore() ?? { phase, originMs: foregroundStarted };
    const journalMetric = (operation: string, context: { phase: string; originMs: number }, started: number, outcome: 'returned' | 'throw', error?: any) => {
      const durationMs = performance.now() - started;
      record(operation, durationMs, outcome === 'throw', context.phase);
      methodDiagnostics.push({ phase: context.phase, operation, startedAtMs: started - context.originMs, durationMs, outcome,
        ...(outcome === 'throw' ? { errorName: error instanceof Error ? error.name : typeof error, code: error?.code } : {}) });
    };
    const timeJournal = async (operation: string, work: () => Promise<any>, context = journalContext()) => {
      const started = performance.now();
      try { const value = await work(); journalMetric(operation, context, started, 'returned'); return value; }
      catch (error) { journalMetric(operation, context, started, 'throw', error); throw error; }
    };
    if (diagnosticProfile) {
      const options = service.contextSnapshots.options, references = options.references;
      if (typeof references === 'function') options.references = (...args: any[]) => timeJournal('contextSnapshots.references', () => references.apply(options, args));
      for (const name of ['validateTaskAssetFrame', 'validateTaskAssets']) {
        const original = service[name];
        service[name] = function (...args: any[]) { return timeJournal(name, () => original.apply(this, args)); };
      }
      const serial = service.contextSnapshots.serial;
      service.contextSnapshots.serial = async function (owner: string, work: () => Promise<any>, ...rest: any[]) {
        const context = journalContext(), queued = performance.now(); let started = false;
        try {
          return await serial.call(this, owner, () => {
            started = true; journalMetric('contextSnapshots.serial.wait', context, queued, 'returned');
            return timeJournal('contextSnapshots.serial.work', work, context);
          }, ...rest);
        } catch (error) { if (!started) journalMetric('contextSnapshots.serial.wait', context, queued, 'throw', error); throw error; }
      };
    }
    const prepareAttempt = service.contextSnapshots.prepareAttempt.bind(service.contextSnapshots);
    service.contextSnapshots.prepareAttempt = async (input: any) => {
      const diagnostic = diagnosticProfile ? { phase, operation: 'contextSnapshots.prepareAttempt', startedAtMs: performance.now() - foregroundStarted, caller: callerStack() } : undefined;
      const begun = performance.now(), attemptPhase = phase;
      let data: any; try { data = JSON.parse(input.frame.input); } catch { /* Opaque contracts remain opaque. */ }
      transportFrames.set(createHash('sha256').update(input.providerBody).digest('hex'), { purpose: input.frame.purpose, owner: input.frame.companionId,
        source: data?.taskRequest?.sourceMessageId ?? data?.source?.id ?? data?.invocation?.sourceMessageId,
        contextCounts: { messages: data?.messages?.length ?? 0, memories: data?.memories?.length ?? 0, memorySources: data?.memorySources?.length ?? 0,
          recalledReferences: data?.memoryRecall?.context?.evidence?.references?.length ?? 0,
          memoryFileReceipts: data?.memoryRecall?.context?.fileReceipts?.length ?? 0,
          memoryTextCharacters: typeof data?.memoryRecall?.context?.text === 'string' ? data.memoryRecall.context.text.length : 0 } });
      let attempt: any;
      try { attempt = await journalTrace.run({ phase: attemptPhase, originMs: foregroundStarted }, () => prepareAttempt(input)); if (diagnostic) methodDiagnostics.push({ ...diagnostic, outcome: 'returned', durationMs: performance.now() - begun }); }
      catch (error) { if (diagnostic) methodDiagnostics.push({ ...diagnostic, outcome: 'throw', errorName: error instanceof Error ? error.name : typeof error, code: (error as any)?.code, durationMs: performance.now() - begun }); throw error; }
      finally { record('contextSnapshots.prepareAttempt', performance.now() - begun, false, attemptPhase); }
      if (!diagnosticProfile) return attempt;
      return Object.fromEntries(['beforeDispatch', 'dispatched', 'complete'].map(method => [method, async (...args: any[]) => {
        const started = performance.now(), context = { phase, operation: 'contextSnapshots.' + method, startedAtMs: started - foregroundStarted };
        try { const value = await journalTrace.run({ phase: context.phase, originMs: foregroundStarted }, () => attempt[method](...args)); methodDiagnostics.push({ ...context, outcome: 'returned', durationMs: performance.now() - started }); return value; }
        catch (error) { methodDiagnostics.push({ ...context, outcome: 'throw', errorName: error instanceof Error ? error.name : typeof error, code: (error as any)?.code, durationMs: performance.now() - started }); throw error; }
      }]));
    };
    for (const name of ['recall', 'contextFresh', 'contextValid', 'contextFilesValid']) instrument(service.memory, name, 'memory.' + name);
    automaticRecallAudit.install(service.memory, { phase: () => phase, label: sourceId => targetLabels.get(sourceId) });
    instrument(service.profiles, 'prepare', 'profiles.prepare'); instrument(service.assetProfiles, 'load', 'profiles.load');
    instrument(service.liveFiles, 'materialize', 'liveFiles.materialize'); instrument(service.liveFiles, 'read', 'liveFiles.read');
    instrument(service.liveFiles, 'validateAttested', 'liveFiles.validateAttested');
    // Source registration happens inside the actual storage request, before
    // launchReply can wake/claim the agenda event.
    const request = service.storage.request.bind(service.storage);
    const peerDiagnostics = toolDiagnostic ? createPeerToolDiagnostics({ root, targets: () => targetSources,
      stopAfter: process.env.WORLDLINEBOX_RESPOND_TOOL_DIAGNOSTIC_LIMIT === '0' ? 0 : 5,
      now: () => performance.now() - foregroundStarted,
      cancel: async task => detachedCompanionExecutionValidation(async () => {
        const job = (await request({ type: 'social.job.read', companionId: task.companionId, id: task.jobId })).socialJob;
        if (!job?.agendaParentRunId) throw new Error('The diagnostic native job has no live agenda parent.');
        if (job.status !== 'running' || !service.world.jobs.has(job.id)) throw new Error('The exact diagnostic invocation is no longer an active native runtime.');
        const run = (await request({ type: 'agenda.run.read', companionId: job.companionId, id: job.agendaParentRunId })).agendaRun;
        if (!run) throw new Error('The exact diagnostic agenda run is unavailable.');
        const started = performance.now(), runtime = service.world.jobs.get(job.id)?.promise;
        const stopped = await service.handle({ type: 'agenda.run.control', companionId: job.companionId,
          id: run.id, expectedRevision: run.revision, operationId: randomUUID(), action: 'cancel' });
        const ackMs = performance.now() - started;
        await runtime;
        const actual = (await request({ type: 'social.job.read', companionId: job.companionId, id: job.id })).socialJob;
        return { ok: stopped.ok, ackMs, settledMs: performance.now() - started, nativeStatus: actual?.status,
          actualInvocationStopped: ['cancelled', 'abandoned', 'parked'].includes(actual?.status) && !service.world.jobs.has(job.id) };
      }) }) : undefined;
    const pendingSocialOperations = new Map<string, { label: string; companionId: string }>();
    const observedNativeJobs = new Set<string>();
    report.peerReceiptObservation = { calls: 0, queryCount: 0, totalMs: 0, maxMs: 0, registered: 0 };
    observeNativeSocialJob = jobId => {
      report.peerReceiptObservation.calls++;
      if (!pendingSocialOperations.size || observedNativeJobs.has(jobId)) return;
      observedNativeJobs.add(jobId);
      const begun = performance.now(); report.peerReceiptObservation.queryCount++;
      const receipt = scheduling?.socialReceiptForJob(jobId);
      const operation = receipt && pendingSocialOperations.get(receipt.clientId);
      if (receipt && operation) {
        const id = receipt.messageId;
        targetSources.add(id); targetLabels.set(id, operation.label); targetOwners.set(id, operation.companionId);
        if (!taskTimings.has(id)) taskTimings.set(id, { label: operation.label, receivedMs: performance.now() - foregroundStarted });
        targetSocialJobs.set(id, { id: receipt.jobId, companionId: receipt.companionId });
        relatedSocialChains.add(receipt.chainId);
        pendingSocialOperations.delete(receipt.clientId);
        report.peerReceiptObservation.registered++;
      }
      const elapsed = performance.now() - begun;
      report.peerReceiptObservation.totalMs += elapsed;
      report.peerReceiptObservation.maxMs = Math.max(report.peerReceiptObservation.maxMs, elapsed);
    };
    service.storage.request = async (command: any) => { const response = await request(command);
      if (command.type === 'message.append' && command.message.clientId?.startsWith('full-respond-benchmark') && response.message) {
        const label = command.message.clientId.includes('_2') ? 'user_2_to_original' : 'user_1_to_original';
        targetSources.add(response.message.id); targetLabels.set(response.message.id, command.message.clientId.endsWith('_after_cancel') ? 'recovery_after_cancel'
          : command.message.clientId.endsWith('_cancel') ? 'cancelled_during_preparation' : (phase === 'warm_foreground' ? 'warm_' : '') + label);
        taskTimings.set(response.message.id, { label: targetLabels.get(response.message.id)!, receivedMs: performance.now() - foregroundStarted });
        targetOwners.set(response.message.id, room.memberIds[0]);
      }
      if (command.type === 'social.send' && command.clientId?.startsWith('full_respond_benchmark_') && response.socialMessage?.message) {
        const id = response.socialMessage.message.id, label = command.clientId.includes('new_to_original') ? 'new_peer_to_original' : 'original_to_new_peer';
        targetSources.add(id); targetLabels.set(id, (phase === 'warm_foreground' ? 'warm_' : '') + label);
        if (!taskTimings.has(id)) taskTimings.set(id, { label: targetLabels.get(id)!, receivedMs: performance.now() - foregroundStarted });
        targetOwners.set(id, command.companionId === room.memberIds[0] ? newPeer.id : room.memberIds[0]);
      }
      if (command.type === 'social.job.claim' && response.socialJob) {
        observeNativeSocialJob(response.socialJob.id);
        if (targetSources.has(response.socialJob.sourceMessageId)) relatedSocialChains.add(response.socialJob.chainId);
        targetSocialJobs.set(response.socialJob.sourceMessageId, { id: response.socialJob.id, companionId: response.socialJob.companionId });
      }
      await peerDiagnostics?.observe(command);
      return response; };
    const messageContent = requestedMessage ?? (online ? '早上好，简单聊一句就好，不需要执行任何操作。' : source.content);
    report.userMessageInput = { sha256: createHash('sha256').update(messageContent).digest('hex'), length: messageContent.length,
      byteLength: Buffer.byteLength(messageContent), overridden: requestedMessage !== undefined };
    const sendUser = (suffix = '') => detachedCompanionExecutionValidation(() => service.handle({ type: 'message.send', conversationId: room.id, topicId: source.topicId,
      content: messageContent,
      toolPolicy: online && process.env.WORLDLINEBOX_RESPOND_TOOLS_DISABLED === '1'
        ? { dsh: false, browser: false, memory: false, world: false, social: false, planning: false, observation: false, files: false } : source.toolPolicy,
      ...(scenario === 'cancel' && suffix === '_cancel' && process.env.WORLDLINEBOX_RESPOND_CANCEL_URGENT === '1' ? { priority: 'urgent' } : {}),
      clientId: 'full-respond-benchmark' + suffix, delivery: 'queue' }));
    const socialSend = async (suffix = '') => {
      const originalOwner = room.memberIds[0], peer = (await service.call({ type: 'social.conversation.ensure', companionId: originalOwner, memberIds: [originalOwner, newPeer.id] })).socialConversation;
      if (!peer) throw new Error('Official peer conversation was not created.');
      for (const [direction, companionId] of (peerDiagnostic ? [['new_to_original', originalOwner]] : [['new_to_original', originalOwner], ['original_to_new', newPeer.id]]) as Array<[string, string]>)
        pendingSocialOperations.set('full_respond_benchmark_' + direction + suffix, {
          label: (phase === 'warm_foreground' ? 'warm_' : '') + (direction === 'new_to_original' ? 'new_peer_to_original' : 'original_to_new_peer'), companionId });
      const commands = [{ type: 'social.send', companionId: newPeer.id, conversationId: peer.id, channel: 'phone', content: '早上好，现在方便聊聊吗？', authorizationMessageId: socialAuthorizations.get(newPeer.id), clientId: 'full_respond_benchmark_new_to_original' + suffix },
        ...(!peerDiagnostic ? [{ type: 'social.send', companionId: originalOwner, conversationId: peer.id, channel: 'phone', content: '早上好，很高兴认识你。', authorizationMessageId: socialAuthorizations.get(originalOwner), clientId: 'full_respond_benchmark_original_to_new' + suffix }] : [])];
      const sent = await Promise.all(commands.map(command => service.socialDelivery(command)));
      const receipt = { phase, accepted: sent.filter(value => !!value.socialMessage).length, pending: sent.filter(value => value.socialPending).length,
        ok: sent.every(value => value.ok), atMs: performance.now() - foregroundStarted };
      (report.socialDeliveryReceipts ??= []).push(receipt);
    };
    const heldWorldTasks = [...initializationWorldRuns].map(id => service.agenda.jobs.get(id)?.promise).filter(Boolean);
    worldInitializationReleased = true; releaseWorldInitialization();
    await Promise.all(heldWorldTasks);
    report.initializationWorldRunsDrained = heldWorldTasks.length;
    if (process.env.WORLDLINEBOX_RESPOND_SETUP_ONLY === '1') {
      for (const companionId of schedulingOwners.keys()) scheduling?.observe({ type: 'agenda.claim', companionId }, { ok: true });
      report.authorizationSetupOnly = true; return;
    }
    report.libraryOpenToFirstSendMs = performance.now() - started;
    phase = 'foreground'; phaseStarted = foregroundStarted = performance.now();
    refresh = createCoalescedRefresh(async () => { uiReads++; const full = refreshContent; refreshContent = false; if (full) uiContentReads++;
      const commands: any[] = full ? [{ type: 'state' }, { type: 'messages', conversationId: room.id, topicId: room.activeTopicId ?? undefined, limit: 50 },
        { type: 'topic.list', conversationId: room.id, limit: 50 }] : [{ type: 'state.progress' }];
      const completed = await Promise.allSettled(commands.map(command => detachedCompanionExecutionValidation(() => service.handle(command))));
      if (full) {
        const messageResult = completed[1];
        if (messageResult?.status === 'fulfilled' && messageResult.value?.ok === true) {
          const ids = [...new Set<string>((messageResult.value.messages ?? []).flatMap((message: any) =>
            [message.actionId, ...(message.segments ?? []).flatMap((segment: any) => segment.actionIds ?? [])])
            .filter((id: unknown): id is string => typeof id === 'string' && !!id))];
          for (let start = 0; start < Math.max(ids.length, 1); start += 200) {
            const command = { type: 'actions' as const, conversationId: room.id, ids: ids.slice(start, start + 200), includeOngoing: start === 0 };
            commands.push(command);
            completed.push((await Promise.allSettled([detachedCompanionExecutionValidation(() => service.handle(command))]))[0]!);
          }
        }
      }
      completed.forEach((result, index) => { if (result.status === 'rejected' || result.value?.ok === false)
        { const reason = result.status === 'rejected' ? result.reason : undefined;
          uiReadFailures.push({ phase, operation: commands[index]!.type, name: reason instanceof Error ? reason.name : 'UnavailableResponse',
            ...(typeof reason?.code === 'string' ? { code: reason.code } : {}),
            ...(reason instanceof Error && !reason.message.includes('http') ? { message: reason.message.slice(0, 200) } : {}) }); } });
    }, undefined, 500);
    void refresh.trigger();
    statusTimer = setInterval(() => { statusReads++; void service.handle({ type: 'world.status', companionId: room.memberIds[0] }).catch(() => undefined); }, 1500);
    let sent: any[];
    if (cancellation) { const cancelled = await cancellation.cancelAndRecover(sendUser); sent = cancelled.sent; report.cancellation = cancelled.result; }
    else sent = peerDiagnostic ? [await socialSend()] : scenario === 'concurrent' ? await Promise.all([sendUser(), sendUser('_2'), socialSend()]) : [await sendUser()];
    report.messageAccepted = peerDiagnostic ? report.socialDeliveryReceipts.at(-1)?.ok : sent.slice(0, scenario === 'concurrent' ? 2 : 1).every(value => value?.ok && !!value.message); report.enqueueMs = performance.now() - foregroundStarted;
    emitProgress('targets_enqueued');
    const waitForBoundary = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([dispatched, new Promise<void>(resolve => { timeout = setTimeout(() => { report.timedOut = true; resolve(); }, 180000); })]);
      if (timeout) clearTimeout(timeout);
      return performance.now() - foregroundStarted;
    };
    const settleTargetTasks = async () => {
      const active: any[] = [];
      for (const sourceMessageId of targetSources) {
        const works = (await service.storage.request({ type: 'work.list', sourceMessageId })).works ?? [];
        for (const work of works) { const reply = service.replies.get(work.id); if (reply) active.push(reply); }
      }
      const socialIds = new Set([...targetSources].map(source => targetSocialJobs.get(source)?.id).filter(Boolean));
      const socialJobs = scenario === 'concurrent' ? [...service.world.jobs.entries()]
        .filter(([id]) => socialIds.has(id)).map(([, job]) => job) as Array<{ controller: AbortController; promise: Promise<void> }> : [];
      if (!online) {
        for (const reply of active) reply.controller.abort(Object.assign(new Error('BENCHMARK_FIRST_DISPATCH'), { code: 'BENCHMARK_FIRST_DISPATCH' }));
        for (const job of socialJobs) job.controller.abort(Object.assign(new Error('BENCHMARK_FIRST_DISPATCH'), { code: 'BENCHMARK_FIRST_DISPATCH' }));
      }
      await Promise.allSettled([...active.map(reply => reply.promise), ...socialJobs.map(job => job.promise), ...boundaryDrains]);
      if (online) {
        await Promise.allSettled([...service.attentionJobs.values()]);
        if (service.attentionJobs.size) throw new Error('A real auxiliary attention model task remained pending after target replies completed.');
        await Promise.allSettled(providerDrains);
      }
    };
    const waitForCompletions = () => waitForFullRespondCompletions({ request: command => service.storage.request(command), nowMs: () => performance.now() - foregroundStarted,
      tasks: [...targetSources].filter(sourceMessageId => !cancellation || targetLabels.get(sourceMessageId) === 'recovery_after_cancel').map(sourceMessageId => { const social = targetSocialJobs.get(sourceMessageId); return {
        sourceMessageId, companionId: social?.companionId ?? targetOwners.get(sourceMessageId)!, label: targetLabels.get(sourceMessageId)!,
        kind: social ? 'social' as const : 'reply' as const, ...(social ? { socialJobId: social.id } : {}),
      }; }) });
    await waitForBoundary();
    report.toFirstDispatchMs = performance.now() - foregroundStarted;
    report.observedDispatches = dispatchedTargets.size;
    if (online && !report.timedOut) {
      if (peerDiagnostics) {
        const result = await Promise.race([peerDiagnostics.stopped.then(cancellation => ({ cancelledDiagnostic: true, cancellation })),
          waitForCompletions().then(completions => ({ completed: true, completions }))]);
        report.peerDiagnostic = { ...result, receipts: peerDiagnostics.snapshot() };
        if ('cancelledDiagnostic' in result) throw new Error('The actual peer diagnostic was stopped through the public agenda cancellation after five memory tool receipts; this is not a completed reply.');
      }
      report.completions = await waitForCompletions();
      report.toCompletedMs = performance.now() - foregroundStarted;
      emitProgress('targets_completed');
      await Promise.allSettled(providerDrains);
    }
    if (cancellation) {
      const recovery = [...taskTimings.values()].find(timing => timing.label === 'recovery_after_cancel');
      report.cancellation.recoveryReachedDispatch = recovery?.dispatchMs !== undefined;
      report.cancellation.recoveryToDispatchMs = recovery?.dispatchMs === undefined ? undefined : recovery.dispatchMs - report.cancellation.recoveryStartedMs;
      if (!report.cancellation.recoveryReachedDispatch) throw new Error('The official message after cancellation did not reach the real model dispatch boundary.');
    }
    const stopping = performance.now(); await settleTargetTasks();
    report[online ? 'completedTaskDrainMs' : 'dispatchBoundaryDrainMs'] = performance.now() - stopping;
    if (online) report.allTaskRuntimeSettledMs = performance.now() - foregroundStarted;
    const drainRelatedChains = async () => {
      if (!online || scenario !== 'concurrent') return;
      const begun = performance.now(); emitProgress('related_chains_draining');
      while (true) {
        const counts = scheduling?.progress([], [...relatedSocialChains]).chain ?? {};
        if ((counts.failed ?? 0) || (counts.cancelled ?? 0)) throw new Error('A real related peer task failed or was cancelled before the chain settled.');
        if (Object.entries(counts).every(([status, count]) => !count || status === 'done')) break;
        if (performance.now() - begun > 180000) throw new Error('The real bounded related peer chains did not settle within the measured drain window.');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      report[phase === 'warm_foreground' ? 'warmRelatedChainDrainMs' : 'relatedChainDrainMs'] = performance.now() - begun;
      emitProgress('related_chains_drained');
    };
    await drainRelatedChains();
    if (['single', 'concurrent'].includes(scenario) && process.env.WORLDLINEBOX_RESPOND_WARM === '1' && !report.timedOut) {
      // Actual online replies finish naturally; offline tasks stop at their
      // measured transport boundary. The same real host/index/encoder stays.
      targetSources.clear(); dispatchedTargets.clear();
      pendingSocialOperations.clear();
      dispatched = new Promise<void>(resolve => { finishDispatch = resolve; });
      phase = 'warm_foreground'; phaseStarted = foregroundStarted = performance.now();
      const accepted: any[] = scenario === 'concurrent' ? await Promise.all([sendUser('_warm'), sendUser('_2_warm'), socialSend('_warm')]) : [await sendUser('_warm')];
      report.warmMessageAccepted = accepted.slice(0, scenario === 'concurrent' ? 2 : 1).every(value => value?.ok && !!value.message);
      report.warmEnqueueMs = performance.now() - foregroundStarted;
      emitProgress('targets_enqueued');
      report.warmToFirstDispatchMs = await waitForBoundary(); report.warmObservedDispatches = dispatchedTargets.size;
      if (online && !report.timedOut) {
        report.warmCompletions = await waitForCompletions();
        report.warmToCompletedMs = performance.now() - foregroundStarted;
        emitProgress('targets_completed');
        await Promise.allSettled(providerDrains);
      }
      await settleTargetTasks();
      if (online) report.warmAllTaskRuntimeSettledMs = performance.now() - foregroundStarted;
      await drainRelatedChains();
    }
    report.uiBatches = uiReads; report.uiContentBatches = uiContentReads; report.headerReads = statusReads;
  } catch (error) { report.failure = { name: error instanceof Error ? error.name : typeof error, code: (error as any)?.code, message: error instanceof Error && !error.message.includes('http') ? error.message.slice(0, 160) : undefined }; }
  finally {
    observeNativeSocialJob = () => undefined;
    if (report.peerReceiptObservation) {
      report.peerReceiptObservation.cohortElapsedMs = performance.now() - started - (report.initializationMs ?? 0);
      report.peerReceiptObservation.performanceValid = report.peerReceiptObservation.totalMs <= report.peerReceiptObservation.cohortElapsedMs * 0.01;
      if (!report.peerReceiptObservation.performanceValid) report.failure ??= { name: 'ReceiptObserverOverhead', message: 'Receipt observation exceeded one percent of the actual cohort; performance is incomplete.' };
    }
    refresh?.dispose(); if (statusTimer) clearInterval(statusTimer); if (progressTimer) clearInterval(progressTimer);
    if (report.learningAssetValidation.snapshotEntries || report.learningAssetValidation.externalWorkerRequests)
      report.failure ??= { stage: 'canonical_learning_assets', name: 'UnsupportedExternalAssetCorpus',
        message: 'External grant data requires the actual canonical asset Worker; this run cannot stand in for that branch.' };
    if (online && errors.some(error => !((error.phase === 'initialization' || scenario === 'cancel')
      && error.code === '20' && error.name === 'AbortError')))
      report.failure ??= { stage: 'real_provider_lifecycle', name: 'ActualProviderTaskErrors',
        message: 'The real configured provider or auxiliary task reported an error; this is not a successful completed run.' };
    report.modelNetworkCalls = modelNetworkCalls;
    report.uiReadFailures = uiReadFailures;
    report.providerObservations = providerObservations;
    report.automaticRecallAudit = automaticRecallAudit.snapshot([...taskTimings.entries()]
      .filter(([, timing]) => timing.dispatchMs !== undefined).map(([sourceId, timing]) => ({ sourceId, ownerId: targetOwners.get(sourceId), label: timing.label })));
    report.automaticRecallAudit.allDisabledComparison = process.env.WORLDLINEBOX_RESPOND_TOOLS_DISABLED === '1';
    if (process.env.WORLDLINEBOX_RESPOND_AUTOMATIC_ONLY === '1'
      && (report.automaticRecallAudit.memoryDeclarations || report.automaticRecallAudit.allDisabledComparison
        || !report.automaticRecallAudit.everyDispatchedTaskPreparedOnce || !report.automaticRecallAudit.noTaskPreparedTwice))
      report.failure ??= { name: 'AutomaticRecallContractViolation', message: 'Actual provider tools must exclude memory while each dispatched task prepares one passive recall with the configured tool policy.' };
    report.preparationCounterSnapshots = preparationCounterSnapshots;
    report.relatedTaskOutcomes = relatedTaskOutcomes;
    report.publishedModelEvents = [...publishedModelEvents.values()];
    report.boundaryStopFailures = boundaryStopFailures;
    const completedScheduling = scheduling; scheduling = undefined;
    if (completedScheduling) { report.scheduling = completedScheduling.snapshot(); completedScheduling.close(); }
    report.metrics = Object.entries(metrics).sort((a, b) => b[1].totalMs - a[1].totalMs); report.events = events; report.progress = progress; report.dispatches = dispatches; report.taskTimings = [...taskTimings.values()]; report.nativeTransitions = nativeTransitions; report.errors = errors;
    report.rawRequestShapes = [...rawShapes.values()];
    report.rawCommandChains = [...rawCommandChains.values()].sort((left, right) => right.calls - left.calls);
    report.changeOrigins = [...changeOrigins.values()].sort((left, right) => right.calls - left.calls);
    report.projectedResponseShapes = [...projectedResponseShapes.values()];
    report.recallOutcomes = recallOutcomes;
    if (diagnosticProfile) { report.methodDiagnostics = methodDiagnostics; report.sourceRevisionWrites = [...sourceRevisionWrites.values()]; }
    if (process.env.WORLDLINEBOX_RESPOND_STACKS === '1') report.rawCallsiteSamples = [...rawCallsites.values()].sort((a, b) => b.samples - a.samples);
    await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
    // Isolated app lifetime ends after exact boundary measurement. Never stop
    // another app's processes or wait for irrelevant cloned agenda work.
    await Promise.allSettled([embedding.close(), chat.close(), encoder.close(), runtime.close()]);
    app.exit(report.failure ? 1 : 0);
  }
}).catch(async error => {
  // Early credential/configuration failures precede the service report. Keep
  // a bounded diagnostic receipt without ever serializing provider inputs.
  await writeFile(path.join(root, 'result.json'), JSON.stringify({
    sourceLibraryMutated: false, scenario, realProviderRoundTrip: online,
    failure: { stage: 'fixture_initialization', name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: string })?.code,
      message: error instanceof Error && !error.message.includes('http') ? error.message.slice(0, 160) : undefined },
  })).catch(() => undefined);
  app.exit(1);
});
