import { utilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { VcpMemoryTransport } from './client';
import type { ColdKnowledgeCommand, ColdKnowledgeWorkerConfiguration } from './cold-contracts';
import { detachRuntimeDependencyLinks } from './filesystem';
import { VcpMemoryProcessBroker } from './process-broker';

export interface ColdKnowledgeClientOptions extends ColdKnowledgeWorkerConfiguration {
  workerPath: string; launch?: (workerPath: string) => VcpMemoryTransport; requestTimeoutMs?: number;
  processBroker?: VcpMemoryProcessBroker;
}
interface ColdProcess {
  transport: VcpMemoryTransport; identity: symbol; ready: Promise<unknown>; exited: Promise<void>; finalized: Promise<void>;
  pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
  failed: boolean; busy: number; stopping?: Promise<void>; exitObserved: boolean;
}

/** Cold and hot work share actual process permits. Idle retirement does not
 * close the logical service; published cold generations remain on owner disk. */
export class ColdKnowledgeClient {
  private child?: ColdProcess;
  private retiring?: ColdProcess;
  private closed = false;
  private closing?: Promise<void>;
  private readonly requests = new Set<Promise<unknown>>();
  private readonly broker: VcpMemoryProcessBroker;
  private readonly brokerKey = 'cold:' + randomUUID();
  constructor(private readonly options: ColdKnowledgeClientOptions) { this.broker = options.processBroker ?? new VcpMemoryProcessBroker(1); }
  private launch(): VcpMemoryTransport {
    if (this.options.launch) return this.options.launch(this.options.workerPath);
    const process = utilityProcess.fork(this.options.workerPath, [], { serviceName: 'WorldlineBox Cold Knowledge', stdio: 'pipe' });
    process.stdout?.resume(); process.stderr?.resume();
    const events = new EventEmitter();
    process.on('message', value => events.emit('message', value)); process.on('exit', code => events.emit('exit', code));
    process.on('error', () => events.emit('error', new Error('The cold knowledge worker failed.')));
    return { postMessage: value => process.postMessage(value), on: events.on.bind(events), kill: () => { process.kill(); } };
  }
  private rejectAll(child: ColdProcess, error: Error): void {
    for (const request of child.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    child.pending.clear();
  }
  private trackRetirement(child: ColdProcess): void {
    this.retiring = child;
    void child.finalized.then(() => { if (this.retiring === child) this.retiring = undefined; }, () => undefined);
  }
  private fail(child: ColdProcess, error: Error): void {
    if (child.failed) return;
    child.failed = true; this.broker.beginRetirement(this.brokerKey, child.identity);
    this.rejectAll(child, error); if (this.child === child) this.child = undefined;
    child.transport.kill(); this.trackRetirement(child);
  }
  private send(child: ColdProcess, command: ColdKnowledgeCommand, deadline: number): Promise<unknown> {
    if (child.failed) return Promise.reject(new Error('The cold worker is unavailable.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, new Error('The cold knowledge worker timed out.')), Math.max(1, deadline - Date.now()));
      child.pending.set(requestId, { resolve, reject, timer });
      try { child.transport.postMessage({ requestId, command: JSON.parse(JSON.stringify(command)) }); }
      catch { this.fail(child, new Error('The cold knowledge worker transport failed.')); }
    });
  }
  private open(identity: symbol, deadline: number): { stop(): Promise<void> } {
    const transport = this.launch(); let exited!: () => void;
    const child: ColdProcess = { transport, identity, ready: Promise.resolve(), exited: new Promise<void>(resolve => { exited = resolve; }),
      finalized: Promise.resolve(), pending: new Map(), failed: false, busy: 0, exitObserved: false };
    this.child = child;
    child.finalized = child.exited.then(async () => {
      await detachRuntimeDependencyLinks(this.options.dataRoot);
      this.broker.retired(this.brokerKey, child.identity);
    });
    // A cleanup failure keeps the permit quarantined and remains observable
    // by close/LRU. Sending kill is never proof of process exit.
    void child.finalized.catch(() => undefined);
    transport.on('message', value => {
      if (!value || typeof value !== 'object') return;
      const result = value as { requestId?: string; ok?: boolean; value?: unknown; error?: { message?: string } };
      const pending = typeof result.requestId === 'string' && child.pending.get(result.requestId); if (!pending) return;
      clearTimeout(pending.timer); child.pending.delete(result.requestId!);
      if (result.ok === true) pending.resolve(result.value); else pending.reject(new Error(result.error?.message || 'Cold knowledge operation failed.'));
    });
    transport.on('exit', () => { child.exitObserved = true; exited(); this.fail(child, new Error('The cold knowledge worker stopped.')); });
    transport.on('error', () => this.fail(child, new Error('The cold knowledge worker failed.')));
    const configuration: ColdKnowledgeWorkerConfiguration = { dataRoot: this.options.dataRoot, vendorRoot: this.options.vendorRoot, embedding: { ...this.options.embedding } };
    child.ready = this.send(child, { type: 'initialize', configuration }, deadline);
    void child.ready.catch(error => this.fail(child, error instanceof Error ? error : new Error('Cold initialization failed.')));
    return { stop: () => this.stop(child) };
  }
  request<T>(command: Exclude<ColdKnowledgeCommand, { type: 'initialize' }>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Cold knowledge has closed.'));
    if (this.requests.size >= 128) return Promise.reject(Object.assign(new Error('The cold knowledge request queue is at capacity.'), { code: 'VCP_MEMORY_NATIVE_CAPACITY' }));
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 300000);
    const current = () => { if (this.closed) throw new Error('Cold knowledge has closed.');
      if (Date.now() >= deadline) throw new Error('The cold knowledge worker timed out.'); };
    const operation = (async () => {
      const permit = await this.broker.acquire(this.brokerKey, { deadline, assertCurrent: current, open: identity => this.open(identity, deadline) });
      let child: ColdProcess | undefined, busy = false;
      try { current(); child = this.child; if (!child || child.failed) throw new Error('The cold worker is unavailable.');
        child.busy++; busy = true; await child.ready; current(); return await this.send(child, command, deadline) as T;
      } finally { if (child && busy) child.busy--; permit.release(); }
    })();
    this.requests.add(operation); void operation.finally(() => this.requests.delete(operation)).catch(() => undefined); return operation;
  }
  private async waitExit(child: ColdProcess): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([child.finalized, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('The cold knowledge worker shutdown did not finish.'),
        { code: 'VCP_MEMORY_SHUTDOWN_TIMEOUT', diagnostic: { exitObserved: child.exitObserved, dependencyCleanupPending: child.exitObserved } })), 5000);
    })]); } finally { if (timer) clearTimeout(timer); }
  }
  private stop(child: ColdProcess): Promise<void> {
    this.broker.beginRetirement(this.brokerKey, child.identity);
    return child.stopping ??= (async () => {
      try { await child.ready; if (!child.failed) await this.send(child, { type: 'close' }, Date.now() + 5000); }
      finally { child.transport.kill(); this.trackRetirement(child); await this.waitExit(child); }
    })();
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      const child = this.child;
      let stop: Promise<void> | undefined;
      if (child?.busy || child?.pending.size) { this.fail(child, new Error('Cold knowledge has closed.')); stop = this.waitExit(child); }
      else if (child) stop = this.stop(child);
      else if (this.retiring) stop = this.waitExit(this.retiring);
      await Promise.allSettled([...this.requests]); await stop;
      if (!this.options.processBroker) await this.broker.close();
    })();
  }
}
