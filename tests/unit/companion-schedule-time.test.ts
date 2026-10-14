import { describe, expect, it } from 'vitest';
import { companionScheduleClock, isCompanionScheduleTimeZone, nextCompanionScheduleRun, resolveCompanionScheduleTimeZone,
  type CompanionScheduleTiming } from '../../src/shared/companion-schedule-time';

const schedule: CompanionScheduleTiming = { runAt: '2026-01-31T09:30:00+08:00', timeZone: 'Asia/Shanghai', recurrence: 'monthly' };
describe('companion schedules preserve actual time and civil recurrence', () => {
  it('returns a future first occurrence and completes a one-time schedule at its boundary', () => {
    expect(nextCompanionScheduleRun({ ...schedule, recurrence: 'once' }, '2026-01-30T00:00:00Z')).toBe('2026-01-31T01:30:00.000Z');
    expect(nextCompanionScheduleRun({ ...schedule, recurrence: 'once' }, '2026-01-31T01:30:00Z')).toBeUndefined();
  });
  it('clamps month ends and restores the original day instead of drifting after February', () => {
    expect(nextCompanionScheduleRun(schedule, '2026-01-31T01:30:00Z')).toBe('2026-02-28T01:30:00.000Z');
    expect(nextCompanionScheduleRun(schedule, '2026-02-28T01:30:00Z')).toBe('2026-03-31T01:30:00.000Z');
    expect(nextCompanionScheduleRun({ ...schedule, runAt: '2024-01-31T09:30:00+08:00' }, '2024-01-31T01:30:00Z')).toBe('2024-02-29T01:30:00.000Z');
  });
  it('skips missed intervals and derives them from the original instant', () => {
    const interval = { ...schedule, recurrence: 'interval' as const, intervalMinutes: 15 };
    expect(nextCompanionScheduleRun(interval, '2026-01-31T01:30:00Z')).toBe('2026-01-31T01:45:00.000Z');
    expect(nextCompanionScheduleRun(interval, '2026-02-02T01:36:00Z')).toBe('2026-02-02T01:45:00.000Z');
  });
  it('keeps local daily time across a daylight-saving offset change', () => {
    const daily = { runAt: '2026-03-07T09:00:00-05:00', timeZone: 'America/New_York', recurrence: 'daily' as const };
    expect(nextCompanionScheduleRun(daily, '2026-03-07T14:00:00Z')).toBe('2026-03-08T13:00:00.000Z');
  });
  it('skips a nonexistent spring-forward time without running at a different local hour', () => {
    const gap = { runAt: '2026-03-07T02:30:00-05:00', timeZone: 'America/New_York', recurrence: 'daily' as const };
    expect(nextCompanionScheduleRun(gap, '2026-03-07T07:30:00Z')).toBe('2026-03-09T06:30:00.000Z');
  });
  it('runs an ambiguous fall-back time once, at the earlier instant', () => {
    const overlap = { runAt: '2026-10-31T01:30:00-04:00', timeZone: 'America/New_York', recurrence: 'daily' as const };
    expect(nextCompanionScheduleRun(overlap, '2026-10-31T05:30:00Z')).toBe('2026-11-01T05:30:00.000Z');
    expect(nextCompanionScheduleRun(overlap, '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z');
  });
  it('uses the anchored weekday by default and permits multiple requested weekdays', () => {
    const weekly = { runAt: '2026-05-04T09:00:00+08:00', timeZone: 'Asia/Shanghai', recurrence: 'weekly' as const };
    expect(nextCompanionScheduleRun(weekly, '2026-05-04T01:00:00Z')).toBe('2026-05-11T01:00:00.000Z');
    expect(nextCompanionScheduleRun({ ...weekly, weekDays: [1, 3, 5] }, '2026-05-04T01:00:00Z')).toBe('2026-05-06T01:00:00.000Z');
    expect(nextCompanionScheduleRun({ ...weekly, weekDays: [1, 3, 5] }, '2026-05-08T01:00:00Z')).toBe('2026-05-11T01:00:00.000Z');
  });
  it('skips a long offline period to the first future civil occurrence', () => {
    expect(nextCompanionScheduleRun(schedule, '2030-06-15T04:00:00Z')).toBe('2030-06-30T01:30:00.000Z');
  });
  it('rejects invalid times, zones, interval lengths or weekday sets', () => {
    expect(() => nextCompanionScheduleRun({ ...schedule, runAt: 'unknown' }, '2026-02-01T00:00:00Z')).toThrow();
    expect(() => nextCompanionScheduleRun({ ...schedule, timeZone: 'Not/A_Zone' }, '2026-02-01T00:00:00Z')).toThrow();
    expect(() => nextCompanionScheduleRun({ ...schedule, recurrence: 'interval', intervalMinutes: 0 }, '2026-02-01T00:00:00Z')).toThrow('间隔');
    expect(() => nextCompanionScheduleRun({ ...schedule, recurrence: 'weekly', weekDays: [1, 1] }, '2026-02-01T00:00:00Z')).toThrow('星期');
    expect(isCompanionScheduleTimeZone('Not/A_Zone')).toBe(false);
  });
  it('reads a real host clock in a chosen zone and resolves the system zone', () => {
    expect(companionScheduleClock(new Date('2026-10-14T12:34:56.789Z'), 'Asia/Shanghai')).toEqual({ now: '2026-10-14T12:34:56.789Z',
      timeZone: 'Asia/Shanghai', localTime: '2026-10-14T20:34:56', utcOffsetMinutes: 480, trust: 'host_clock_at_request_time' });
    expect(resolveCompanionScheduleTimeZone('system')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
