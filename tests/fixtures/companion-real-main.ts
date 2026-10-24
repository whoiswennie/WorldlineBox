import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { generateCompanionText } from '../../src/main/companions/model';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionMemoryRuntime } from '../../src/main/companions/vcp-runtime';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { realGlobalChatConfig } from './companion-real-chat';
import { realMemoryRuntime, type RealColdWorkerObservation } from './companion-real-memory';
import type { CompanionLearningAssets } from '../../src/main/companions/learning-service';
import type { ColdKnowledgeService, ColdKnowledgeServiceOptions } from '../../src/main/vcp-memory/cold-service';
import { observeCompanionProviderRequest, observeCompanionProviderResponse } from './companion-provider-observation';

const transport = vi.hoisted(() => ({ request: undefined as ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>) | undefined,
  fetch: undefined as typeof fetch | undefined }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = (command: CompanionStorageCommand) => transport.request!(command);
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: (url: string, init?: RequestInit) => transport.fetch!(url, init) },
  dialog: {}, ipcMain: { handle: () => undefined }, protocol: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));

export interface RealMainModelCall {
  purpose: string; owner?: string; startedAt: string; elapsedMs?: number; requestChars: number;
  usage?: unknown; finishReason?: unknown; visibleText?: string; error?: string;
  providerObservation?: { request: 'observed' | 'unavailable'; response?: 'observed' | 'unavailable'; requestDiagnostic?: string; responseDiagnostic?: string };
  /** Whitelisted metadata from the actual final provider user wire only. */
  storyFocusWire?: { topicId?: unknown; readerId?: unknown; sourceId?: unknown; sourceChecksum?: unknown;
    latestPublishedId?: unknown; latestPublishedChecksum?: unknown; latestPublishedChars?: number;
    coveredThroughSequence?: unknown; scannedThroughSequence?: unknown; latestPublishedSequence?: unknown; currentRequestSequence?: unknown;
    narrativeReferences?: unknown;
    prefixStageRenamed: boolean; canonQuotesOnly: boolean };
}

/** Actual Main/SQLite/model boundary. Only IPC carriage and the renderer are
 * replaced; no inference result, tool choice, journal or world clock is faked. */
export async function realMainFixture(label: string, seeds: CompanionSeed[], useRealEncoder = false, options: { existingRoot?: string; researchStopFile?: string;
  enableCold?: boolean; learningAssets?: CompanionLearningAssets;
  observeColdWorker?(event: RealColdWorkerObservation): void;
  /** Test-owned observation of string leaves in the actual provider JSON body;
   * excludes headers/credentials and does not alter native tool history. */
  observeProviderTextLeaves?(texts: readonly string[], purpose: string): void } = {}) {
  if (options.enableCold && !useRealEncoder) throw new Error('REAL_MAIN_COLD_REQUIRES_REAL_ENCODER');
  const root = options.existingRoot ? path.resolve(options.existingRoot) : await mkdtemp(path.join(tmpdir(), 'worldlinebox-real-main-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-real-main-')) throw new Error('Unexpected real Main fixture root.');
  const dataRoot = path.join(root, 'companions'), file = path.join(dataRoot, 'messages.sqlite');
  const config = await realGlobalChatConfig(root), calls: RealMainModelCall[] = [], captures = new Set<Promise<void>>();
  const researchAbort = new AbortController();
  const throwIfResearchStopped = () => {
    if (options.researchStopFile && existsSync(options.researchStopFile) && !researchAbort.signal.aborted)
      researchAbort.abort(new Error('REAL_MAIN_RESEARCH_INTERRUPTED_' + label));
    researchAbort.signal.throwIfAborted();
  };
  const errors: string[] = [], commands: CompanionStorageCommand[] = [];
  const modelFetch: typeof fetch = async (url, init) => {
    throwIfResearchStopped();
    const serialized = String(init?.body ?? ''), started = performance.now();
    const requestObservation = observeCompanionProviderRequest(config.apiFormat, serialized), payload = requestObservation.payload;
    let observedTextLeaves: string[] | undefined;
    try { const wire = JSON.parse(serialized);
      if (options.observeProviderTextLeaves) {
        observedTextLeaves = [];
        const collect = (value: unknown): void => {
          if (typeof value === 'string') observedTextLeaves!.push(value);
          else if (Array.isArray(value)) for (const item of value) collect(item);
          else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item);
        };
        collect(wire);
      }
      } catch { /* No headers or credentials are recorded. */ }
    if (observedTextLeaves !== undefined) options.observeProviderTextLeaves?.(observedTextLeaves, String(payload.purpose ?? 'reply_or_upstream_processor'));
    const identity = payload.identity as { self?: { id: string } } | undefined;
    const call: RealMainModelCall = { purpose: String(payload.purpose ?? 'reply_or_upstream_processor'), owner: identity?.self?.id ?? (payload.companion as { id?: string } | undefined)?.id,
      startedAt: new Date().toISOString(), requestChars: serialized.length,
      providerObservation: { request: requestObservation.evidenceMissing ? 'unavailable' : 'observed',
        ...(requestObservation.evidenceMissing ? { requestDiagnostic: requestObservation.evidenceMissing } : {}) } };
    const focus = payload.topicContinuityFocus as { topicId?: unknown; readerId?: unknown; currentRequest?: { id?: unknown; sourceChecksum?: unknown; content?: unknown };
      latestPublishedText?: { id?: unknown; sourceChecksum?: unknown; content?: unknown }; workingCheckpointCoverage?: Record<string, unknown>;
      userCanon?: { entries?: Record<string, unknown>[] }; sourceBoundNarrativeReferences?: { status: unknown; selectedSources: unknown; references: Array<Record<string, unknown>>; conflicts: unknown } } | undefined;
    if (focus) {
      const coverage = focus.workingCheckpointCoverage;
      const working = (payload.topicState as { workingState?: Record<string, unknown> } | undefined)?.workingState;
      call.storyFocusWire = { topicId: focus.topicId, readerId: focus.readerId, sourceId: focus.currentRequest?.id,
        sourceChecksum: typeof focus.currentRequest?.content === 'string' ? createHash('sha256').update(focus.currentRequest.content).digest('hex') : focus.currentRequest?.sourceChecksum,
        latestPublishedId: focus.latestPublishedText?.id, latestPublishedChecksum: typeof focus.latestPublishedText?.content === 'string'
          ? createHash('sha256').update(focus.latestPublishedText.content).digest('hex') : focus.latestPublishedText?.sourceChecksum,
        latestPublishedChars: typeof focus.latestPublishedText?.content === 'string' ? focus.latestPublishedText.content.length : undefined,
        coveredThroughSequence: coverage?.coveredThroughSequence, scannedThroughSequence: coverage?.scannedThroughSequence,
        latestPublishedSequence: coverage?.latestPublishedSequence, currentRequestSequence: coverage?.currentRequestSequence,
        narrativeReferences: focus.sourceBoundNarrativeReferences ? { status: focus.sourceBoundNarrativeReferences.status,
          selectedSources: focus.sourceBoundNarrativeReferences.selectedSources, conflicts: focus.sourceBoundNarrativeReferences.conflicts,
          references: focus.sourceBoundNarrativeReferences.references.map(({ subjectName, sourceMessageId, sourceChecksum, quoteStart, quoteEnd, nameStart, nameEnd,
            referenceStart, referenceEnd, sourcePronoun, bindingMethod }) => ({ subjectName, sourceMessageId, sourceChecksum, quoteStart, quoteEnd, nameStart, nameEnd, referenceStart, referenceEnd, sourcePronoun, bindingMethod })) } : undefined,
        prefixStageRenamed: !!working && !('stage' in working) && ('stageAtCoveredPrefix' in working),
        canonQuotesOnly: !!focus.userCanon?.entries?.every(entry => !('rule' in entry))
          && !((working?.state as { __topicUserCanon?: { entries?: Record<string, unknown>[] } } | undefined)?.__topicUserCanon?.entries?.some(entry => 'rule' in entry)) };
    }
    calls.push(call);
    try {
      const response = await fetch(url, options.researchStopFile ? { ...init,
        signal: AbortSignal.any([researchAbort.signal, ...(init?.signal ? [init.signal] : [])]) } : init);
      const capture = observeCompanionProviderResponse(response, config.apiFormat, { signal: options.researchStopFile
        ? AbortSignal.any([researchAbort.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal ?? undefined }).then(observed => {
        call.visibleText = observed.visibleText;
        if (observed.usage) call.usage = observed.usage;
        if (observed.finishReason) call.finishReason = observed.finishReason;
        call.providerObservation!.response = observed.status;
        if (observed.diagnostic) call.providerObservation!.responseDiagnostic = observed.diagnostic;
      }).catch(() => { call.providerObservation!.response = 'unavailable'; call.providerObservation!.responseDiagnostic = 'response_observation_failed'; })
        .finally(() => { call.elapsedMs = performance.now() - started; captures.delete(capture); });
      captures.add(capture); return response;
    } catch (error) { call.elapsedMs = performance.now() - started; call.error = error instanceof Error ? error.message : 'MODEL_FETCH_FAILED';
      if (researchAbort.signal.aborted) throw researchAbort.signal.reason;
      throw error; }
  };
  transport.fetch = modelFetch;
  const native = useRealEncoder ? await realMemoryRuntime(root, (context, signal) => generateCompanionText(context, config, signal, { fetchFn: modelFetch, timeoutMs: 120000 }),
    { modelFetch, ...(options.enableCold ? { observeColdWorker: options.observeColdWorker } : {}) }) : undefined;
  // A Main restart must not dispose this test-owned native host. Final cleanup
  // closes it once, after every Main owner and pending request has stopped.
  let cold: ColdKnowledgeService | undefined;
  let coldAuthorize: ColdKnowledgeServiceOptions['authorize'] | undefined;
  const runtime: CompanionMemoryRuntime | undefined = native ? { get: () => native.runtime.get(), close: async () => undefined,
    describeEmbedding: () => native.runtime.describeEmbedding(), describeGeneration: input => native.runtime.describeGeneration(input),
    acquireGeneration: input => native.runtime.acquireGeneration(input), interruptOwner: owner => native.runtime.interruptOwner(owner),
    purgeOwner: (owner, scopes) => native.runtime.purgeOwner(owner, scopes),
    ...(options.enableCold ? {
      getCold: async (authorize: ColdKnowledgeServiceOptions['authorize']) => {
        // Match production's rebinding on every actual caller, including after
        // Main restart; a closed old service never remains the ACL authority.
        coldAuthorize = authorize;
        return cold ??= native.cold((...args) => coldAuthorize!(...args));
      }, resetCold: async (owner: string) => { await cold?.reset(owner); },
    } : {}) } : undefined;
  let store = new CompanionsStore(file, seeds), service: CompanionService, closing = false;
  const request = async (command: CompanionStorageCommand) => { commands.push(command); return store.request(command); };
  transport.request = request;
  const start = () => new CompanionService({ userData: path.join(root, 'profile'), dataRoot, workerPath: 'in-process-real-qa-port', window: () => undefined,
    getConfig: () => config, hasConfig: () => true, dsh: () => undefined, memoryRuntime: runtime, learningAssets: options.learningAssets,
    report: error => { if (!closing) errors.push(error instanceof Error ? error.message : String(error)); } });
  service = start();
  const stopTimer = options.researchStopFile ? setInterval(() => { try { throwIfResearchStopped(); } catch { /* Active waits/fetches observe the same abort. */ } }, 150) : undefined;
  const waitFor = async (condition: () => boolean | Promise<boolean>, phase: string, milliseconds = 180000) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) { throwIfResearchStopped(); if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 150)); }
    throw new Error('REAL_MAIN_TIMEOUT_' + phase);
  };
  const waitReply = async (owner: string, source: CompanionMessage) => {
    await waitFor(() => {
      const checkpoint = store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: owner }).loop;
      if (checkpoint?.progress?.phase === 'failed') throw new Error('REAL_MAIN_FAILED_' + (checkpoint.progress.detail ?? 'UNKNOWN'));
      return checkpoint?.status === 'done';
    }, owner + '_' + source.id);
    const checkpoint = store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: owner }).loop;
    if (!checkpoint || checkpoint.status !== 'done' || checkpoint.companionId !== owner
      || checkpoint.sourceMessageId !== source.id || checkpoint.conversationId !== source.conversationId || !checkpoint.messageId)
      throw new Error('REAL_MAIN_FORMAL_CHECKPOINT_MISMATCH');
    // Action receipts may be created after the reply bubble. Only the exact
    // completed loop's published text is an answer; creation order is not proof.
    const answer = store.request({ type: 'memory.sources.filter', companionId: owner,
      conversationId: source.conversationId, ids: [checkpoint.messageId] }).memorySources?.find(message => message.id === checkpoint.messageId);
    if (!answer || answer.kind !== 'text' || answer.status !== 'sent' || answer.isReplyDraft || answer.replyDraft
      || answer.authorId !== owner || answer.replyToId !== source.id || answer.conversationId !== source.conversationId
      || (answer.topicId ?? null) !== (source.topicId ?? null) || !answer.content.trim())
      throw new Error('REAL_MAIN_FORMAL_REPLY_MISSING_OR_UNREADABLE');
    return { source, answer, checkpoint };
  };
  const send = async (owner: string, conversationId: string, content: string, topicId?: string | null) => {
    const source = (await service.handle({ type: 'message.send', conversationId, content, clientId: 'real_main_' + randomUUID(), ...(topicId !== undefined ? { topicId } : {}) })).message!;
    return waitReply(owner, source);
  };
  const restart = async () => {
    closing = true; await service.shutdown(); store.close();
    store = new CompanionsStore(file, seeds); transport.request = request; closing = false; service = start();
  };
  const save = async (output: string, report: unknown, preserve = false) => {
    await Promise.allSettled([...captures]); const text = JSON.stringify(report, null, 2);
    if (config.apiKey && text.includes(config.apiKey)) throw new Error('REAL_MAIN_QA_CREDENTIAL_IN_REPORT');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, text);
    if (preserve) {
      const archive = output.replace(/\.json$/u, '-sqlite'); await mkdir(archive, { recursive: true });
      for (const suffix of ['', '-wal', '-shm']) { try { await writeFile(path.join(archive, 'messages.sqlite' + suffix), await readFile(file + suffix)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    }
  };
  const close = async (preserveRoot = false) => {
    if (stopTimer) clearInterval(stopTimer);
    closing = true; await service.shutdown(); await native?.close(); store.close(); await Promise.allSettled([...captures]);
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-real-main-')) throw new Error('Unexpected real QA cleanup root.');
    if (!preserveRoot) await removeOwnedDirectory(root);
  };
  return { root, config, native, runtime, calls, errors, commands, request, send, waitReply, waitFor, restart, save, close, modelFetch, label, throwIfResearchStopped,
    get store() { return store; }, get service() { return service; } };
}
