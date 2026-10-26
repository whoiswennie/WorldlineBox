export type CompanionMemoryQueryPriority = 'foreground' | 'background';
export interface CompanionMemoryQueryTaskInfo {
  priority: CompanionMemoryQueryPriority;
  queuedMs: number;
}
interface QueryTask {
  priority: CompanionMemoryQueryPriority;
  queuedAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  invoke(info: CompanionMemoryQueryTaskInfo): Promise<void>;
  reject(reason: unknown): void;
  done: Promise<void>;
  complete(): void;
}
interface OwnerQueue {
  owner: string;
  foreground: QueryTask[];
  background: QueryTask[];
  registered: Set<QueryTask>;
  running?: QueryTask;
  scheduled: boolean;
  foregroundBurst: number;
}

/** One physical memory graph has one writer/query lane. Foreground work passes
 * queued background work, with a bounded burst so maintenance still progresses.
 * An executing task retains the lane until it really settles, even if aborted.
 * Independent graphs may use separate lanes; owner withdrawal drains all of
 * those lanes before retiring any of its projections. */
export class CompanionMemoryQueryScheduler {
  private readonly owners = new Map<string, OwnerQueue>();
  private readonly maxForegroundBurst: number;
  private readonly now: () => number;

  constructor(options: { maxForegroundBurst?: number; now?: () => number } = {}) {
    this.maxForegroundBurst = options.maxForegroundBurst ?? 8;
    if (!Number.isSafeInteger(this.maxForegroundBurst) || this.maxForegroundBurst < 1)
      throw new RangeError('The foreground memory query burst must be a positive integer.');
    this.now = options.now ?? (() => performance.now());
  }

  run<T>(owner: string, task: (info: CompanionMemoryQueryTaskInfo) => T | Promise<T>,
    options: { priority: CompanionMemoryQueryPriority; signal?: AbortSignal; lane?: string }): Promise<T> {
    if (!owner.trim()) return Promise.reject(new Error('A memory query owner is required.'));
    if (options.priority !== 'foreground' && options.priority !== 'background')
      return Promise.reject(new Error('Invalid memory query priority.'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);

    const lane = JSON.stringify([owner, options.lane ?? '']);
    let state = this.owners.get(lane);
    if (!state) {
      state = { owner, foreground: [], background: [], registered: new Set(), scheduled: false, foregroundBurst: 0 };
      this.owners.set(lane, state);
    }
    const queue = state;
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
    const result = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    let complete!: () => void;
    const done = new Promise<void>(accept => { complete = accept; });
    const entry: QueryTask = {
      priority: options.priority, queuedAt: this.now(), signal: options.signal, done, complete, reject,
      invoke: async info => { try { resolve(await task(info)); } catch (error) { reject(error); } },
    };
    queue[entry.priority].push(entry);
    queue.registered.add(entry);
    if (entry.signal) {
      entry.onAbort = () => {
        const pending = queue[entry.priority], index = pending.indexOf(entry);
        if (index < 0) return;
        pending.splice(index, 1);
        entry.signal?.removeEventListener('abort', entry.onAbort!);
        queue.registered.delete(entry);
        entry.reject(entry.signal?.reason);
        entry.complete();
        this.schedule(lane, queue);
      };
      entry.signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    this.schedule(lane, queue);
    return result;
  }

  /** Wait for work already registered at this call; later arrivals cannot extend
   * an invalidation's drain indefinitely. Rejected/cancelled work also settles. */
  async drain(owner: string): Promise<void> {
    await Promise.all([...this.owners.values()].filter(queue => queue.owner === owner)
      .flatMap(queue => [...queue.registered].map(entry => entry.done)));
  }

  async drainAll(): Promise<void> {
    await Promise.all([...this.owners.values()].flatMap(queue => [...queue.registered].map(entry => entry.done)));
  }

  snapshot(owner: string): { foreground: number; background: number; running?: CompanionMemoryQueryPriority } {
    const queues = [...this.owners.values()].filter(queue => queue.owner === owner);
    const running = queues.some(queue => queue.running?.priority === 'foreground') ? 'foreground'
      : queues.some(queue => queue.running) ? 'background' : undefined;
    return { foreground: queues.reduce((sum, queue) => sum + queue.foreground.length, 0),
      background: queues.reduce((sum, queue) => sum + queue.background.length, 0), ...(running ? { running } : {}) };
  }

  private schedule(owner: string, queue: OwnerQueue): void {
    if (queue.running || queue.scheduled) return;
    if (!queue.registered.size) { if (this.owners.get(owner) === queue) this.owners.delete(owner); return; }
    queue.scheduled = true;
    queueMicrotask(() => {
      queue.scheduled = false;
      if (this.owners.get(owner) !== queue || queue.running) return;
      const backgroundTurn = queue.background.length > 0
        && (!queue.foreground.length || queue.foregroundBurst >= this.maxForegroundBurst);
      const entry = (backgroundTurn ? queue.background : queue.foreground).shift();
      if (!entry) { this.schedule(owner, queue); return; }
      queue.running = entry;
      queue.foregroundBurst = backgroundTurn ? 0 : Math.min(this.maxForegroundBurst, queue.foregroundBurst + 1);
      if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
      void entry.invoke({ priority: entry.priority, queuedMs: Math.max(0, this.now() - entry.queuedAt) }).then(() => {
        queue.running = undefined;
        queue.registered.delete(entry);
        entry.complete();
        this.schedule(owner, queue);
      });
    });
  }
}
