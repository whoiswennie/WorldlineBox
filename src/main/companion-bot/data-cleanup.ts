import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { BotDataCleanup } from '../../shared/companion-bot';
import workerSource from './data-cleanup-worker.cjs?raw';

interface CleanupJob extends BotDataCleanup { requestId: string; all?: boolean }
interface Options {
  root: string;
  moduleRoot?: string;
  quiesce(): Promise<void>;
  changed(): void;
  resume(job: BotDataCleanup): void;
  report?(error: unknown): void;
}

/** One durable, restartable erasure at a time. Main only handles small receipts;
 * the worker owns planning, SQL batches, traversal and physical deletion. */
export class BotDataCleanupService {
  private readonly jobs = new Map<string, CleanupJob>();
  private readonly directory: string;
  private readonly starting: Promise<void>;
  private running?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private worker?: Worker;
  private closed = false;
  private fenced = false;
  constructor(private readonly options: Options) {
    this.directory = path.join(options.root, 'data-cleanup');
    this.starting = this.load();
  }
  get busy(): boolean { return this.fenced; }
  async ready(): Promise<void> { await this.starting; }
  private async save(job: CleanupJob): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, job.id + '.json'), temporary = file + '.tmp';
    await writeFile(temporary, JSON.stringify(job), { mode: 0o600 }); await rename(temporary, file);
    this.jobs.set(job.id, job); this.options.changed();
  }
  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) if (/^[a-f0-9-]{36}\.json$/.test(file)) {
      const job = JSON.parse(await readFile(path.join(this.directory, file), 'utf8')) as CleanupJob;
      if (job.id + '.json' !== file || !job.companionId || !job.requestId || !['pending','running','retrying','completed'].includes(job.status)) throw Error('伙伴清理记录损坏，已停止接收新的伙伴消息。');
      job.all ??= false;
      this.jobs.set(job.id, job);
      if (job.status !== 'completed') this.fenced = true;
    }
    queueMicrotask(() => this.wake());
  }
  async status(companionId: string): Promise<BotDataCleanup | undefined> {
    await this.starting;
    return [...this.jobs.values()].filter(job => job.companionId === companionId || job.all).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
  async begin(companionId: string, requestId: string, all = false): Promise<BotDataCleanup> {
    await this.starting;
    if (this.closed) throw Error('伙伴清理服务已关闭。');
    const previous = [...this.jobs.values()].find(job => job.requestId === requestId);
    if (previous) { if (previous.companionId !== companionId || previous.all !== all) throw Error('清理请求编号不匹配。'); return previous; }
    const active = [...this.jobs.values()].find(job => job.status !== 'completed');
    if (active) { if (active.companionId === companionId && active.all === all) return active; throw Error('正在清理另一位伙伴，请等待完成。'); }
    this.fenced = true;
    const job: CleanupJob = { id: randomUUID(), companionId, requestId, all, status: 'pending', phase: 'stopping', removed: 0, createdAt: new Date().toISOString() };
    // Reserve synchronously before the receipt write: two IPC requests cannot
    // admit different erasures while both are waiting for the filesystem.
    this.jobs.set(job.id, job);
    try { await this.save(job); } catch (error) { this.jobs.delete(job.id); this.fenced = false; throw error; }
    this.wake(); return job;
  }
  private wake(): void {
    if (this.closed || this.running) return;
    const job = [...this.jobs.values()].find(job => job.status !== 'completed'); if (!job) return;
    this.running = this.run(job).finally(() => { this.running = undefined; });
  }
  private async run(job: CleanupJob): Promise<void> {
    try {
      await this.save({ ...job, status: 'running', phase: 'stopping', error: undefined });
      await this.options.quiesce();
      if (this.closed) return;
      const nativeModule = createRequire(path.join(this.options.moduleRoot ?? process.cwd(), 'package.json')).resolve('better-sqlite3');
      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(workerSource, { eval: true, name: 'WorldlineBox companion data cleanup',
          workerData: { root: this.options.root, job, nativeModule } }); this.worker = worker;
        let complete = false;
        worker.on('message', (message: { phase?: BotDataCleanup['phase']; removed?: number; complete?: boolean; error?: string }) => {
          if (message.error) { reject(new Error(message.error)); return; }
          const current = this.jobs.get(job.id)!;
          this.jobs.set(job.id, { ...current, ...(message.phase ? { phase: message.phase } : {}), removed: message.removed ?? current.removed });
          this.options.changed();
          if (message.complete) complete = true;
        });
        worker.once('error', reject);
        worker.once('exit', code => { this.worker = undefined; if (complete && code === 0) resolve(); else reject(new Error(`伙伴后台清理中断 (${code})，会继续原清理。`)); });
      });
      await this.save({ ...this.jobs.get(job.id)!, status: 'completed', phase: 'completed', completedAt: new Date().toISOString(), error: undefined });
      this.fenced = false; this.options.resume(this.jobs.get(job.id)!); this.options.changed();
    } catch (error) {
      if (this.closed) return;
      const retrying: CleanupJob = { ...this.jobs.get(job.id)!, status: 'retrying', error: error instanceof Error ? error.message : String(error) };
      this.jobs.set(job.id, retrying);
      try { await this.save(retrying); } catch (saveError) { this.options.report?.(saveError); }
      this.options.report?.(error);
      this.retry = setTimeout(() => this.wake(), 3000); this.retry.unref?.();
    }
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.retry); await this.starting.catch(() => undefined);
    await this.worker?.terminate(); await this.running;
  }
}
