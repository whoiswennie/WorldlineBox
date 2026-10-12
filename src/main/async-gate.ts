/**
 * Bounded async admission for Main-process filesystem work.
 *
 * Chromium can issue many overlapping `worldlinebox://` range requests for one
 * visible card. Each `fs.promises.open`/`stat` occupies a libuv threadpool
 * slot (default 4). On a network volume those slots fill with SMB round
 * trips and the Electron main thread stops dispatching window input — the
 * browse surface looks frozen even though the renderer is still painting.
 *
 * Waiters stay in JavaScript, not in the threadpool, so pointer routing
 * continues while earlier opens complete.
 */
export class AsyncGate {
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('AsyncGate limit must be a positive integer.');
    }
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#waiters.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.#active -= 1;
    const next = this.#waiters.shift();
    if (next) next();
  }
}
