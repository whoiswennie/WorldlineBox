import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryOwnerSchedule, memoryProcessingJobSchedule, memorySchedule } from '../../src/main/companions/memory-processing-schedule';
import { companionMemoryProcessingJobSchema, type CompanionMemoryProcessingJob } from '../../src/shared/companion-memory-processing';

afterEach(() => vi.useRealTimers());
const queued = (): CompanionMemoryProcessingJob => ({ id: 'job_alpha', kind: 'capture', status: 'pending', stage: '来源已排队', title: '整理来源', attempts: 0 });

describe('memory scheduler projections', () => {
  it('distinguishes an actual check timer from a retry eligibility floor and a completion estimate', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T04:00:00Z');
    const check = '2026-10-22T04:00:02.000Z', retry = '2026-10-22T04:00:30.000Z';
    const job = { ...queued(), status: 'failed' as const, attempts: 1, nextAttemptAt: retry,
      schedule: memorySchedule('capture', { scheduleKind: 'retry', waitingReason: 'retry_backoff', nextAttemptAt: retry }) };
    const projected = memoryProcessingJobSchedule(job, memorySchedule('capture', { scheduleKind: 'timer', nextCheckAt: check }));
    expect(projected.schedule).toMatchObject({ scheduleKind: 'retry', nextCheckAt: check, nextAttemptAt: retry });
    expect(projected.schedule?.condition).toContain('仍需等待'); expect(projected.schedule?.explanation).toContain('不保证');
    companionMemoryProcessingJobSchema.parse(projected);
  });

  it('never treats a host handling earlier work as evidence that the queued job started', () => {
    const projected = memoryProcessingJobSchedule(queued(), memorySchedule('capture', { scheduleKind: 'running', waitingReason: undefined }));
    expect(projected.status).toBe('pending'); expect(projected.schedule).toMatchObject({ scheduleKind: 'condition', waitingReason: 'worker_busy' });
    expect(projected.schedule?.nextCheckAt).toBeUndefined();
  });

  it('explains an actual leased operation waiting on shared device detection without pretending native inference started', () => {
    const host = memorySchedule('index', { scheduleKind: 'condition', waitingReason: 'device_testing', condition: '实际模型自检正在进行。' });
    const projected = memoryProcessingJobSchedule({ ...queued(), kind: 'index', status: 'running' }, host);
    expect(projected.status).toBe('running');
    expect(projected.schedule).toMatchObject({ scheduleKind: 'condition', waitingReason: 'device_testing' });
    expect(projected.schedule?.condition).toContain('任务已领取'); expect(projected.schedule?.nextCheckAt).toBeUndefined();
  });

  it('keeps manual exhaustion and paused ownership stronger than the host poll timer', () => {
    const host = memorySchedule('capture', { scheduleKind: 'timer', nextCheckAt: new Date(Date.now() + 30000).toISOString() });
    for (const waitingReason of ['retry_limit', 'companion_inactive', 'reset_in_progress']) {
      const schedule = memorySchedule('capture', { scheduleKind: waitingReason === 'retry_limit' ? 'manual' : 'condition', waitingReason, condition: '真实存储队列条件' });
      const projected = memoryProcessingJobSchedule({ ...queued(), schedule }, host);
      expect(projected.schedule?.waitingReason).toBe(waitingReason); expect(projected.schedule?.condition).toBe('真实存储队列条件');
      expect(projected.schedule?.nextCheckAt).toBeUndefined();
    }
  });

  it('does not continue displaying an expired timer as a future execution time', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T04:00:03Z');
    const host = memorySchedule('capture', { scheduleKind: 'condition', waitingReason: 'foreground_busy', nextCheckAt: '2026-10-22T04:00:02.000Z' });
    expect(memoryProcessingJobSchedule(queued(), host).schedule?.nextCheckAt).toBeUndefined();
    expect(memoryOwnerSchedule([{ kind: 'capture', ...host }]).nextCheckAt).toBeUndefined();
  });

  it('removes automatic timing from terminal work and does not reveal another owner identity', () => {
    const host = memorySchedule('timeline', { scheduleKind: 'condition', waitingReason: 'worker_busy', condition: '正在整理其他伙伴，等待资源。' });
    const completed = memoryProcessingJobSchedule({ ...queued(), kind: 'timeline', status: 'completed', nextAttemptAt: new Date(Date.now() + 5000).toISOString() }, host);
    expect(completed.schedule).toMatchObject({ scheduleKind: 'finished' }); expect(completed.nextAttemptAt).toBeUndefined();
    expect(completed.schedule?.nextCheckAt).toBeUndefined(); expect(completed.schedule?.nextAttemptAt).toBeUndefined();
  });
  it('never turns a parked job into automatic work when its owner has a live timer', () => {
    const future = new Date(Date.now() + 5000).toISOString();
    const parked = memoryProcessingJobSchedule({ ...queued(), status: 'parked', nextAttemptAt: future }, memorySchedule('capture', { scheduleKind: 'timer', nextCheckAt: future }));
    expect(parked).toMatchObject({ status: 'parked', schedule: { scheduleKind: 'manual', waitingReason: 'parked' } });
    expect(parked.nextAttemptAt).toBeUndefined(); expect(parked.schedule?.nextCheckAt).toBeUndefined();
    expect(parked.schedule?.condition).toContain('其他独立作业继续');
  });
  it('shows an explicitly abandoned job as stopped and preserves the distinction from successful processing', () => {
    const abandoned = memoryProcessingJobSchedule({ ...queued(), status: 'abandoned' }, memorySchedule('capture', { scheduleKind: 'running' }));
    expect(abandoned).toMatchObject({ status: 'abandoned', schedule: { scheduleKind: 'finished' } });
    expect(abandoned.schedule?.condition).toContain('原始事件和处理历史保留'); expect(abandoned.schedule?.condition).not.toContain('已完成');
  });
});
