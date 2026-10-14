import type { CompanionAction } from '../../shared/companions';
import type { CompanionSchedule, CompanionScheduleOccurrence } from '../../shared/companion-schedule';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

interface CompanionScheduleServiceOptions {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  launch(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence): Promise<CompanionAction>;
  resume(actionId: string): Promise<unknown>;
  wait(actionId: string): Promise<unknown> | undefined;
  ready(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence, signal: AbortSignal): Promise<void>;
  end(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence): Promise<void>;
  changed(): void;
  wakeWaiting(): void;
  report(error: unknown): void;
}

/** Dispatches durable occurrences even when no chat page is open. SQLite owns
 * claims, recurrence, energy gates and idempotent effect identities. */
export class CompanionScheduleService {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly jobControllers = new Map<string, AbortController>();
  private lastStateTick = -Infinity;
  private closed = false;
  private readonly controller = new AbortController();

  constructor(private readonly options: CompanionScheduleServiceOptions) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.wake(), 1_000);
    this.timer.unref();
    this.wake();
  }
  wake(): void {
    if (this.closed || this.running) return;
    this.running = this.tick().catch(this.options.report).finally(() => { this.running = undefined; });
  }
  async tick(now = new Date()): Promise<void> {
    if (this.closed) return;
    if (now.getTime() - this.lastStateTick >= 30_000) {
      await this.options.request({ type: 'state.tick', at: now.toISOString() });
      this.lastStateTick = now.getTime(); this.options.changed();
    }
    for (let count = 0; count < 20 && !this.closed; count++) {
      const claimed = await this.options.request({ type: 'schedule.due.claim', now: now.toISOString(), leaseMs: 30_000 });
      const { schedule, scheduleOccurrence: occurrence } = claimed;
      if (!schedule || !occurrence) break;
      if (this.jobs.has(occurrence.id)) continue;
      const controller = new AbortController(); this.jobControllers.set(occurrence.id, controller);
      const job = this.dispatch(schedule, occurrence, AbortSignal.any([controller.signal, this.controller.signal])).catch(this.options.report)
        .finally(() => { this.jobs.delete(occurrence.id); this.jobControllers.delete(occurrence.id); this.options.changed(); });
      this.jobs.set(occurrence.id, job);
    }
    if (!this.closed) this.options.wakeWaiting();
  }

  cancel(occurrences: readonly CompanionScheduleOccurrence[]): void {
    for (const occurrence of occurrences) if (occurrence.status === 'cancelled') this.jobControllers.get(occurrence.id)?.abort();
  }

  private async dispatch(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence, signal: AbortSignal): Promise<void> {
    const update = (patch: Omit<Extract<CompanionStorageCommand, { type: 'schedule.occurrence.update' }>, 'type' | 'id' | 'leaseToken'>) =>
      this.options.request({ type: 'schedule.occurrence.update', id: occurrence.id, leaseToken: occurrence.leaseToken, ...patch });
    try {
      if (schedule.kind === 'reminder') {
        await this.options.ready(schedule, occurrence, signal);
        const current = await this.options.request({ type: 'schedule.list', companionId: schedule.companionId, conversationId: schedule.conversationId, includeHistory: true, limit: 200 });
        if (!current.scheduleOccurrences?.some(item => item.id === occurrence.id && item.status === 'dispatching')) return;
        const state = (await this.options.request({ type: 'state.get', companionId: schedule.companionId, conversationId: schedule.conversationId })).runtimeState;
        if (this.closed || signal.aborted) return;
        const introduction = state?.expression === 'playful' ? '叮，约好的时间到啦。'
          : state?.expression === 'direct' ? '到时间了。' : state?.expression === 'reserved' ? '约定的提醒。' : '到约好的时间了，提醒你一下。';
        const response = await this.options.request({ type: 'message.append', message: { conversationId: schedule.conversationId,
          authorId: schedule.companionId, content: `${introduction}\n\n${schedule.title}\n${schedule.prompt}`,
          clientId: `schedule-${occurrence.id}`, replyToId: schedule.sourceMessageId } });
        await update({ status: 'done', messageId: response.message?.id, result: '已发送约定的提醒。' });
        this.options.changed(); return;
      }
      // A crash after effect creation reuses the occurrence's action. Never start
      // a second external task merely because its acknowledgement was lost.
      let action = occurrence.actionId ? (await this.options.request({ type: 'action.get', id: occurrence.actionId })).action : undefined;
      if (this.closed) return;
      if (!action) action = await this.options.launch(schedule, occurrence);
      await update({ status: 'running', actionId: action.id });
      if (action.status === 'interrupted') await this.options.resume(action.id);
      await this.options.wait(action.id);
      if (this.closed) return;
      const final = (await this.options.request({ type: 'action.get', id: action.id })).action;
      if (!final || ['queued', 'running', 'interrupted'].includes(final.status)) return;
      await update({ status: final.status === 'succeeded' ? 'done' : final.status === 'cancelled' ? 'cancelled' : 'failed',
        actionId: final.id, result: final.result?.slice(0, 4000), error: final.error?.slice(0, 1000) });
    } catch (error) {
      if (this.closed || signal.aborted) return;
      await update({ status: 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : '定时安排执行失败。' });
    } finally {
      if (schedule.kind === 'reminder') await this.options.end(schedule, occurrence);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    await this.running;
    // External jobs are interrupted and awaited by the action owner. Waiting
    // here before that interruption would deadlock application shutdown.
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.jobs.values()]); }
}
