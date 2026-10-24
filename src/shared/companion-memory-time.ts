import { companionCivilInstantInZone } from './companion-schedule-time';

/** Civil ranges follow the query calendar, including 23/25-hour DST days.
 * An explicit timestamp retains its absolute instant and offset semantics. */
export function companionMemoryDateBoundary(value: string | undefined, end: boolean, timeZone: string): number | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const result = Date.parse(value);
    if (!Number.isFinite(result)) throw new Error('记忆查询的日期范围无效。');
    return result;
  }
  const day = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) throw new Error('记忆查询的日期范围无效。');
  const civil = (date: Date) => ({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, second: 0, millisecond: 0 });
  const start = companionCivilInstantInZone(civil(day), timeZone, 'next_valid');
  if (start === undefined || new Intl.DateTimeFormat('sv', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start) !== value)
    throw new Error('记忆查询的日期范围无效。');
  if (!end) return start;
  day.setUTCDate(day.getUTCDate() + 1);
  const next = companionCivilInstantInZone(civil(day), timeZone, 'next_valid');
  if (next === undefined || next <= start) throw new Error('记忆查询的日期范围无效。');
  return next - 1;
}

export function companionMemoryDateRange(from: string | undefined, to: string | undefined, timeZone: string) {
  const start = companionMemoryDateBoundary(from, false, timeZone), end = companionMemoryDateBoundary(to, true, timeZone);
  if (start !== undefined && end !== undefined && start > end) throw new Error('记忆查询的起始日期晚于结束日期。');
  return { start, end };
}
