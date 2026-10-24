import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { DshCliSelection } from './cli-terminal';
import { lstat, readdir, readFile } from './disk';
import { terminateOwnedProcess } from './instance-process';

/** Content generation, including secrets, is hashed locally and never logged. */
export async function dshWorkerGeneration(root: string, selection: DshCliSelection, access: unknown, parts?: Map<string, string>): Promise<string> {
  const digest = createHash('sha256');
  digest.update(JSON.stringify({ instance: selection.instance.id, runtime: selection.runtime, args: selection.nativeArgs,
    executable: selection.plan.executable, access, env: Object.entries(selection.env).sort(([a], [b]) => a.localeCompare(b)) }));
  const excluded = new Set(['node_modules', '.git', 'storages', 'sessions', 'logs', 'cache', 'llm-deepseek', 'skills-disabled', '.anonymous-user-id']);
  let files = 0, bytes = 0;
  const read = async (file: string, recursive = false): Promise<void> => {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    digest.update(file); if (!info) { digest.update('missing'); return; }
    if (info.isSymbolicLink()) { digest.update(String(info.mtimeMs)); return; }
    if (info.isDirectory() && recursive) {
      for (const entry of (await readdir(file)).sort()) if (!excluded.has(entry)) await read(path.join(file, entry), true);
    } else if (info.isFile()) {
      // Large skill assets remain usable without rereading them on every task.
      // Their filesystem identity/mtime participates; ordinary config text is content-hashed.
      const metadata = ++files > 4096 || info.size > 1024 ** 2 || (bytes += info.size) > 32 * 1024 ** 2;
      const content = metadata ? Buffer.from(JSON.stringify({size:info.size,mtime:info.mtimeMs,ino:info.ino})) : await readFile(file); digest.update(content);
      parts?.set(file, createHash('sha256').update(content).digest('hex'));
    }
  };
  await read(selection.instance.homePath, true);
  await read(selection.instance.agentsPath, true);
  for (const file of [selection.routingPatch, ...((selection.nativeArgs ?? []).flatMap((arg, index, all) => arg === '--patch' ? [all[index + 1]] : [])),
    path.join(root, 'shared', 'model-settings.json'), path.join(root, 'shared', '.credentials.yaml')]) if (file) await read(file);
  // Dotenv is process-scoped, unlike native tools' session-scoped working directory.
  // Hash its content without the per-task directory identity so empty managed tasks share a worker.
  const dotenv = await readFile(path.join(selection.workspacePath, '.env')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
  digest.update(dotenv);
  return digest.digest('hex');
}

export interface DshWarmWorker {
  child: ChildProcessWithoutNullStreams; key: string; instanceId: string; uses: number; busy: boolean; retired?: boolean;
  ready: Promise<void>; finished?: { resolve: (code: number) => void; reject: (error: Error) => void };
  disposeContext(): Promise<void>; timer?: ReturnType<typeof setTimeout>; dead: boolean;
  destroying?: Promise<void>;
  isReady?: boolean;
}
export interface DshWarmLease { worker: DshWarmWorker; reused: boolean; release(): void; destroy(): Promise<void>; }

/** Hosts never run two requests concurrently. All process exits go through the owned Windows Job. */
export class DshWarmCliPool {
  private readonly workers = new Set<DshWarmWorker>();
  private closed = false;
  private standbyInstanceId?: string;
  constructor(private readonly onReadyChanged?: (instanceId: string, ready: boolean) => void) {}
  /** Keep one selected instance host ready; its normal use/generation limits still apply. */
  setStandbyInstance(instanceId?: string): void {
    if (this.standbyInstanceId === instanceId || this.closed) return;
    this.standbyInstanceId = this.closed ? undefined : instanceId;
    this.armIdleTimers();
  }
  private standby(): DshWarmWorker | undefined {
    return [...this.workers].find(worker => worker.instanceId === this.standbyInstanceId && !worker.busy && worker.isReady && worker.uses < 32 && !worker.dead && !worker.retired);
  }
  private armIdleTimers(): void {
    const standby = this.standby();
    for (const worker of this.workers) {
      if (worker.busy || worker.dead) continue;
      if (worker === standby) { clearTimeout(worker.timer); worker.timer = undefined; }
      else if (!worker.timer) {
        worker.timer = setTimeout(() => { void this.destroy(worker).catch(() => undefined); }, 5 * 60_000);
        worker.timer.unref();
      }
    }
  }
  private changed(instanceId: string): void {
    this.onReadyChanged?.(instanceId, [...this.workers].some(worker => worker.instanceId === instanceId && worker.isReady && !worker.dead && !worker.retired));
  }
  async acquire(key: string, instanceId: string, start: () => Promise<{ child: ChildProcessWithoutNullStreams; disposeContext(): Promise<void> }>, signal: AbortSignal): Promise<DshWarmLease> {
    if (this.closed) throw new Error('The DSH worker pool is closing.');
    signal.throwIfAborted();
    for (const worker of this.workers) if (!worker.busy && (worker.key !== key && worker.instanceId === instanceId)) await this.destroy(worker);
    signal.throwIfAborted();
    if (this.closed) throw new Error('The DSH worker pool is closing.');
    let worker = [...this.workers].find(value => !value.busy && !value.dead && !value.retired && value.key === key);
    const reused = !!worker;
    if (!worker) {
      const owned = await start();
      if (this.closed || signal.aborted) {
        try { await terminateOwnedProcess(owned.child); } finally { await owned.disposeContext(); }
        signal.throwIfAborted();
        throw new Error('The DSH worker pool is closing.');
      }
      let resolveReady!: () => void, rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => undefined);
      worker = { ...owned, key, instanceId, uses: 0, busy: true, ready, dead: false };
      this.workers.add(worker);
      const current = worker, decoder = new StringDecoder('utf8'); let pending = '';
      const failed = () => { current.dead = true; const error = new Error('The native DSH worker stopped unexpectedly.'); rejectReady(error); current.finished?.reject(error); void this.destroy(current).catch(() => undefined); };
      current.child.stdout.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk);
        if (pending.length > 2 * 1024 ** 2) { pending = ''; failed(); return; }
        let at = pending.indexOf('\n');
        while (at >= 0) {
          const line = pending.slice(0, at); pending = pending.slice(at + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'runtime_ready') { current.isReady = true; resolveReady(); this.changed(current.instanceId); }
            else if (event.type === 'task_finished') current.finished?.resolve(event.code === 0 ? 0 : 1);
            else if (event.type === 'worker_error') failed();
          } catch { /* Native logs are not protocol records. */ }
          at = pending.indexOf('\n');
        }
      });
      current.child.once('error', failed); current.child.once('close', failed); current.child.stderr.resume();
    }
    worker.busy = true; clearTimeout(worker.timer); worker.timer = undefined; worker.uses++;
    const current = worker;
    // Cold official-profile loading competes with runtime sealing and file scans.
    // Preserve the caller's earlier deadline; do not misclassify a busy host's
    // one-minute boundary as an Agent/task failure.
    const readyDeadline = AbortSignal.timeout(120_000);
    const bootSignal = AbortSignal.any([signal, readyDeadline]);
    const abort = () => { void this.destroy(current).catch(() => undefined); };
    bootSignal.addEventListener('abort', abort, { once: true });
    try { bootSignal.throwIfAborted(); await current.ready; bootSignal.throwIfAborted(); }
    catch (error) {
      await this.destroy(current);
      signal.throwIfAborted();
      if (readyDeadline.aborted && !signal.aborted) throw Object.assign(new Error('The native DSH host did not become ready within its startup window; no Agent input was admitted.'), { code: 'DSH_HOST_READY_TIMEOUT' });
      throw error;
    }
    finally { bootSignal.removeEventListener('abort', abort); }
    return { worker: current, reused, release: () => {
      current.finished = undefined; current.busy = false;
      if (current.dead || current.retired || current.uses >= 32 || this.closed) { current.retired = true; void this.destroy(current).catch(() => undefined); }
      else this.armIdleTimers();
      const standby = this.standby();
      const idle = [...this.workers].filter(worker => !worker.busy && worker !== current && worker !== standby && !worker.dead);
      while (idle.length >= 4 || idle.filter(worker => worker.instanceId === current.instanceId).length >= 2) {
        const oldest = idle.shift(); if (!oldest) break;
        void this.destroy(oldest).catch(() => undefined);
      }
    }, destroy: () => this.destroy(current) };
  }
  run(worker: DshWarmWorker, request: object): Promise<number> {
    if (worker.dead || worker.finished) return Promise.reject(new Error('The DSH worker is unavailable or already has a request.'));
    const completion = new Promise<number>((resolve, reject) => { worker.finished = { resolve, reject }; });
    worker.child.stdin.write(JSON.stringify({ ...request, type: 'open' }) + '\n', error => { if (error) worker.finished?.reject(error); });
    return completion;
  }
  private destroy(worker: DshWarmWorker): Promise<void> {
    if (worker.destroying) return worker.destroying;
    worker.destroying = Promise.resolve().then(async () => {
      clearTimeout(worker.timer); worker.dead = true;
      this.armIdleTimers();
      this.changed(worker.instanceId);
      await terminateOwnedProcess(worker.child);
      this.workers.delete(worker); await worker.disposeContext();
    }).catch(error => { worker.destroying = undefined; throw error; });
    return worker.destroying;
  }
  async invalidateIdle(instanceId?: string): Promise<void> {
    for (const worker of this.workers) if (!instanceId || worker.instanceId === instanceId) worker.retired = true;
    for (const id of new Set([...this.workers].map(worker => worker.instanceId))) this.changed(id);
    await Promise.all([...this.workers].filter(worker => !worker.busy && (!instanceId || worker.instanceId === instanceId)).map(worker => this.destroy(worker)));
  }
  async shutdown(): Promise<void> { this.closed = true; this.standbyInstanceId = undefined; await Promise.all([...this.workers].map(worker => this.destroy(worker))); }
}
