/** FIFO admission for native capability processes. Durable waiting work lives in SQLite. */
export class CompanionCapacity {
  private readonly active = new Map<string, number>();
  private readonly waiting: Array<{ role: string; signal: AbortSignal; resolve(release: () => void): void; reject(error: Error): void; cancel(): void }> = [];
  acquire(role: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('能力排队已取消。'));
    return new Promise((resolve, reject) => {
      const item = { role, signal, resolve, reject, cancel: () => {
        const index = this.waiting.indexOf(item);
        if (index >= 0) { this.waiting.splice(index, 1); reject(new Error('能力排队已取消。')); this.drain(); }
      } };
      this.waiting.push(item); signal.addEventListener('abort', item.cancel, { once: true }); this.drain();
    });
  }
  private drain() {
    for (let index = 0; index < this.waiting.length;) {
      if ([...this.active.values()].reduce((sum, count) => sum + count, 0) >= 20) return;
      const item = this.waiting[index]!;
      if ((this.active.get(item.role) ?? 0) >= 5) { index++; continue; }
      this.waiting.splice(index, 1); item.signal.removeEventListener('abort', item.cancel);
      this.active.set(item.role, (this.active.get(item.role) ?? 0) + 1);
      let released = false;
      item.resolve(() => { if (released) return; released = true; this.active.set(item.role, this.active.get(item.role)! - 1); this.drain(); });
    }
  }
}
