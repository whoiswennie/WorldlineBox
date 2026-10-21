import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { utilityProcess } from 'electron';
import { detachRuntimeDependencyLinks, removeOwnedDirectory } from './filesystem';
import type {
  VcpMemoryCommand, VcpMemoryDeleteReceipt, VcpMemoryEmbeddingConfig, VcpMemoryNote,
  VcpMemoryScope, VcpMemorySearchResult, VcpMemoryWriteReceipt,
  VcpMemoryMessage, VcpMemoryPluginConfiguration, VcpMemoryPluginName, VcpMemoryTimelineRequest,
  VcpMemoryTimelineArtifacts,
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
  /** Tests can launch the identical CJS worker with Node's fork transport. */
  launch?: (workerPath: string) => VcpMemoryTransport;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface ScopeProcess {
  key: string;
  transport: VcpMemoryTransport;
  ready: Promise<void>;
  pending: Map<string, Pending>;
  used: number;
  busy: number;
  exited: Promise<void>;
  failed: boolean;
  detached?: Promise<void>;
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

  constructor(private readonly options: VcpMemoryClientOptions) {
    if (!Number.isInteger(options.embedding.dimension) || options.embedding.dimension < 1 || options.embedding.dimension > 4096) throw new Error('VCP embedding dimension must be between 1 and 4096.');
  }
  hasOpenScope(scope: VcpMemoryScope): boolean {
    const child = this.scopes.get(scopeKey(scope)); return Boolean(child && !child.failed);
  }

  private rejectAll(child: ScopeProcess, error: Error): void {
    for (const pending of child.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    child.pending.clear();
  }
  private failProcess(child: ScopeProcess, error: Error): void {
    if (child.failed) return;
    child.failed = true;
    this.rejectAll(child, error);
    for (const [key, candidate] of this.scopes) if (candidate === child) this.scopes.delete(key);
    child.transport.kill();
    const retirement = this.waitForExit(child);
    this.retiring.set(child.key, retirement);
    void retirement.then(() => { if (this.retiring.get(child.key) === retirement) this.retiring.delete(child.key); }, () => undefined);
  }
  private async waitForExit(child: ScopeProcess): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('VCP memory process did not exit after shutdown.')), 5_000);
      })]);
      child.detached ??= detachRuntimeDependencyLinks(path.join(path.resolve(this.options.dataRoot), child.key));
      await child.detached;
    } finally { if (timer) clearTimeout(timer); }
  }
  private send(child: ScopeProcess, command: VcpMemoryCommand): Promise<unknown> {
    if (child.failed) return Promise.reject(new Error('VCP memory process is no longer available.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.pending.delete(requestId);
        const error = new Error('VCP memory request timed out.');
        reject(error); this.failProcess(child, error);
      }, this.options.requestTimeoutMs ?? 180_000);
      child.pending.set(requestId, { resolve, reject, timer });
      // The worker contract is JSON. Electron uses structured clone while Node's
      // test fork serializes implicitly; use the same plain payload for both.
      try { child.transport.postMessage(JSON.parse(JSON.stringify({ requestId, command }))); }
      catch (error) {
        clearTimeout(timer); child.pending.delete(requestId); reject(error);
        this.failProcess(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private ensureScope(scope: VcpMemoryScope): Promise<ScopeProcess> {
    const key = scopeKey(scope), generation = this.scopeGenerations.get(key) ?? 0;
    const assertCurrent = () => {
      if ((this.scopeGenerations.get(key) ?? 0) !== generation) throw new Error('VCP memory scope was interrupted.');
    };
    const result = this.poolTail.then(async () => {
      if (this.closed) throw new Error('VCP memory client is closed.');
      assertCurrent();
      await this.retiring.get(key);
      if (this.closed) throw new Error('VCP memory client is closed.');
      assertCurrent();
      const existing = this.scopes.get(key);
      if (existing) { existing.used = Date.now(); existing.busy++; return existing; }
      const limit = Math.max(1, Math.floor(this.options.maxOpenScopes ?? 4));
      const deadline = Date.now() + (this.options.requestTimeoutMs ?? 180_000);
      while (this.scopes.size >= limit) {
        if (this.closed) throw new Error('VCP memory client is closed.');
        assertCurrent();
        const idle = [...this.scopes.entries()].filter(([, child]) => child.busy === 0 && !child.failed)
          .sort((left, right) => left[1].used - right[1].used)[0];
        if (idle) { await this.stopScope(idle[0], idle[1]); break; }
        if (Date.now() > deadline) throw new Error('VCP memory process pool remained busy.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (this.closed) throw new Error('VCP memory client is closed.');
      assertCurrent();
      const transport = (this.options.launch ?? launchUtility)(this.options.workerPath);
      let acknowledgeExit: () => void = () => undefined;
      const exited = new Promise<void>(resolve => { acknowledgeExit = resolve; });
      const child: ScopeProcess = { key, transport, pending: new Map(), used: Date.now(), busy: 1, ready: Promise.resolve(), exited, failed: false };
      this.scopes.set(key, child);
      transport.on('message', message => {
        if (!message || typeof message !== 'object' || !('requestId' in message) || typeof message.requestId !== 'string') return;
        const pending = child.pending.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer); child.pending.delete(message.requestId);
        if ('ok' in message && message.ok === true) pending.resolve('value' in message ? message.value : undefined);
        else {
          const detail = 'error' in message && message.error && typeof message.error === 'object' ? message.error : {};
          pending.reject(Object.assign(new Error('message' in detail ? String(detail.message) : 'VCP memory operation failed.'),
            { code: 'code' in detail ? String(detail.code) : 'VCP_MEMORY_ERROR' }));
        }
      });
      transport.on('exit', code => {
        acknowledgeExit();
        child.failed = true;
        this.rejectAll(child, new Error(`VCP memory process exited (${code}).`));
        if (this.scopes.get(key) === child) this.scopes.delete(key);
      });
      transport.on('error', error => this.failProcess(child, error));
      child.ready = this.send(child, { type: 'initialize', configuration: {
        dataRoot: this.options.dataRoot, vendorRoot: this.options.vendorRoot, scope: { scopeId: scope.scopeId },
        embedding: this.options.embedding,
        plugins: this.options.plugins,
      } }).then(() => undefined).catch(error => {
        this.failProcess(child, error instanceof Error ? error : new Error(String(error))); throw error;
      });
      return child;
    });
    this.poolTail = result.catch(() => undefined);
    return result;
  }
  private async request<T>(scope: VcpMemoryScope, command: VcpMemoryCommand): Promise<T> {
    const child = await this.ensureScope(scope);
    try { await child.ready; return await this.send(child, command) as T; }
    finally { child.busy--; child.used = Date.now(); }
  }
  remember(scope: VcpMemoryScope, note: VcpMemoryNote): Promise<VcpMemoryWriteReceipt> { return this.request(scope, { type: 'remember', note }); }
  replace(scope: VcpMemoryScope, notes: VcpMemoryNote[]): Promise<{ replaced: true; count: number }> { return this.request(scope, { type: 'replace', notes }); }
  search(scope: VcpMemoryScope, query: { text: string; topK?: number }): Promise<VcpMemorySearchResult> { return this.request(scope, { type: 'search', text: query.text, topK: query.topK }); }
  read(scope: VcpMemoryScope, id: string): Promise<VcpMemoryNote | null> { return this.request(scope, { type: 'read', id }); }
  list(scope: VcpMemoryScope): Promise<VcpMemoryNote[]> { return this.request(scope, { type: 'list' }); }
  forget(scope: VcpMemoryScope, id: string): Promise<VcpMemoryDeleteReceipt> { return this.request(scope, { type: 'forget', id }); }
  pluginCall(scope: VcpMemoryScope, plugin: VcpMemoryPluginName, arguments_: Record<string, unknown>): Promise<{ result: unknown; indexed: boolean }> {
    return this.request(scope, { type: 'plugin', plugin, arguments: arguments_ });
  }
  preprocess(scope: VcpMemoryScope, messages: VcpMemoryMessage[]): Promise<{ messages: VcpMemoryMessage[]; events: unknown[] }> { return this.request(scope, { type: 'preprocess', messages }); }
  timeline(scope: VcpMemoryScope, request: VcpMemoryTimelineRequest): Promise<unknown> { return this.request(scope, { type: 'timeline', request }); }
  capabilities(scope: VcpMemoryScope): Promise<{ plugins: Record<string, { version: string; available: boolean }>; timelineGenerationConfigured: boolean; coldKnowledge: boolean }> { return this.request(scope, { type: 'capabilities' }); }
  exportNotes(scope: VcpMemoryScope): Promise<VcpMemoryNote[]> { return this.request(scope, { type: 'export-notes' }); }
  exportTimelineArtifacts(scope: VcpMemoryScope, sourceRevision: string): Promise<VcpMemoryTimelineArtifacts> {
    return this.request(scope, { type: 'export-timelines', sourceRevision });
  }
  importTimelineArtifacts(scope: VcpMemoryScope, sourceRevision: string, artifacts: VcpMemoryTimelineArtifacts): Promise<{ acceptedMonths: number; skippedMonths: number }> {
    return this.request(scope, { type: 'import-timelines', sourceRevision, artifacts });
  }

  private async stopScope(key: string, child: ScopeProcess): Promise<void> {
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 180_000);
    while (child.busy > 0) {
      if (Date.now() > deadline) {
        const error = new Error('VCP memory scope did not become idle.');
        this.failProcess(child, error); await this.retiring.get(key); throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    try { await child.ready; if (!child.failed) await this.send(child, { type: 'close' }); }
    finally {
      child.transport.kill();
      if (this.scopes.get(key) === child) this.scopes.delete(key);
      await this.waitForExit(child);
    }
  }
  async closeScope(scope: VcpMemoryScope): Promise<void> {
    const result = this.poolTail.then(async () => {
      const key = scopeKey(scope), child = this.scopes.get(key);
      await this.retiring.get(key);
      if (child) await this.stopScope(key, child);
    });
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
    const result = this.poolTail.then(async () => {
      const key = scopeKey(scope), child = this.scopes.get(key);
      await this.retiring.get(key);
      if (child) await this.stopScope(key, child);
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
}
