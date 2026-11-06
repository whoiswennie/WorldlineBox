import type { BotTask } from './companion-bot';

type TaskClock = Pick<BotTask, 'status' | 'createdAt' | 'startedAt' | 'updatedAt' | 'elapsedMs' | 'timerStartedAt'
  | 'cancelRequested' | 'stopRequestedAt' | 'pauseRequested' | 'pauseRequestedAt' | 'pausedAt' | 'progress'>;
const stamp = (value?: string) => value ? Date.parse(value) : NaN;
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const stopped = (task: TaskClock) => task.cancelRequested || task.status === 'cancelled'
  || /^(?:stopping|stop-requesting|stop-unconfirmed|stop-request-unknown)$/u.test(task.progress?.phase ?? '');
const paused = (task: TaskClock) => task.pauseRequested || task.status === 'paused'
  || /^(?:pausing|pause-requesting|pause-unconfirmed|pause-request-unknown)$/u.test(task.progress?.phase ?? '');

export function botTaskClockRunning(task: TaskClock): boolean {
  return task.status === 'running' && !terminal.has(task.status) && !stopped(task) && !paused(task)
    && (Number.isFinite(task.elapsedMs) ? Number.isFinite(stamp(task.timerStartedAt)) : task.status === 'running');
}

/** One clock for the task directory and detail view, including old task records. */
export function botTaskElapsedMs(task: TaskClock, now = Date.now()): number {
  const cutoff = [stopped(task) ? stamp(task.stopRequestedAt ?? task.progress?.updatedAt ?? task.updatedAt) : NaN,
    paused(task) ? stamp(task.pauseRequestedAt ?? task.pausedAt ?? task.progress?.updatedAt ?? task.updatedAt) : NaN]
    .filter(Number.isFinite);
  if (Number.isFinite(task.elapsedMs) && task.elapsedMs! >= 0) {
    const start = stamp(task.timerStartedAt);
    const end = cutoff.length ? Math.min(...cutoff) : botTaskClockRunning(task) ? now : stamp(task.updatedAt);
    return task.elapsedMs! + (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0);
  }
  const start = stamp(task.startedAt ?? task.createdAt);
  const end = cutoff.length ? Math.min(...cutoff) : botTaskClockRunning(task) ? now : stamp(task.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : NaN;
}
