import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import { utilityProcess } from 'electron';
import { detachRuntimeDependencyLinks, removeOwnedDirectory } from './filesystem';
import { VcpMemoryProcessBroker } from './process-broker';
import type { VcpMemoryDreamWaveRequest, VcpMemoryDreamWaveResult } from './dream-contracts';
import type {
  VcpMemoryCommand, VcpMemoryDeleteReceipt, VcpMemoryEmbeddingConfig, VcpMemoryNote,
  VcpMemoryScope, VcpMemorySearchResult, VcpMemoryWriteReceipt,
  VcpMemoryMessage, VcpMemoryPluginConfiguration, VcpMemoryPluginName, VcpMemoryTimelineRequest,
  VcpMemoryTimelineArtifacts,
  VcpMemoryContextReference, VcpMemoryCapabilities, VcpMemoryQueryClock, VcpMemoryAutomaticDecayPolicy, VcpMemoryDecayObservation,
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
  private scopes = new Map<string, ScopeProcess>();
  private retiring = new Map<string, Promise<void>>();
  private scopeGenerations = new Map<string, number>();
  private closed = false;
  private poolTail: Promise<unknown> = Promise.resolve();
  private readonly broker: VcpMemoryProcessBroker;
  private readonly brokerNamespace = randomUUID();

  constructor(private readonly options: VcpMemoryClientOptions) {
    if (!Number.isInteger(options.embedding.dimension) || options.embedding.dimension < 1 || options.embedding.dimension > 4096) throw new Error('VCP embedding dimension must be between 1 and 4096.');
    this.broker = options.processBroker ?? new VcpMemoryProcessBroker(Math.max(1, Math.floor(options.maxOpenScopes ?? 4)));
  }
  hasOpenScope(scope: VcpMemoryScope): boolean {
    const child = this.scopes.get(scopeKey(scope)); return Boolean(child && !child.failed && !child.stopping);
  }

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
    const result = this.poolTail.then(async () => {
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
      } }).then(() => undefined).catch(error => {
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
    this.poolTail = result.catch(() => undefined);
    return result;
  }
  private async request<T>(scope: VcpMemoryScope, command: VcpMemoryCommand): Promise<T> {
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 180_000);
    const { child, release } = await this.ensureScope(scope, deadline);
    try { await child.ready; return await this.send(child, command) as T; }
    finally { child.busy--; child.used = Date.now(); release(); }
  }
  remember(scope: VcpMemoryScope, note: VcpMemoryNote): Promise<VcpMemoryWriteReceipt> { return this.request(scope, { type: 'remember', note }); }
  replace(scope: VcpMemoryScope, notes: VcpMemoryNote[]): Promise<{ replaced: true; count: number }> { return this.request(scope, { type: 'replace', notes }); }
  search(scope: VcpMemoryScope, query: { text: string; topK?: number }): Promise<VcpMemorySearchResult> { return this.request(scope, { type: 'search', text: query.text, topK: query.topK }); }
  read(scope: VcpMemoryScope, id: string): Promise<VcpMemoryNote | null> { return this.request(scope, { type: 'read', id }); }
  list(scope: VcpMemoryScope): Promise<VcpMemoryNote[]> { return this.request(scope, { type: 'list' }); }
  forget(scope: VcpMemoryScope, id: string): Promise<VcpMemoryDeleteReceipt> { return this.request(scope, { type: 'forget', id }); }
  pluginCall(scope: VcpMemoryScope, plugin: VcpMemoryPluginName, arguments_: Record<string, unknown>): Promise<{ result: unknown; indexed: boolean; contextReferences?: VcpMemoryContextReference[]; contextReferenceCoverage?: 'observed' | 'partial' }> {
    return this.request(scope, { type: 'plugin', plugin, arguments: arguments_ });
  }
  preprocess(scope: VcpMemoryScope, messages: VcpMemoryMessage[], clock?: VcpMemoryQueryClock, automaticDecay?: VcpMemoryAutomaticDecayPolicy): Promise<{ messages: VcpMemoryMessage[]; events: unknown[]; contextReferences?: VcpMemoryContextReference[]; contextReferenceCoverage?: 'observed' | 'partial'; queryClock?: VcpMemoryQueryClock; automaticDecay?: VcpMemoryDecayObservation[]; parsedTimeRanges?: Array<{ start: string; end: string }>; cacheClock?: { bucket: string; invalidated: boolean } }> { return this.request(scope, { type: 'preprocess', messages, ...(clock ? { clock } : {}), ...(automaticDecay ? { automaticDecay } : {}) }); }
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
  async interruptScope(scope: VcpMemoryScope): Promise<void> {
    const key = scopeKey(scope);
    this.scopeGenerations.set(key, (this.scopeGenerations.get(key) ?? 0) + 1);
    const child = this.scopes.get(key);
    if (child) this.failProcess(child, new Error('VCP memory scope was interrupted.'));
    await this.retiring.get(key);
  }
  async purgeScope(scope: VcpMemoryScope): Promise<void> {
    const closing = this.closeScope(scope);
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
