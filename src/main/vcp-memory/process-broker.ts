/** One process budget shared by every hot VCP client. A permit stays occupied
 * until the actual child has exited; active children are never LRU victims. */
export class VcpMemoryProcessBroker {
  private readonly entries = new Map<string, { identity: symbol; busy: number; used: number; retiring: boolean; stop(): Promise<void> }>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly limit = 4) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid VCP process budget.');
  }
  acquire(key: string, input: { assertCurrent(): void; deadline: number; open(identity: symbol): { stop(): Promise<void> } }): Promise<{ release(): void }> {
    // Opening a new scope can wait minutes for an occupied slot. Reusing an
    // existing scope consumes no additional process, so it must not join that
    // admission tail. The synchronous check/reservation also excludes LRU
    // retirement before its stop callback can run.
    try {
      if (this.closed) throw new Error('VCP process broker is closed.');
      input.assertCurrent();
      if (Date.now() >= input.deadline) throw new Error('VCP memory process pool remained busy.');
      const ready = this.entries.get(key);
      if (ready && !ready.retiring) return Promise.resolve(this.reserve(ready));
    } catch (error) { return Promise.reject(error); }
    const pending = this.tail.then(async () => {
      const current = () => { if (this.closed) throw new Error('VCP process broker is closed.'); input.assertCurrent();
        if (Date.now() >= input.deadline) throw new Error('VCP memory process pool remained busy.'); };
      current();
      let entry = this.entries.get(key);
      while (entry?.retiring) { current(); await new Promise(resolve => setTimeout(resolve, 20)); entry = this.entries.get(key); }
      if (!entry) {
        while (this.entries.size >= this.limit) {
          current();
          const idle = [...this.entries].filter(([, value]) => !value.busy && !value.retiring).sort((a,b) => a[1].used-b[1].used)[0];
          if (idle) {
            idle[1].retiring = true;
            let done = false, failure: unknown;
            void idle[1].stop().then(() => { done = true; }, error => { failure = error; done = true; });
            while (!done) { current(); await new Promise(resolve => setTimeout(resolve, 20)); }
            if (failure) throw failure;
            continue;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        current();
        const identity = Symbol(key);
        entry = { identity, busy: 0, used: Date.now(), retiring: false, stop: async () => undefined };
        this.entries.set(key, entry);
        try { entry.stop = input.open(identity).stop; }
        catch (error) { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; }
      }
      current();
      if (entry.retiring) throw new Error('VCP process is retiring.');
      return this.reserve(entry);
    });
    this.tail = pending.catch(() => undefined); return pending;
  }
  private reserve(entry: { busy: number; used: number }): { release(): void } {
    entry.busy++; entry.used = Date.now();
    let released = false;
    return { release: () => { if (released) return; released = true; entry.busy--; entry.used = Date.now(); } };
  }
  /** Synchronous exclusion precedes sending close/kill. */
  beginRetirement(key: string, identity: symbol): void {
    const entry = this.entries.get(key); if (entry?.identity === identity) entry.retiring = true;
  }
  /** Called only after exit/dependency detachment, never when kill is sent. */
  retired(key: string, identity: symbol): void { if (this.entries.get(key)?.identity === identity) this.entries.delete(key); }
  snapshot() { return { processes: this.entries.size, active: [...this.entries.values()].filter(value => value.busy > 0).length, limit: this.limit }; }
  async close(): Promise<void> { this.closed = true; await this.tail; }
}
