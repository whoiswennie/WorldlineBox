import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { lstat } from './disk';

interface Entry { generation: number; epoch: number; verified?: number; watcher?: FSWatcher; parent?: FSWatcher; pending?: Promise<void>; monitoring?: Promise<void> }

/** Reuse a complete verification only while a live recursive change monitor remains intact. */
export class RuntimeIntegrity {
  private readonly entries = new Map<string, Entry>();
  async verify(directory: string, check: () => Promise<void>, signal?: AbortSignal, force = false): Promise<void> {
    signal?.throwIfAborted();
    let entry = this.entries.get(directory);
    if (!entry) {
      entry = { generation: 0, epoch: 0 };
      this.entries.set(directory, entry);
    }
    const current = entry;
    await this.wait(this.monitor(directory, current), signal);
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
  private monitor(directory: string, current: Entry): Promise<void> {
    if (current.monitoring) return current.monitoring;
    if (current.watcher && current.parent) return Promise.resolve();
    const task = (async () => {
      const before = await lstat(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('运行版本目录必须是普通目录，不能是链接。');
      if (this.entries.get(directory) !== current) return;
      this.invalidate(current);
      const epoch = current.epoch;
      const active = () => this.entries.get(directory) === current && current.epoch === epoch;
      const changed = () => { if (active()) current.generation++; };
      const lost = () => { if (active()) this.invalidate(current); };
      try {
        // Observe replacement before attaching to the current directory. A plain
        // metadata change only dirties the proof; it does not destroy the monitor.
        current.parent = watch(path.dirname(directory), { persistent: false }, (event, name) => {
          if (name && name.toString().toLowerCase() !== path.basename(directory).toLowerCase()) return;
          if (event === 'rename') lost(); else changed();
        });
        current.parent.on('error', lost);
        current.watcher = watch(directory, { recursive: true, persistent: false }, changed);
        current.watcher.on('error', lost);
      } catch {
        lost();
        // Unsupported monitors still perform a complete check on every admission.
        return;
      }
      try {
        const after = await lstat(directory);
        if (!after.isDirectory() || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev) {
          throw new Error('运行版本目录在恢复监控时发生变化，请重新检查。');
        }
      } catch (error) { lost(); throw error; }
    })();
    current.monitoring = task;
    void task.finally(() => { if (current.monitoring === task) current.monitoring = undefined; }).catch(() => undefined);
    return task;
  }
  private invalidate(current: Entry): void {
    current.generation++; current.epoch++; current.verified = undefined;
    const watcher = current.watcher, parent = current.parent;
    current.watcher = undefined; current.parent = undefined;
    watcher?.close(); parent?.close();
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
  forget(directory: string): void { const entry = this.entries.get(directory); this.entries.delete(directory); if (entry) this.invalidate(entry); }
  close(): void { for (const key of this.entries.keys()) this.forget(key); }
}
