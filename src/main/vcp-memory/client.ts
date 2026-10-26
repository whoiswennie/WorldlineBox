import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { utilityProcess } from 'electron';
import { detachRuntimeDependencyLinks, inspectVcpOwnedDirectory, removeOwnedDirectory } from './filesystem';
import { VcpMemoryProcessBroker } from './process-broker';
import { VcpPreparedRecallStore } from './prepared-recall-store';
import { preparedRecallReference, recoveryFromPayload, type PreparedRecallRecovery } from './prepared-recall-recovery';
import type { CompanionPreparedRecallReference } from '../../shared/companion-prepared-recall';
import type { VcpMemoryDreamWaveRequest, VcpMemoryDreamWaveResult } from './dream-contracts';
import type {
  VcpMemoryCommand, VcpMemoryDeleteReceipt, VcpMemoryEmbeddingConfig, VcpMemoryNote,
  VcpMemoryScope, VcpMemorySearchResult, VcpMemoryWriteReceipt,
  VcpMemoryMessage, VcpMemoryPluginConfiguration, VcpMemoryPluginName, VcpMemoryTimelineRequest,
  VcpMemoryTimelineArtifacts,
  VcpMemoryContextReference, VcpMemoryCapabilities, VcpMemoryQueryClock, VcpMemoryAutomaticDecayPolicy,
  VcpMemoryPreparationReceipt, VcpMemoryPreprocessResult,
  VcpMemoryPreparedRecall, VcpMemoryPreparedPayload, VcpMemoryPreparedHostEvidence, VcpMemoryFocusOptions, VcpMemoryOwnerPrompts,
} from './contracts';

export interface VcpMemoryTransport {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(): void;
}

export interface VcpMemoryClientOptions {
  dataRoot: string;
  vendorRoot: string;
  workerPath: string;
  embedding: VcpMemoryEmbeddingConfig;
  requestTimeoutMs?: number;
  maxOpenScopes?: number;
  plugins?: VcpMemoryPluginConfiguration;
  processBroker?: VcpMemoryProcessBroker;
  /** Trusted host root shared by every owner/profile in the same workspace. */
  preparedRecallBudget?: { workspaceRoot: string; maxPackages?: number; maxBytes?: number };
  boundOwnerId?: string;
  semanticProfileKey?: string;
  /** Tests can launch the identical CJS worker with Node's fork transport. */
  launch?: (workerPath: string) => VcpMemoryTransport;
}

interface Pending {
  commandType: VcpMemoryCommand['type'];
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface ScopeProcess {
  key: string;
  brokerIdentity: symbol;
  transport: VcpMemoryTransport;
  ready: Promise<void>;
  pending: Map<string, Pending>;
  used: number;
  busy: number;
  exited: Promise<void>;
  failed: boolean;
  detached?: Promise<void>;
  retirement?: Promise<void>;
  finalized?: Promise<void>;
  stopping?: Promise<void>;
  retirementStartedAt?: number;
  exitObservedAt?: number;
  exitCode?: number;
  detachStartedAt?: number;
  detachCompletedAt?: number;
  closeAcknowledgedAt?: number;
  workerCleanupAcknowledged?: boolean;
}

function launchUtility(workerPath: string): VcpMemoryTransport {
  const child = utilityProcess.fork(workerPath, [], { serviceName: 'WorldlineBox VCP Memory', stdio: 'pipe' });
  child.stdout?.resume(); child.stderr?.resume();
  child.stdout?.on('error', () => undefined); child.stderr?.on('error', () => undefined);
  const events = new EventEmitter();
  child.on('message', message => events.emit('message', message));
  child.on('exit', code => events.emit('exit', code));
  child.on('error', (type, location, report) => events.emit('error', new Error(`VCP memory process ${type} at ${location}: ${report}`)));
  return { postMessage: message => child.postMessage(message), on: events.on.bind(events), kill: () => { child.kill(); } };
}
function scopeKey(scope: VcpMemoryScope): string {
  if (typeof scope.scopeId !== 'string' || !scope.scopeId.trim() || scope.scopeId.length > 4096) throw new Error('Invalid VCP memory scope.');
  return createHash('sha256').update(scope.scopeId).digest('hex');
}

/** A bounded process pool; each visibility domain owns its database and graph. */
export class VcpMemoryClient {
  get isClosed(): boolean { return this.closed; }
  private scopes = new Map<string, ScopeProcess>();
  private retiring = new Map<string, Promise<void>>();
  private scopeGenerations = new Map<string, number>();
  private recallGenerations = new Map<string, number>();
  private closed = false;
  private poolTail: Promise<unknown> = Promise.resolve();
  private readonly broker: VcpMemoryProcessBroker;
  private readonly brokerNamespace = randomUUID();
  private readonly prepared: VcpPreparedRecallStore;
  private readonly preparations = new Map<Promise<unknown>, string>();
  private readonly focusing = new Map<string, { scopeId: string; controller: AbortController; settled: Promise<unknown> }>();
  private readonly focusedReceipts = new Map<string, { scopeId: string; serialized: string; bytes: number; createdAt: number }>();
  private focusedReceiptBytes = 0;
  readonly supportsDetachedRecall: boolean = true;
  private ownerPrompts?: VcpMemoryOwnerPrompts;
  private algorithmIdentity?: Promise<string>;

  constructor(private readonly options: VcpMemoryClientOptions) {
    if (!Number.isInteger(options.embedding.dimension) || options.embedding.dimension < 1 || options.embedding.dimension > 4096) throw new Error('VCP embedding dimension must be between 1 and 4096.');
    this.broker = options.processBroker ?? new VcpMemoryProcessBroker(Math.max(1, Math.floor(options.maxOpenScopes ?? 4)));
    this.prepared = new VcpPreparedRecallStore(path.resolve(options.dataRoot), options.preparedRecallBudget);
    if (options.plugins?.ownerPrompts) this.setOwnerPrompts(options.plugins.ownerPrompts);
  }
  setOwnerPrompts(prompts: VcpMemoryOwnerPrompts): void {
    if (!prompts || typeof prompts.aimemoTemplate !== 'string' || !prompts.aimemoTemplate.trim()) throw new Error('Owner memory focus template is unavailable.');
    for (const value of [prompts.timelineTemplate, prompts.summaryTemplate]) if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error('Owner timeline template is unavailable.');
    this.ownerPrompts = { aimemoTemplate: prompts.aimemoTemplate,
      ...(prompts.timelineTemplate !== undefined ? { timelineTemplate: prompts.timelineTemplate } : {}),
      ...(prompts.summaryTemplate !== undefined ? { summaryTemplate: prompts.summaryTemplate } : {}) };
  }
  hasOpenScope(scope: VcpMemoryScope): boolean {
    const child = this.scopes.get(scopeKey(scope)); return Boolean(child && !child.failed && !child.stopping);
  }
  preparedResourceSnapshot() { return this.prepared.snapshot(); }
  algorithmSignature(): Promise<string> { return this.algorithmIdentity ??= (async () => {
    const files = [path.join(this.options.vendorRoot, 'upstream-manifest.json'), path.join(this.options.vendorRoot, 'Plugin/RAGDiaryPlugin/AIMemoHandler.js'),
      path.join(this.options.vendorRoot, 'Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'), path.join(path.dirname(this.options.workerPath), 'peripherals.cjs'),
      path.join(path.dirname(this.options.workerPath), 'prepared-focus.cjs'), path.join(path.dirname(this.options.workerPath), 'runtime.cjs'),
      path.join(path.dirname(this.options.workerPath), 'record-catalog.cjs')];
    const values = await Promise.all(files.map(file => readFile(file)));
    const digest = createHash('sha256'); for (let index = 0; index < values.length; index++) { digest.update(String(index)); digest.update(values[index]!); }
    return digest.digest('hex');
  })(); }

  private rejectAll(child: ScopeProcess, error: Error): void {
    for (const pending of child.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    child.pending.clear();
  }
  private failProcess(child: ScopeProcess, error: Error): void {
    if (child.failed) return;
    this.broker.beginRetirement(`${this.brokerNamespace}:${child.key}`, child.brokerIdentity);
    child.failed = true;
    this.rejectAll(child, error);
    for (const [key, candidate] of this.scopes) if (candidate === child) this.scopes.delete(key);
    child.transport.kill();
    this.trackRetirement(child);
  }
  private trackRetirement(child: ScopeProcess): void {
    const retirement = this.waitForExit(child);
    this.retiring.set(child.key, retirement);
    // Reporting a shutdown timeout must not abandon eventual exit cleanup.
    // Keep its permit until exit+detach, then unblock the scope even if the
    // original caller already received the timeout error.
    void child.finalized!.then(() => { if (this.retiring.get(child.key) === retirement) this.retiring.delete(child.key); }, () => undefined);
  }
  private waitForExit(child: ScopeProcess): Promise<void> {
    return child.retirement ??= this.waitForExitOperation(child);
  }
  private async waitForExitOperation(child: ScopeProcess): Promise<void> {
    child.retirementStartedAt ??= Date.now();
    child.finalized ??= child.exited.then(async () => {
      // The owned worker acknowledges close only after runtime.close has
      // removed its dependency links. Trust that proof only with actual exit 0;
      // crashes, kills without the proof and legacy replies retain parent cleanup.
      if (!child.workerCleanupAcknowledged || child.exitCode !== 0) {
        child.detachStartedAt ??= Date.now();
        child.detached ??= detachRuntimeDependencyLinks(path.join(path.resolve(this.options.dataRoot), child.key));
        await child.detached;
      }
      child.detachCompletedAt = Date.now();
      this.broker.retired(`${this.brokerNamespace}:${child.key}`, child.brokerIdentity);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([child.finalized, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const stage = child.exitObservedAt === undefined ? 'exit_notification'
            : child.detachCompletedAt === undefined ? 'dependency_cleanup' : 'permit_release';
          const diagnostic = { stage, elapsedMs: Math.max(0, Date.now() - child.retirementStartedAt!),
            closeAcknowledged: child.closeAcknowledgedAt !== undefined, exitObserved: child.exitObservedAt !== undefined,
            exitCode: child.exitCode, detachStarted: child.detachStartedAt !== undefined, detachCompleted: child.detachCompletedAt !== undefined };
          reject(Object.assign(new Error(`VCP memory shutdown did not finish (stage=${stage}, elapsedMs=${diagnostic.elapsedMs}, closeAcknowledged=${diagnostic.closeAcknowledged}, exitObserved=${diagnostic.exitObserved}, exitCode=${diagnostic.exitCode ?? 'unknown'}, detachStarted=${diagnostic.detachStarted}, detachCompleted=${diagnostic.detachCompleted}).`),
            { code: 'VCP_MEMORY_SHUTDOWN_TIMEOUT', diagnostic }));
        }, 5_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private send(child: ScopeProcess, command: VcpMemoryCommand, deadline = Date.now() + (this.options.requestTimeoutMs ?? 180_000)): Promise<unknown> {
    if (child.failed) return Promise.reject(new Error('VCP memory process is no longer available.'));
    if (Date.now() >= deadline) return Promise.reject(new Error('VCP memory request timed out.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.pending.delete(requestId);
        const error = new Error('VCP memory request timed out.');
        reject(error); this.failProcess(child, error);
      }, Math.max(1, deadline - Date.now()));
      child.pending.set(requestId, { commandType: command.type, resolve, reject, timer });
      // The worker contract is JSON. Electron uses structured clone while Node's
      // test fork serializes implicitly; use the same plain payload for both.
      try { child.transport.postMessage(JSON.parse(JSON.stringify({ requestId, command }))); }
      catch (error) {
        clearTimeout(timer); child.pending.delete(requestId); reject(error);
        this.failProcess(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private ensureScope(scope: VcpMemoryScope, deadline: number): Promise<{ child: ScopeProcess; release(): void }> {
    const key = scopeKey(scope), generation = this.scopeGenerations.get(key) ?? 0;
    const assertCurrent = () => {
      if (this.closed) throw new Error('VCP memory client is closed.');
      if ((this.scopeGenerations.get(key) ?? 0) !== generation) throw new Error('VCP memory scope was interrupted.');
      if (Date.now() >= deadline) throw new Error('VCP memory request timed out.');
    };
    const existing = this.scopes.get(key);
    // A pending admission for a different scope cannot prevent dispatch to an
    // already open worker. Worker commands remain serialized by its own lane;
    // the broker still reserves the exact child before any command is sent.
    const admission = existing && !existing.failed && !existing.stopping && !this.retiring.has(key)
      ? Promise.resolve() : this.poolTail;
    const result = admission.then(async () => {
      if (this.closed) throw new Error('VCP memory client is closed.');
      assertCurrent();
      let retired = !this.retiring.has(key), failure: unknown;
      void this.retiring.get(key)?.then(() => { retired = true; }, error => { failure = error; retired = true; });
      while (!retired) { assertCurrent(); await new Promise(resolve => setTimeout(resolve, 20)); }
      if (failure) throw failure;
      if (this.closed) throw new Error('VCP memory client is closed.');
      assertCurrent();
      const permit = await this.broker.acquire(`${this.brokerNamespace}:${key}`, { assertCurrent,
        deadline, open: brokerIdentity => {
      const transport = (this.options.launch ?? launchUtility)(this.options.workerPath);
      let acknowledgeExit: () => void = () => undefined;
      const exited = new Promise<void>(resolve => { acknowledgeExit = resolve; });
      const child: ScopeProcess = { key, brokerIdentity, transport, pending: new Map(), used: Date.now(), busy: 0, ready: Promise.resolve(), exited, failed: false };
      this.scopes.set(key, child);
      transport.on('message', message => {
        if (!message || typeof message !== 'object' || !('requestId' in message) || typeof message.requestId !== 'string') return;
        const pending = child.pending.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer); child.pending.delete(message.requestId);
        if ('ok' in message && message.ok === true) {
          const value = 'value' in message ? message.value : undefined;
          if (pending.commandType === 'close') {
            child.closeAcknowledgedAt = Date.now();
            // Publish before resolving: transport exit may arrive in this tick,
            // before the awaiting stopScope continuation has resumed.
            child.workerCleanupAcknowledged = !!value && typeof value === 'object' && !Array.isArray(value)
              && 'closed' in value && value.closed === true;
          }
          pending.resolve(value);
        }
        else {
          const detail = 'error' in message && message.error && typeof message.error === 'object' ? message.error : {};
          pending.reject(Object.assign(new Error('message' in detail ? String(detail.message) : 'VCP memory operation failed.'),
            { code: 'code' in detail ? String(detail.code) : 'VCP_MEMORY_ERROR' }));
        }
      });
      transport.on('exit', code => {
        this.broker.beginRetirement(`${this.brokerNamespace}:${key}`, brokerIdentity);
        child.exitObservedAt = Date.now(); child.exitCode = code;
        acknowledgeExit();
        child.failed = true;
        this.rejectAll(child, new Error(`VCP memory process exited (${code}).`));
        if (this.scopes.get(key) === child) this.scopes.delete(key);
        // An idle crash has no request-timeout path. Its dependency links still
        // belong to us and must be detached before close/purge can finish.
        this.trackRetirement(child);
      });
      transport.on('error', error => this.failProcess(child, error));
      child.ready = this.send(child, { type: 'initialize', configuration: {
        dataRoot: this.options.dataRoot, vendorRoot: this.options.vendorRoot, scope: { scopeId: scope.scopeId },
        embedding: this.options.embedding,
        plugins: this.options.plugins,
      } }, deadline).then(() => undefined).catch(error => {
        this.failProcess(child, error instanceof Error ? error : new Error(String(error))); throw error;
      });
      return { stop: () => this.stopScope(key, child) };
      } });
      try {
        assertCurrent(); const child = this.scopes.get(key);
        if (!child || child.failed) throw new Error('VCP memory process is no longer available.');
        child.busy++; child.used = Date.now(); return { child, release: permit.release };
      } catch (error) { permit.release(); throw error; }
    });
    // Retain every admission for close/purge, including those that bypassed a
    // blocked new-scope request. Replacing the tail would lose that drain.
    this.poolTail = Promise.all([this.poolTail, result]).then(() => undefined, () => undefined);
    return result;
  }
  private async request<T>(scope: VcpMemoryScope, command: VcpMemoryCommand): Promise<T> {
    if (this.closed) throw new Error('VCP memory client is closed.');
    if (this.options.boundOwnerId) await inspectVcpOwnedDirectory(path.join(path.resolve(this.options.dataRoot), scopeKey(scope)));
    if (this.ownerPrompts && ['preprocess', 'prepare-recall', 'plugin', 'timeline'].includes(command.type)) command = { ...command, ownerPrompts: { ...this.ownerPrompts } };
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 180_000);
    const { child, release } = await this.ensureScope(scope, deadline);
    try { await child.ready; return await this.send(child, command, deadline) as T; }
    finally { child.busy--; child.used = Date.now(); release(); }
  }
  remember(scope: VcpMemoryScope, note: VcpMemoryNote): Promise<VcpMemoryWriteReceipt> { return this.request(scope, { type: 'remember', note }); }
  replace(scope: VcpMemoryScope, notes: VcpMemoryNote[]): Promise<{ replaced: true; count: number }> { return this.request(scope, { type: 'replace', notes }); }
  applyProjectionDelta(scope: VcpMemoryScope, notes: VcpMemoryNote[], removedIds: string[]): Promise<{ changed: number; removed: number }> {
    return this.request(scope, { type: 'projection-delta', notes, removedIds });
  }
  prepare(scope: VcpMemoryScope): Promise<VcpMemoryPreparationReceipt> { return this.request(scope, { type: 'prepare' }); }
  search(scope: VcpMemoryScope, query: { text: string; topK?: number }): Promise<VcpMemorySearchResult> { return this.request(scope, { type: 'search', text: query.text, topK: query.topK }); }
  read(scope: VcpMemoryScope, id: string): Promise<VcpMemoryNote | null> { return this.request(scope, { type: 'read', id }); }
  list(scope: VcpMemoryScope): Promise<VcpMemoryNote[]> { return this.request(scope, { type: 'list' }); }
  forget(scope: VcpMemoryScope, id: string): Promise<VcpMemoryDeleteReceipt> { return this.request(scope, { type: 'forget', id }); }
  pluginCall(scope: VcpMemoryScope, plugin: VcpMemoryPluginName, arguments_: Record<string, unknown>): Promise<{ result: unknown; indexed: boolean; contextReferences?: VcpMemoryContextReference[]; contextReferenceCoverage?: 'observed' | 'partial' }> {
    return this.request(scope, { type: 'plugin', plugin, arguments: arguments_ });
  }
  preprocess(scope: VcpMemoryScope, messages: VcpMemoryMessage[], clock?: VcpMemoryQueryClock, automaticDecay?: VcpMemoryAutomaticDecayPolicy): Promise<VcpMemoryPreprocessResult> { return this.request(scope, { type: 'preprocess', messages, ...(clock ? { clock } : {}), ...(automaticDecay ? { automaticDecay } : {}) }); }
  /** Candidate preparation consumes a physical graph permit; focusing below never does. */
  prepareRecall(scope: VcpMemoryScope, messages: VcpMemoryMessage[], clock?: VcpMemoryQueryClock,
    automaticDecay?: VcpMemoryAutomaticDecayPolicy, hostEvidence?: VcpMemoryPreparedHostEvidence): Promise<VcpMemoryPreparedRecall> {
    if (this.options.boundOwnerId && hostEvidence?.ownerId !== this.options.boundOwnerId) return Promise.reject(new Error('Prepared recall belongs to another owner.'));
    const key = scopeKey(scope), generation = this.scopeGenerations.get(key) ?? 0;
    const immutableEvidence = hostEvidence ? structuredClone(hostEvidence) : undefined;
    const current = () => { if (this.closed || (this.scopeGenerations.get(key) ?? 0) !== generation) throw new Error('Prepared recall was withdrawn.'); };
    const pending = (async () => {
      current();
      const payload = await this.request<VcpMemoryPreparedPayload>(scope, { type: 'prepare-recall', messages,
        ...(clock ? { clock } : {}), ...(automaticDecay ? { automaticDecay } : {}) });
      current();
      const handle = await this.prepared.save(scope.scopeId, { ...payload, ...(immutableEvidence ? { hostEvidence: immutableEvidence } : {}) });
      try { current(); return handle; } catch (error) { await this.prepared.remove(handle); throw error; }
    })();
    this.preparations.set(pending, scope.scopeId);
    void pending.finally(() => this.preparations.delete(pending)).catch(() => undefined);
    return pending;
  }
  focusRecall(handle: VcpMemoryPreparedRecall, options: VcpMemoryFocusOptions = {}): Promise<VcpMemoryPreprocessResult> {
    const key = scopeKey(handle), generation = this.recallGenerations.get(key) ?? 0;
    if (this.closed) return Promise.reject(new Error('VCP memory client is closed.'));
    if (this.options.boundOwnerId && (options.ownerId !== this.options.boundOwnerId || handle.hostEvidence?.ownerId !== this.options.boundOwnerId))
      return Promise.reject(new Error('Prepared recall belongs to another owner.'));
    if (handle.hostEvidence && options.ownerId !== handle.hostEvidence.ownerId) return Promise.reject(new Error('Prepared recall belongs to another owner.'));
    if (this.focusing.has(handle.id)) return Promise.reject(new Error('Prepared recall is already being focused.'));
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const validate = async (reason: Parameters<NonNullable<VcpMemoryFocusOptions['validate']>>[0] = 'fence') => {
      signal.throwIfAborted();
      if (this.closed || (this.recallGenerations.get(key) ?? 0) !== generation) throw new Error('Prepared recall was withdrawn.');
      await options.validate?.(reason); signal.throwIfAborted();
    };
    const pending = (async () => {
      let lease: Awaited<ReturnType<VcpPreparedRecallStore['acquire']>> | undefined, discard = false;
      try {
        try { await validate(); } catch (error) { discard = true; throw error; }
        lease = await this.prepared.acquire(handle, signal); discard = !lease.payload.hostEvidence?.recovery;
        const finish = async (receipt: VcpMemoryPreprocessResult) => {
          if (lease!.payload.hostEvidence?.recovery) {
            if (!options.onFocused) throw new Error('Durable focusing requires its task checkpoint callback.');
            await validate('publication'); const hash = await this.prepared.completeFocus(lease!.handle, receipt);
            await options.onFocused(preparedRecallReference(lease!.handle, recoveryFromPayload(lease!.payload), hash)); await validate();
          }
          return receipt;
        };
        await validate();
        const cacheKey = this.focusCacheKey(handle.scopeId, lease.payload);
        const cached = this.focusedReceipts.get(cacheKey);
        if (cached && Date.now() - cached.createdAt < 60000) {
          this.focusedReceipts.delete(cacheKey); this.focusedReceipts.set(cacheKey, cached);
          const receipt = JSON.parse(cached.serialized) as VcpMemoryPreprocessResult;
          await validate('publication');
          return await finish({ ...receipt, queryClock: lease.payload.receipt.queryClock,
            receiptCache: { hit: true, corpusEpoch: handle.corpusEpoch,
              ...(receipt.queryClock ? { sourceQueryClock: receipt.queryClock } : {}) } });
        }
        const implementation = createRequire(path.join(this.options.vendorRoot, 'package.json'))(
          path.join(path.dirname(this.options.workerPath), 'prepared-focus.cjs')) as {
            focusPreparedRecall(payload: VcpMemoryPreparedPayload, configuration: { vendorRoot: string; chat?: VcpMemoryPluginConfiguration['chat'] }, options: VcpMemoryFocusOptions): Promise<VcpMemoryPreprocessResult>;
          };
        const result = await implementation.focusPreparedRecall(lease.payload,
          { vendorRoot: this.options.vendorRoot, chat: this.options.plugins?.chat }, { ...options, signal, validate });
        await validate(); const completed = await finish(result); this.cacheFocusedReceipt(cacheKey, handle.scopeId, result); return completed;
      } finally {
        try { if (discard || signal.aborted) await this.prepared.remove(handle); }
        finally { lease?.release(); }
      }
    })();
    this.focusing.set(handle.id, { scopeId: handle.scopeId, controller, settled: pending });
    void pending.finally(() => this.focusing.delete(handle.id)).catch(() => undefined);
    return pending;
  }
  /** Validate exactly the unchanged upstream candidate bytes against actual
   * owner canonical inputs before anchoring a task checkpoint or calling AI.
   * This does not rank, trim, expand or rewrite a candidate. */
  async verifyPreparedCanonicalNotes(handle: VcpMemoryPreparedRecall, inputs: readonly VcpMemoryNote[], signal?: AbortSignal): Promise<void> {
    if (this.closed || this.options.boundOwnerId && handle.hostEvidence?.ownerId !== this.options.boundOwnerId) throw new Error('Canonical preparation belongs to another owner or closed runtime.');
    const lease = await this.prepared.acquire(handle, signal);
    try {
      const payload = lease.payload;
      if (payload.receipt.contextReferenceCoverage !== 'observed') throw Object.assign(new Error('Native candidate source observations are incomplete.'), { code: 'VCP_MEMORY_CANONICAL_PROVENANCE_UNAVAILABLE' });
      const renderer = createRequire(path.join(this.options.vendorRoot, 'package.json'))(path.join(path.dirname(this.options.workerPath), 'runtime.cjs')) as { renderNativeDiaryText(note: VcpMemoryNote): string };
      const normalize = (text: string) => text.replaceAll('\r\n', '\n').trim();
      const expected = new Map(inputs.map(note => [note.id, normalize(renderer.renderNativeDiaryText(note))]));
      const verified = new Set<string>();
      for (const group of payload.groups) for (const file of group.options.sourceFiles) {
        signal?.throwIfAborted(); const text = String(file.content || file.text || '').trim(), digest = createHash('sha256').update(text).digest('hex');
        const references = payload.receipt.contextReferences?.filter(reference => reference.textHash === digest) ?? [];
        if (!references.length || references.some(reference => !expected.get(reference.id)?.includes(normalize(text))))
          throw Object.assign(new Error('The original native candidate does not match its actual canonical source bytes.'), { code: 'VCP_MEMORY_CANONICAL_SOURCE_CHANGED' });
        for (const reference of references) verified.add(reference.id + ':' + reference.textHash);
      }
      if (payload.receipt.contextReferences?.some(reference => !verified.has(reference.id + ':' + reference.textHash)
        && createHash('sha256').update(expected.get(reference.id) ?? '').digest('hex') !== reference.textHash))
        throw Object.assign(new Error('Native returned source bytes cannot be matched to their canonical inputs.'), { code: 'VCP_MEMORY_CANONICAL_PROVENANCE_UNAVAILABLE' });
      signal?.throwIfAborted();
    } finally { lease.release(); }
  }
  /** Recover the same task package without opening or querying a native graph. */
  async resumeRecall(reference: CompanionPreparedRecallReference, options: VcpMemoryFocusOptions & {
    validateRecovery(recovery: PreparedRecallRecovery, observed: Pick<VcpMemoryPreprocessResult, 'contextReferences' | 'contextReferenceCoverage'>): Promise<void>;
  }): Promise<{ processed: VcpMemoryPreprocessResult; recovery: PreparedRecallRecovery }> {
    if (this.closed || this.options.boundOwnerId !== reference.ownerId || options.ownerId !== reference.ownerId)
      throw new Error('Prepared recall recovery belongs to another owner or closed runtime.');
    const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    if (this.focusing.has(reference.id)) throw new Error('Prepared recall is already being focused.');
    const operation = (async () => {
      const lease = await this.prepared.acquireReference(reference, signal);
      try {
        const recovery = recoveryFromPayload(lease.payload);
        if (this.options.semanticProfileKey !== recovery.profileKey || await this.algorithmSignature() !== recovery.algorithmSignature)
          throw new Error('Prepared recall semantic model or algorithm has changed.');
        const validate = async () => { signal.throwIfAborted(); if (this.closed) throw new Error('Prepared recall was withdrawn.');
          await options.validate?.(); await options.validateRecovery(recovery, lease.payload.receipt); signal.throwIfAborted(); };
        await validate();
        if (lease.focused) { await validate(); return { processed: lease.focused.receipt, recovery }; }
        if (!options.onFocused) throw new Error('Durable recovery requires its task checkpoint callback.');
        const implementation = createRequire(path.join(this.options.vendorRoot, 'package.json'))(path.join(path.dirname(this.options.workerPath), 'prepared-focus.cjs')) as {
          modelIdentity(chat: VcpMemoryPluginConfiguration['chat']): string;
          focusPreparedRecall(payload: VcpMemoryPreparedPayload, configuration: { vendorRoot: string; chat?: VcpMemoryPluginConfiguration['chat'] }, options: VcpMemoryFocusOptions): Promise<VcpMemoryPreprocessResult>;
        };
        // A restart changes the authenticated loopback port/token. Only this
        // verified semantic owner/profile recovery route may rebind transport;
        // the captured source order, template, clock and native inputs stay fixed.
        const rebound = { ...lease.payload, modelIdentity: implementation.modelIdentity(this.options.plugins?.chat) };
        const processed = await implementation.focusPreparedRecall(rebound, { vendorRoot: this.options.vendorRoot, chat: this.options.plugins?.chat },
          { ...options, signal, validate });
        await validate(); const hash = await this.prepared.completeFocus(lease.handle, processed);
        await options.onFocused(preparedRecallReference(lease.handle, recovery, hash)); await validate();
        return { processed, recovery };
      } finally { try { if (signal.aborted) await this.prepared.remove(lease.handle); } finally { lease.release(); } }
    })();
    this.focusing.set(reference.id, { scopeId: reference.scopeId, controller, settled: operation });
    try { return await operation; } finally { this.focusing.delete(reference.id); }
  }
  /** Explicitly cancel one immutable packet, including before focusing starts. */
  async discardRecall(handle: VcpMemoryPreparedRecall): Promise<void> {
    const active = this.focusing.get(handle.id);
    if (active && active.scopeId !== handle.scopeId) throw new Error('Prepared recall belongs to another scope.');
    active?.controller.abort(new Error('Prepared recall was cancelled.'));
    if (active) await Promise.allSettled([active.settled]);
    await this.prepared.remove(handle);
  }
  private focusCacheKey(scopeId: string, payload: VcpMemoryPreparedPayload): string {
    const groups = payload.groups.map(({ token: _token, ...input }) => { void _token; return input; });
    const tokenIndexes = new Map(payload.groups.map((group, index) => [group.token, 'prepared-group-' + index]));
    const messages = payload.receipt.messages.map(message => ({ ...message, content: typeof message.content === 'string'
      ? message.content.replace(/WORLDLINE_PREPARED_FOCUS_[a-f0-9]{32}/gu, token => tokenIndexes.get(token) ?? token) : message.content }));
    return createHash('sha256').update(JSON.stringify([scopeId, payload.modelIdentity, groups, messages,
      payload.receipt.cacheClock?.bucket, payload.receipt.receiptCache?.corpusEpoch,
      payload.hostEvidence ? [payload.hostEvidence.ownerId, payload.hostEvidence.revocationEpoch, payload.hostEvidence.sourceClosureDigest] : null])).digest('hex');
  }
  private cacheFocusedReceipt(key: string, scopeId: string, receipt: VcpMemoryPreprocessResult): void {
    const serialized = JSON.stringify(receipt), bytes = Buffer.byteLength(serialized) + key.length + 128;
    if (bytes > 4 * 1024 * 1024) return;
    const prior = this.focusedReceipts.get(key);
    if (prior) { this.focusedReceiptBytes -= prior.bytes; this.focusedReceipts.delete(key); }
    while (this.focusedReceipts.size >= 32 || this.focusedReceiptBytes + bytes > 4 * 1024 * 1024) {
      const oldest = this.focusedReceipts.keys().next().value!;
      this.focusedReceiptBytes -= this.focusedReceipts.get(oldest)!.bytes; this.focusedReceipts.delete(oldest);
    }
    this.focusedReceipts.set(key, { scopeId, serialized, bytes, createdAt: Date.now() }); this.focusedReceiptBytes += bytes;
  }
  private async withdrawPrepared(scopeId?: string): Promise<void> {
    for (const [key, receipt] of this.focusedReceipts) if (!scopeId || receipt.scopeId === scopeId) {
      this.focusedReceiptBytes -= receipt.bytes; this.focusedReceipts.delete(key);
    }
    const focus = [...this.focusing.values()].filter(entry => !scopeId || entry.scopeId === scopeId);
    for (const entry of focus) entry.controller.abort(new Error('Prepared recall was withdrawn.'));
    await Promise.allSettled([...focus.map(entry => entry.settled),
      ...[...this.preparations].filter(([, owner]) => !scopeId || owner === scopeId).map(([pending]) => pending)]);
    if (scopeId) await this.prepared.purgeScope(scopeId); else await this.prepared.close();
  }
  dreamWave(scope: VcpMemoryScope, request: VcpMemoryDreamWaveRequest): Promise<VcpMemoryDreamWaveResult> { return this.request(scope, { type: 'dream-wave', request }); }
  timeline(scope: VcpMemoryScope, request: VcpMemoryTimelineRequest): Promise<unknown> { return this.request(scope, { type: 'timeline', request }); }
  capabilities(scope: VcpMemoryScope): Promise<VcpMemoryCapabilities> { return this.request(scope, { type: 'capabilities' }); }
  exportNotes(scope: VcpMemoryScope): Promise<VcpMemoryNote[]> { return this.request(scope, { type: 'export-notes' }); }
  exportTimelineArtifacts(scope: VcpMemoryScope, sourceRevision: string): Promise<VcpMemoryTimelineArtifacts> {
    return this.request(scope, { type: 'export-timelines', sourceRevision });
  }
  importTimelineArtifacts(scope: VcpMemoryScope, sourceRevision: string, artifacts: VcpMemoryTimelineArtifacts): Promise<{ acceptedMonths: number; skippedMonths: number }> {
    return this.request(scope, { type: 'import-timelines', sourceRevision, artifacts });
  }

  private stopScope(key: string, child: ScopeProcess): Promise<void> {
    this.broker.beginRetirement(`${this.brokerNamespace}:${key}`, child.brokerIdentity);
    return child.stopping ??= this.stopScopeOperation(key, child);
  }
  private async stopScopeOperation(key: string, child: ScopeProcess): Promise<void> {
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 180_000);
    while (child.busy > 0) {
      if (Date.now() > deadline) {
        const error = new Error('VCP memory scope did not become idle.');
        this.failProcess(child, error); await this.retiring.get(key); throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    try {
      await child.ready;
      if (!child.failed) await this.send(child, { type: 'close' });
    }
    finally {
      child.transport.kill();
      if (this.scopes.get(key) === child) this.scopes.delete(key);
      await this.waitForExit(child);
    }
  }
  async closeScope(scope: VcpMemoryScope): Promise<void> {
    const key = scopeKey(scope), child = this.scopes.get(key);
    this.scopeGenerations.set(key, (this.scopeGenerations.get(key) ?? 0) + 1);
    // Mark/stop immediately. Queuing stop behind an acquire waiting for this
    // retiring process would deadlock the per-client admission queue.
    const stop = child ? this.stopScope(key, child) : this.retiring.get(key);
    const result = Promise.all([this.poolTail, stop]).then(() => undefined);
    this.poolTail = result.catch(() => undefined);
    return result;
  }
  /** Cancel active and already-queued work without waiting for a busy pool slot. */
  async interruptScope(scope: VcpMemoryScope, options: { preservePrepared?: boolean } = {}): Promise<void> {
    const key = scopeKey(scope);
    this.scopeGenerations.set(key, (this.scopeGenerations.get(key) ?? 0) + 1);
    if (!options.preservePrepared) this.recallGenerations.set(key, (this.recallGenerations.get(key) ?? 0) + 1);
    const child = this.scopes.get(key);
    if (child) this.failProcess(child, new Error('VCP memory scope was interrupted.'));
    await Promise.all([this.retiring.get(key), options.preservePrepared ? undefined : this.withdrawPrepared(scope.scopeId)]);
  }
  async purgeScope(scope: VcpMemoryScope): Promise<void> {
    const closing = this.closeScope(scope);
    await this.withdrawPrepared(scope.scopeId);
    const result = this.poolTail.then(async () => {
      const key = scopeKey(scope); await closing;
      const base = path.resolve(this.options.dataRoot), target = path.resolve(base, key);
      if (path.dirname(target) !== base || !/^[a-f0-9]{64}$/u.test(path.basename(target))) throw new Error('Unsafe VCP scope deletion path.');
      await removeOwnedDirectory(target);
    });
    this.poolTail = result.catch(() => undefined);
    return result;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const child of this.scopes.values()) if (child.busy > 0) this.failProcess(child, new Error('VCP memory client is closing.'));
    await this.withdrawPrepared();
    await this.poolTail;
    const results = await Promise.allSettled([...this.scopes].map(([key, child]) => this.stopScope(key, child)));
    await Promise.all(this.retiring.values());
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  /** All scope directories are rebuildable projections. A configuration change
   * retires their old graph/model caches after every process has actually exited. */
  async retire(): Promise<void> {
    await this.close();
    const base = path.resolve(this.options.dataRoot);
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      const target = path.resolve(base, entry.name);
      if (path.dirname(target) !== base) throw new Error('Unsafe retired VCP scope path.');
      await removeOwnedDirectory(target);
    }
  }
}
