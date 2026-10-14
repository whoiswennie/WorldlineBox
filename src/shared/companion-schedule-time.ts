export interface CompanionScheduleTiming {
  runAt: string;
  timeZone: string;
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly' | 'interval';
  intervalMinutes?: number;
  weekDays?: number[];
}
interface CivilTime { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number }
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function isCompanionScheduleTimeZone(value: string): boolean {
  try { resolveCompanionScheduleTimeZone(value); return true; } catch { return false; }
}
export function resolveCompanionScheduleTimeZone(value: string): string {
  const resolved = value === 'system' ? Intl.DateTimeFormat().resolvedOptions().timeZone : value;
  formatter(resolved); return resolved;
}

/**
 * Find the first occurrence strictly after the boundary, retaining the original
 * civil-time anchor. Daily/weekly/monthly schedules follow the selected zone;
 * intervals follow elapsed minutes. Missing DST times skip that occurrence and
 * repeated DST times run once at the earlier instant. Missed periods do not
 * create a burst of overdue runs. A January 31 anchor remains a month-end anchor.
 */
export function nextCompanionScheduleRun(timing: CompanionScheduleTiming, after: string | Date): string | undefined {
  const anchor = instant(timing.runAt), boundary = instant(after);
  const timeZone = resolveCompanionScheduleTimeZone(timing.timeZone);
  if (!['once', 'daily', 'weekly', 'monthly', 'interval'].includes(timing.recurrence)) throw new Error('定时任务重复规则无效。');
  if (timing.recurrence === 'interval' && (!Number.isInteger(timing.intervalMinutes) || timing.intervalMinutes! < 1 || timing.intervalMinutes! > 525_600)) throw new Error('定时任务间隔无效。');
  if (timing.weekDays && (!timing.weekDays.length || timing.weekDays.length > 7 || new Set(timing.weekDays).size !== timing.weekDays.length
    || timing.weekDays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error('定时任务星期无效。');
  if (anchor > boundary) return new Date(anchor).toISOString();
  if (timing.recurrence === 'once') return undefined;
  if (timing.recurrence === 'interval') {
    const interval = timing.intervalMinutes! * 60_000;
    return new Date(anchor + (Math.floor((boundary - anchor) / interval) + 1) * interval).toISOString();
  }
  const start = civilTime(anchor, timeZone), current = civilTime(boundary, timeZone);
  const monthly = timing.recurrence === 'monthly';
  if (!monthly && timing.recurrence !== 'daily' && timing.recurrence !== 'weekly') throw new Error('定时任务重复规则无效。');
  const selectedWeekDays = timing.recurrence === 'weekly' && timing.weekDays?.length ? timing.weekDays : undefined;
  const step = timing.recurrence === 'weekly' && !selectedWeekDays ? 7 : 1;
  const dayDistance = Math.floor((civilEpoch({ ...current, hour: 0, minute: 0, second: 0, millisecond: 0 })
    - civilEpoch({ ...start, hour: 0, minute: 0, second: 0, millisecond: 0 })) / DAY);
  const period = Math.max(0, monthly ? (current.year - start.year) * 12 + current.month - start.month : Math.floor(dayDistance / step));
  for (let index = period; index <= period + 16; index++) {
    let candidate: CivilTime;
    if (monthly) {
      const monthIndex = start.year * 12 + start.month - 1 + index;
      const year = Math.floor(monthIndex / 12), month = monthIndex % 12 + 1;
      candidate = { ...start, year, month, day: Math.min(start.day, daysInMonth(year, month)) };
    } else {
      const date = new Date(civilEpoch({ ...start, hour: 0, minute: 0, second: 0, millisecond: 0 }) + index * step * DAY);
      candidate = { ...start, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    }
    if (selectedWeekDays && !selectedWeekDays.includes(new Date(civilEpoch(candidate)).getUTCDay())) continue;
    const epoch = civilInstant(candidate, timeZone);
    if (epoch !== undefined && epoch > boundary && epoch >= anchor) return new Date(epoch).toISOString();
  }
  throw new Error('无法计算定时任务的下一次时间。');
}

/** Actual host clock is model context, never a remembered/guessed current time. */
export function companionScheduleClock(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const at = instant(now), local = civilTime(at, timeZone);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return { now: new Date(at).toISOString(), timeZone,
    localTime: `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`,
    utcOffsetMinutes: Math.round((civilEpoch(local) - at) / 60_000),
    trust: 'host_clock_at_request_time' as const };
}

export function companionTimeInZone(epoch: number, timeZone: string): CivilTime { return civilTime(epoch, resolveCompanionScheduleTimeZone(timeZone)); }
export function companionCivilInstantInZone(time: CivilTime, timeZone: string, gap: 'skip' | 'next_valid' = 'skip'): number | undefined {
  const zone = resolveCompanionScheduleTimeZone(timeZone), result = civilInstant(time, zone);
  if (result !== undefined || gap === 'skip') return result;
  for (let minute = 1; minute <= 180; minute++) {
    const date = new Date(civilEpoch(time) + minute * 60_000);
    const next = civilInstant({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(),
      minute: date.getUTCMinutes(), second: date.getUTCSeconds(), millisecond: date.getUTCMilliseconds() }, zone);
    if (next !== undefined) return next;
  }
  return undefined;
}

function instant(value: string | Date): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('定时任务时间无效。');
  return result;
}
function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, result);
  }
  return result;
}
function civilTime(epoch: number, timeZone: string): CivilTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(epoch)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour),
    minute: Number(parts.minute), second: Number(parts.second), millisecond: new Date(epoch).getUTCMilliseconds() };
}
function civilEpoch(time: CivilTime): number {
  const date = new Date(0); date.setUTCFullYear(time.year, time.month - 1, time.day);
  date.setUTCHours(time.hour, time.minute, time.second, time.millisecond); return date.getTime();
}
function daysInMonth(year: number, month: number): number {
  const date = new Date(0); date.setUTCFullYear(year, month, 0); return date.getUTCDate();
}
function civilInstant(time: CivilTime, timeZone: string): number | undefined {
  const pseudo = civilEpoch(time), offsets = new Set<number>();
  for (const delta of [-2 * DAY, -DAY, 0, DAY, 2 * DAY]) offsets.add(civilEpoch(civilTime(pseudo + delta, timeZone)) - pseudo - delta);
  const matches = [...offsets].map(offset => pseudo - offset).filter(epoch => civilEpoch(civilTime(epoch, timeZone)) === pseudo);
  return matches.length ? Math.min(...matches) : undefined;
}
