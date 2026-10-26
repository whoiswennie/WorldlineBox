/** Provider cancellation may return before a local resolver finishes. Keep
 * those filesystem operations owned until shutdown has actually drained them. */
export class CompanionAssetIo {
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  private closed?: Promise<void>;
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('伙伴资产读取正在关闭。'));
    const job = Promise.resolve().then(operation);
    this.pending.add(job);
    void job.finally(() => { this.pending.delete(job); }).catch(() => undefined);
    return job;
  }
  close(): Promise<void> {
    this.closing = true;
    return this.closed ??= (async () => { while (this.pending.size) await Promise.allSettled([...this.pending]); })();
  }
}
