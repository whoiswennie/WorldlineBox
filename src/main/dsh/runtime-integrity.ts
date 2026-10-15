import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

interface Entry { generation: number; verified?: number; watcher?: FSWatcher; parent?: FSWatcher; pending?: Promise<void> }

/** Reuse a complete verification only while a live recursive change monitor remains intact. */
export class RuntimeIntegrity {
  private readonly entries = new Map<string, Entry>();
  async verify(directory: string, check: () => Promise<void>, signal?: AbortSignal, force = false): Promise<void> {
    signal?.throwIfAborted();
    let entry = this.entries.get(directory);
    if (!entry) {
      entry = { generation: 0 }; const current = entry;
      const lost = () => { current.generation++; current.watcher?.close(); current.parent?.close(); current.watcher = undefined; current.parent = undefined; };
      try {
        current.watcher = watch(directory, { recursive: true, persistent: false }, () => { current.generation++; });
        current.watcher.on('error', lost);
        current.parent = watch(path.dirname(directory), { persistent: false }, (_event, name) => { if (!name || name.toString().toLowerCase() === path.basename(directory).toLowerCase()) lost(); });
        current.parent.on('error', lost);
      } catch { lost(); /* Unsupported monitors use full verification on every admission. */ }
      this.entries.set(directory, current);
    }
    const current = entry;
    // Drain notifications queued before this admission, including rename/write bursts.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (force && current.pending) await this.wait(current.pending, signal);
    if (force) current.verified = undefined;
    if (!current.pending && (!current.watcher || current.verified !== current.generation)) {
      const task = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const generation = current.generation;
          await check(); await new Promise<void>(resolve => setImmediate(resolve));
          if (!current.watcher || generation === current.generation) { current.verified = generation; return; }
        }
        throw new Error('运行文件持续发生变化，无法完成完整性检查。');
      })();
      current.pending = task;
      void task.finally(() => { if (current.pending === task) current.pending = undefined; }).catch(() => undefined);
    }
    if (!current.pending) return;
    return this.wait(current.pending, signal);
  }
  private async wait(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return pending;
    let abort!: () => void;
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  }
  forget(directory: string): void { const entry = this.entries.get(directory); entry?.watcher?.close(); entry?.parent?.close(); this.entries.delete(directory); }
  close(): void { for (const key of this.entries.keys()) this.forget(key); }
}
