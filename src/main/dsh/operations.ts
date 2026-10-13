import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile, rm } from 'node:fs/promises';
import { dshOperationSchema, isDshOperationTerminal, type DshOperation } from '../../shared/dsh-launcher';
import { atomicJson, contained, readJson, redact } from './files';
import { OperationDownloadControl, type DownloadControl } from './download-control';

export interface OperationContext {
  id: string; signal: AbortSignal;
  update(phase: string, progress?: number): Promise<void>;
  log(message: string): Promise<void>;
  download?: DownloadControl;
}
export class OperationStore {
  private records: DshOperation[] = [];
  private readonly pending = new Map<string, { controller: AbortController; task: Promise<void>; download: OperationDownloadControl }>();
  private writes = Promise.resolve();
  constructor(private readonly rootPath: string, private readonly onChanged: () => void) {}
  async init(): Promise<void> {
    const values = await readJson<unknown[]>(path.join(this.rootPath, 'operations.json')) ?? [];
    this.records = values.map(value => dshOperationSchema.parse(value));
    for (const record of this.records) if (record.status === 'running') {
      record.status = 'interrupted'; record.phase = 'interrupted';
      record.error = 'The application exited before this operation completed. The previous instance was preserved.';
      record.finishedAt = new Date().toISOString();
      if (record.download) { record.download.canPause = false; record.download.paused = false; record.download.speedBytesPerSecond = 0; }
    }
    await this.save();
  }
  list(): DshOperation[] { return structuredClone(this.records); }
  private save(): Promise<void> {
    const values = this.list();
    this.writes = this.writes.catch(() => undefined).then(() => atomicJson(path.join(this.rootPath, 'operations.json'), values));
    return this.writes;
  }
  async run(kind: string, label: string, instanceId: string | undefined, work: (operation: OperationContext) => Promise<void>, retryRequest?: DshOperation['retryRequest']): Promise<string> {
    const record: DshOperation = { id: randomUUID(), kind, label, instanceId, retryRequest, status: 'running', phase: 'preparing', startedAt: new Date().toISOString() };
    this.records.unshift(record);
    this.records = this.records.slice(0, 300);
    try { await this.save(); }
    catch (error) { this.records = this.records.filter(value => value.id !== record.id); throw error; }
    this.onChanged();
    const controller = new AbortController();
    const download = new OperationDownloadControl(record, controller.signal, async () => { await this.save(); this.onChanged(); });
    const task = Promise.resolve().then(async () => {
      const context: OperationContext = {
        id: record.id, signal: controller.signal, download,
        update: async (phase, progress) => { record.phase = phase; if (progress !== undefined) record.progress = Math.max(record.progress ?? 0, Math.max(0, Math.min(100, progress))); await this.save(); this.onChanged(); },
        log: async message => { await appendFile(path.join(this.rootPath, `${record.id}.log`), `${redact(message)}\n`); },
      };
      try { controller.signal.throwIfAborted(); await work(context); record.status = 'succeeded'; record.phase = 'completed'; record.progress = 100; }
      catch (error) { record.status = controller.signal.aborted ? 'cancelled' : 'failed'; record.phase = record.status; record.error = redact(error instanceof Error ? error.message : String(error)); }
      finally {
        await download.end().catch(() => undefined);
        record.finishedAt = new Date().toISOString();
        try { await this.save(); }
        catch (error) { record.error = `Operation journal could not be saved: ${redact(String(error))}`; }
        this.pending.delete(record.id); this.onChanged();
      }
    });
    this.pending.set(record.id, { controller, task, download });
    return record.id;
  }
  cancel(id: string): void {
    const operation = this.pending.get(id);
    if (!operation) throw new Error('This operation is no longer running.');
    const record = this.records.find(value => value.id === id);
    if (record) {
      record.phase = 'cancelling';
      if (record.download) { record.download.canPause = false; record.download.paused = false; record.download.speedBytesPerSecond = 0; }
      void this.save().then(() => this.onChanged()).catch(() => undefined);
    }
    operation.controller.abort(new Error('Operation cancelled.'));
  }
  async pause(id: string): Promise<void> {
    const operation = this.pending.get(id); if (!operation) throw new Error('This task is no longer running.');
    await operation.download.pause();
  }
  async resume(id: string): Promise<void> {
    const operation = this.pending.get(id); if (!operation) throw new Error('This task was interrupted; retry it instead.');
    await operation.download.resume();
  }
  retryRequest(id: string): NonNullable<DshOperation['retryRequest']> {
    const operation = this.records.find(value => value.id === id);
    if (!operation || !isDshOperationTerminal(operation) || !operation.retryRequest) throw new Error('This task cannot be retried.');
    return structuredClone(operation.retryRequest);
  }
  async clearFinished(): Promise<number> {
    // A task may already have terminal status while its final journal write is pending.
    const finished = this.records.filter(record => isDshOperationTerminal(record) && !this.pending.has(record.id));
    if (!finished.length) return 0;
    for (const record of finished) {
      // No recursive removal: only this validated operation's exact .log may be removed.
      await rm(contained(this.rootPath, `${record.id}.log`), { force: true });
    }
    const ids = new Set(finished.map(record => record.id));
    this.records = this.records.filter(record => !ids.has(record.id));
    try { await this.save(); }
    catch (error) {
      // Preserve operations created while the journal write was in flight.
      this.records = [...this.records, ...finished].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      throw error;
    }
    this.onChanged();
    return finished.length;
  }
  async settle(): Promise<void> { await Promise.all([...this.pending.values()].map(value => value.task)); }
  async shutdown(): Promise<void> {
    for (const { controller } of this.pending.values()) controller.abort(new Error('Application closing.'));
    await this.settle(); await this.writes;
  }
}
