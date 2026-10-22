import type { CompanionGoalResult } from '../../shared/companion-goal-result';
import type { CompanionSchedule, CompanionScheduleOccurrence } from '../../shared/companion-schedule';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionActivityTask } from '../../shared/companion-activity-task';

interface CompanionScheduleServiceOptions {
  activity?: { start(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence): Promise<CompanionActivityTask>;
    get(task: CompanionActivityTask): Promise<CompanionActivityTask>; cancel(task: CompanionActivityTask): Promise<unknown> };
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  runGoal(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence, signal: AbortSignal): Promise<CompanionGoalResult>;
  ready(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence, signal: AbortSignal): Promise<void>;
  end(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence): Promise<void>;
  changed(): void;
  wakeWaiting(): void;
  report(error: unknown): void;
  blocked?(companionId: string): boolean;
}

/** Dispatches durable occurrences even when no chat page is open. SQLite owns
 * claims, recurrence, energy gates and idempotent effect identities. */
export class CompanionScheduleService {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly jobControllers = new Map<string, AbortController>();
  private readonly jobOwners = new Map<string, string>();
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
      if (this.options.blocked?.(schedule.companionId)) continue;
      if (this.jobs.has(occurrence.id)) continue;
      const controller = new AbortController(); this.jobControllers.set(occurrence.id, controller); this.jobOwners.set(occurrence.id, schedule.companionId);
      const job = this.dispatch(schedule, occurrence, AbortSignal.any([controller.signal, this.controller.signal])).catch(this.options.report)
        .finally(() => { this.jobs.delete(occurrence.id); this.jobControllers.delete(occurrence.id); this.jobOwners.delete(occurrence.id); this.options.changed(); });
      this.jobs.set(occurrence.id, job);
    }
    if (!this.closed) this.options.wakeWaiting();
  }

  cancel(occurrences: readonly CompanionScheduleOccurrence[]): void {
    for (const occurrence of occurrences) if (occurrence.status === 'cancelled') this.jobControllers.get(occurrence.id)?.abort();
  }

  cancelCompanion(companionId: string): void {
    for (const [id, owner] of this.jobOwners) if (owner === companionId) this.jobControllers.get(id)?.abort();
  }
  async drainCompanion(companionId: string): Promise<void> {
    await this.running;
    this.cancelCompanion(companionId);
    await Promise.allSettled([...this.jobs.entries()].filter(([id]) => this.jobOwners.get(id) === companionId).map(([, promise]) => promise));
  }

  private async dispatch(schedule: CompanionSchedule, occurrence: CompanionScheduleOccurrence, signal: AbortSignal): Promise<void> {
    const leaseLost = new AbortController(); signal = AbortSignal.any([signal, leaseLost.signal]);
    let finished = false, refreshing = false;
    const heartbeat = setInterval(() => {
      if (finished || refreshing || signal.aborted || !occurrence.leaseToken) return;
      refreshing = true;
      void this.options.request({ type: 'schedule.occurrence.heartbeat', id: occurrence.id, leaseToken: occurrence.leaseToken, leaseMs: 30000 })
        .catch(error => { if (!finished) { leaseLost.abort(); this.options.report(error); } }).finally(() => { refreshing = false; });
    }, 10000); heartbeat.unref();
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
      if (schedule.kind === 'activity') {
        const runner = this.options.activity;
        if (!runner) throw new Error('持续行动任务服务不可用。');
        let task = await runner.start(schedule, occurrence);
        await update({ status: 'running', activityTaskId: task.id });
        while (['queued','running','waiting'].includes(task.status) && !this.closed && !signal.aborted) {
          await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, 1000); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done(); });
          if (!signal.aborted && !this.closed) task = await runner.get(task);
        }
        if (signal.aborted && !this.closed) { await runner.cancel(task); return; }
        if (this.closed) return;
        await update({ status: task.status === 'succeeded' ? 'done' : task.status === 'cancelled' ? 'cancelled' : 'failed', activityTaskId: task.id,
          result: task.stage, ...(task.status === 'failed' ? { error: task.stage.slice(0, 1000) } : {}) }); return;
      }
      await update({ status: 'running' });
      const goal = await this.options.runGoal(schedule, occurrence, signal);
      if (this.closed || signal.aborted) return;
      if (goal.status === 'interrupted') return;
      await update({ status: goal.status === 'succeeded' ? 'done' : goal.status === 'cancelled' ? 'cancelled' : 'failed',
        result: goal.result.slice(0, 4000), goalResult: goal.result,
        goalInvocationId: goal.invocationId, goalSlot: goal.goalSlot, actionIds: goal.actionIds,
        ...(goal.status === 'failed' ? { error: goal.result.slice(0, 1000) } : {}) });
    } catch (error) {
      if (this.closed || signal.aborted) return;
      await update({ status: 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : '定时安排执行失败。' });
    } finally {
      finished = true; clearInterval(heartbeat);
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
