import { utilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { VcpMemoryTransport } from './client';
import type { ColdKnowledgeCommand, ColdKnowledgeWorkerConfiguration } from './cold-contracts';
import { detachRuntimeDependencyLinks } from './filesystem';

export interface ColdKnowledgeClientOptions extends ColdKnowledgeWorkerConfiguration {
  workerPath: string; launch?: (workerPath: string) => VcpMemoryTransport; requestTimeoutMs?: number;
}
export class ColdKnowledgeClient {
  private child?: VcpMemoryTransport;
  private ready?: Promise<unknown>;
  private exited?: Promise<void>;
  private closed = false;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly options: ColdKnowledgeClientOptions) {}
  private launch(): VcpMemoryTransport {
    if (this.options.launch) return this.options.launch(this.options.workerPath);
    const process = utilityProcess.fork(this.options.workerPath, [], { serviceName: 'WorldlineBox Cold Knowledge', stdio: 'pipe' });
    process.stdout?.resume(); process.stderr?.resume();
    const events = new EventEmitter();
    process.on('message', value => events.emit('message', value)); process.on('exit', code => events.emit('exit', code));
    process.on('error', () => events.emit('error', new Error('The cold knowledge worker failed.')));
    return { postMessage: value => process.postMessage(value), on: events.on.bind(events), kill: () => { process.kill(); } };
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.child?.kill(); this.child = undefined; this.ready = undefined;
  }
  private send(command: ColdKnowledgeCommand): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('The cold worker is unavailable.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('The cold knowledge worker timed out.')); }, this.options.requestTimeoutMs ?? 300000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.child!.postMessage({ requestId, command: JSON.parse(JSON.stringify(command)) }); }
      catch { this.fail(new Error('The cold knowledge worker transport failed.')); }
    });
  }
  async request<T>(command: Exclude<ColdKnowledgeCommand, { type: 'initialize' }>): Promise<T> {
    if (this.closed) throw new Error('Cold knowledge has closed.');
    if (!this.ready) {
      if (this.exited) await this.waitExit();
      const child = this.child = this.launch();
      this.exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
      child.on('message', value => {
        const result = value as { requestId?: string; ok?: boolean; value?: unknown; error?: { message?: string } };
        const pending = result.requestId && this.pending.get(result.requestId); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(result.requestId!);
        if (result.ok) pending.resolve(result.value); else pending.reject(new Error(result.error?.message || 'Cold knowledge operation failed.'));
      });
      child.on('exit', () => { if (this.child === child) this.fail(new Error('The cold knowledge worker stopped.')); });
      child.on('error', () => { if (this.child === child) this.fail(new Error('The cold knowledge worker failed.')); });
      this.ready = this.send({ type: 'initialize', configuration: this.options });
    }
    try { await this.ready; } catch (error) { this.fail(error instanceof Error ? error : new Error('Cold initialization failed.')); throw error; }
    return await this.send(command) as T;
  }
  private async waitExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The cold knowledge worker did not stop.')), 5000); })]);
      await detachRuntimeDependencyLinks(this.options.dataRoot); }
    finally { if (timer) clearTimeout(timer); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { if (this.pending.size) this.fail(new Error('Cold knowledge has closed.'));
      else if (this.ready && this.child) { await this.ready; await this.send({ type: 'close' }); } }
    finally { this.fail(new Error('Cold knowledge has closed.')); if (this.exited) await this.waitExit(); }
  }
}
