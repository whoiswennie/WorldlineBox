import { describe, expect, it } from 'vitest';
import { botTaskClockRunning, botTaskElapsedMs } from '../../src/shared/companion-bot-task-clock';

const start = '2026-11-05T10:00:00.000Z', pause = '2026-11-05T10:01:00.000Z';
const morning = Date.parse('2026-11-06T10:00:00.000Z');
describe('task execution clock', () => {
  it('freezes legacy stopped tasks at the original stop request, including later refreshes', () => {
    const task = { status: 'running', createdAt: start, updatedAt: new Date(morning).toISOString(), cancelRequested: true, stopRequestedAt: pause };
    expect(botTaskClockRunning(task)).toBe(false);
    expect(botTaskElapsedMs(task, morning)).toBe(60000);
    expect(botTaskElapsedMs({ ...task, status: 'cancelled' }, morning + 86400000)).toBe(60000);
  });
  it('freezes paused time and resumes only the new execution interval', () => {
    expect(botTaskElapsedMs({ status: 'paused', elapsedMs: 60000, pausedAt: pause }, morning)).toBe(60000);
    expect(botTaskElapsedMs({ status: 'running', elapsedMs: 60000, timerStartedAt: new Date(morning).toISOString() }, morning + 2000)).toBe(62000);
  });
  it('does not count initial queue time and keeps terminal totals stable', () => {
    expect(botTaskElapsedMs({ status: 'queued', createdAt: start, elapsedMs: 0 }, morning)).toBe(0);
    expect(botTaskClockRunning({ status: 'queued', elapsedMs: 0 })).toBe(false);
    expect(botTaskElapsedMs({ status: 'succeeded', elapsedMs: 2000, updatedAt: pause }, morning)).toBe(2000);
  });
  it('handles original pause intent before acknowledgement and clamps future times', () => {
    expect(botTaskElapsedMs({ status: 'running', createdAt: start, pauseRequested: true, pauseRequestedAt: pause }, morning)).toBe(60000);
    expect(botTaskElapsedMs({ status: 'running', elapsedMs: 0, timerStartedAt: new Date(morning + 1000).toISOString() }, morning)).toBe(0);
    expect(botTaskElapsedMs({ status: 'paused' }, morning)).toBeNaN();
  });
  it('recognizes old phase-only stop records and never animates unknown execution', () => {
    const task = { status: 'waiting', createdAt: start, updatedAt: new Date(morning).toISOString(),
      progress: { phase: 'stop-unconfirmed', updatedAt: pause } };
    expect(botTaskClockRunning(task)).toBe(false);
    expect(botTaskElapsedMs(task, morning)).toBe(60000);
    expect(botTaskClockRunning({ status: 'unknown', createdAt: start })).toBe(false);
  });
});
