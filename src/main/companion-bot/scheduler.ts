import { randomUUID } from 'node:crypto';
import type { BotStore } from './store';
import type { BotClaim } from './types';
import { isInteractiveBotSource } from './activity-budget';

export interface BotSchedulerOptions {
  handle(claim: BotClaim, signal: AbortSignal): Promise<void>;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  turnTimeoutMs?: number;
  onChange?(): void;
  onError?(error: Error): void;
}
type Active = { claim: BotClaim; controller: AbortController; promise: Promise<void>; heartbeat?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout> };

/** Fair per-lane execution: no lock is held while a model, memory query or task is awaited. */
export class BotScheduler {
  private readonly workerId = randomUUID();
  private readonly active = new Map<string, Active>();
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private poll?: ReturnType<typeof setInterval>;
  private scheduled = false;
  private started = false;
  private closed = false;
  constructor(private readonly store: BotStore, private readonly options: BotSchedulerOptions) {
    this.concurrency = Math.min(8, Math.max(1, options.concurrency ?? 3));
    this.leaseMs = Math.min(300000, Math.max(3000, options.leaseMs ?? 60000));
  }
  get runningCount(): number { return this.active.size; }
  start(): void {
    if (this.closed) throw new Error('伙伴调度器已关闭。');
    if (this.started) return;
    this.started = true;
    this.poll = setInterval(() => this.wake(), Math.max(100, this.options.pollMs ?? 1000));
    this.poll.unref?.(); this.wake();
  }
  wake(): void {
    if (!this.started || this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed) return;
      try { this.pump(); } catch (error) { this.report(error); }
    });
  }
  private pump(): void {
    while (!this.closed && this.active.size < this.concurrency) {
      const automatic = [...this.active.values()].filter(value => !isInteractiveBotSource(value.claim.event.source)).length;
      const reserved = this.concurrency > 1 && automatic >= this.concurrency - 1;
      const claim = this.store.claim({ workerId: this.workerId, leaseMs: this.leaseMs,
        excludeLaneIds: [...this.active.values()].map(active => active.claim.event.laneId), preferInteractive: true, interactiveOnly: reserved });
      if (!claim) break;
      const controller = new AbortController();
      const active: Active = { claim, controller, promise: Promise.resolve() };
      this.active.set(claim.event.id, active);
      active.deadline = setTimeout(() => {
        if (this.closed || !this.active.has(claim.event.id)) return;
        const error = Object.assign(new Error('本轮主脑处理达到时间预算，已停止并保留已提交的任务状态。'), { code: 'BOT_ACTIVITY_TIMEOUT' });
        try { this.store.cancelEvent(claim.event.id); } catch (failure) { this.report(failure); }
        controller.abort(error); this.report(error); this.changed();
      }, Math.max(1, this.options.turnTimeoutMs ?? 120000));
      active.deadline.unref?.();
      active.heartbeat = setInterval(() => {
        if (this.closed) return;
        try {
          if (!this.store.heartbeat(claim.event.id, claim.leaseToken, this.leaseMs)) controller.abort(new Error('主脑事件租约已失效。'));
        } catch (error) { controller.abort(error); this.report(error); }
      }, Math.floor(this.leaseMs / 3));
      active.heartbeat.unref?.();
      active.promise = Promise.resolve().then(() => this.options.handle(claim, controller.signal)).then(() => {
        if (this.closed) return;
        const event = this.store.getEvent(claim.event.id);
        if (event?.status === 'running') this.store.settle({ eventId: event.id, leaseToken: claim.leaseToken,
          status: 'failed', error: '主脑处理结束但未提交回复结果。' });
      }).catch(error => {
        if (!this.closed) {
          try { this.store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'failed',
            error: error instanceof Error ? error.message : String(error) }); } catch (storeError) { this.report(storeError); }
          if (!controller.signal.aborted) this.report(error);
        }
      }).finally(() => {
        if (active.heartbeat) clearInterval(active.heartbeat);
        if (active.deadline) clearTimeout(active.deadline);
        this.active.delete(claim.event.id);
        if (!this.closed) { this.changed(); this.wake(); }
      });
      this.changed();
    }
  }
  /** Accepts the Inbox event ID, never an ambiguous UI message ID. */
  cancel(eventId: string): boolean {
    if (this.closed) return false;
    const changed = this.store.cancelEvent(eventId);
    this.active.get(eventId)?.controller.abort(new Error('用户停止了本轮回复。'));
    if (changed) { this.changed(); this.wake(); }
    return changed;
  }
  private changed(): void { try { this.options.onChange?.(); } catch (error) { this.report(error); } }
  private report(error: unknown): void {
    try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }
    catch { /* Logging hooks cannot stop recovery or leak an unhandled rejection. */ }
  }
  /** Fence and requeue before aborting; a late model result cannot publish after shutdown. */
  async close(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    this.closed = true; if (this.poll) clearInterval(this.poll);
    for (const active of this.active.values()) {
      if (active.heartbeat) clearInterval(active.heartbeat);
      if (active.deadline) clearTimeout(active.deadline);
      this.store.requeue(active.claim.event.id, active.claim.leaseToken);
      active.controller.abort(Object.assign(new Error('伙伴运行时正在关闭，事件已保留待恢复。'), { code: 'BOT_SUSPEND' }));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.active.values()].map(active => active.promise)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); })]);
    if (timer) clearTimeout(timer);
  }
}
