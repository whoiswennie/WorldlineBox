import type { DshOperation } from '../../shared/dsh-launcher';

export interface DownloadControl {
  begin(totalBytes?: number, transport?: { pause(): void; resume(): void }): Promise<void>;
  wait(): Promise<void>;
  report(segmentBytes: number): void;
  end(): Promise<void>;
}

/** One controller per operation: counters and pause gates can never cross tasks. */
export class OperationDownloadControl implements DownloadControl {
  private transport?: { pause(): void; resume(): void };
  private readonly waiters = new Set<() => void>();
  private base = 0;
  private received = 0;
  private sampleBytes = 0;
  private sampleTime = Date.now();
  private lastPublish = 0;
  private ticker?: ReturnType<typeof setInterval>;
  constructor(private readonly record: DshOperation, private readonly signal: AbortSignal,
    private readonly publish: () => Promise<void>) {
    signal.addEventListener('abort', () => { clearInterval(this.ticker); for (const resolve of this.waiters) resolve(); this.waiters.clear(); }, { once: true });
  }
  async begin(totalBytes?: number, transport?: { pause(): void; resume(): void }): Promise<void> {
    this.signal.throwIfAborted();
    this.base = this.record.download?.transferredBytes ?? 0;
    this.received = this.base; this.sampleBytes = this.base; this.sampleTime = Date.now(); this.transport = transport;
    this.record.download = { transferredBytes: this.base, speedBytesPerSecond: 0, paused: false, canPause: true,
      ...(totalBytes && Number.isSafeInteger(totalBytes) ? { totalBytes: this.base + totalBytes } : {}) };
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.report(this.received - this.base), 1000);
    this.ticker.unref?.();
    await this.publish();
  }
  async wait(): Promise<void> {
    this.signal.throwIfAborted();
    if (this.record.download?.paused) await new Promise<void>(resolve => this.waiters.add(resolve));
    this.signal.throwIfAborted();
  }
  report(segmentBytes: number): void {
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 0 || this.signal.aborted) return;
    this.received = Math.max(this.received, this.base + segmentBytes);
    const stats = this.record.download; if (!stats || stats.paused || !stats.canPause) return;
    const now = Date.now(); stats.transferredBytes = this.received;
    if (now - this.sampleTime >= 250) {
      stats.speedBytesPerSecond = Math.max(0, Math.round((this.received - this.sampleBytes) * 1000 / (now - this.sampleTime)));
      this.sampleBytes = this.received; this.sampleTime = now;
    }
    if (now - this.lastPublish >= 250) { this.lastPublish = now; void this.publish().catch(() => undefined); }
  }
  async pause(): Promise<void> {
    const stats = this.record.download;
    if (!stats?.canPause || this.signal.aborted) throw new Error('This task is not currently downloading.');
    if (stats.paused) return;
    this.transport?.pause(); stats.paused = true; stats.speedBytesPerSecond = 0; await this.publish();
  }
  async resume(): Promise<void> {
    const stats = this.record.download;
    if (!stats?.canPause || this.signal.aborted) throw new Error('This task is no longer downloading.');
    stats.paused = false; stats.transferredBytes = this.received;
    this.sampleBytes = this.received; this.sampleTime = Date.now(); this.transport?.resume();
    for (const resolve of this.waiters) resolve(); this.waiters.clear(); await this.publish();
  }
  async end(): Promise<void> {
    clearInterval(this.ticker); this.ticker = undefined;
    if (this.record.download) { this.record.download.canPause = false; this.record.download.paused = false; this.record.download.speedBytesPerSecond = 0; }
    this.transport = undefined;
    for (const resolve of this.waiters) resolve(); this.waiters.clear(); await this.publish();
  }
}
