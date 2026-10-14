import { companionRoutineConfigSchema, type CompanionRoutineConfig, type CompanionRoutineRuntime, type CompanionHabitProgress } from './companion-routine';
import { companionCivilInstantInZone, companionTimeInZone, resolveCompanionScheduleTimeZone } from './companion-schedule-time';

const MINUTE = 60_000, DAY = 86_400_000;
type Interval = { start: number; end: number; phase: CompanionRoutineRuntime['phase']; activity: string; priority: number;
  habitId?: string; kind?: CompanionRoutineConfig['habits'][number]['kind'] };
type EnergyMap = { offset: number; low: number; high: number };
type WeekSummary = { energy: EnergyMap; completed: Record<string, number>; lastMissed: Record<string, number> };
const weekMaps = new Map<string, WeekSummary>();
export interface CompanionRoutineInterruption { start: string; end: string }

/** Explicit author presets are starting plans, never invented past experiences. */
export function defaultCompanionRoutineConfig(companionId?: string): CompanionRoutineConfig {
  const rest = { id: 'daily-rest', title: '午后休息', at: '13:30', durationMinutes: 20, kind: 'rest' as const };
  const authored: Record<string, CompanionRoutineConfig['habits']> = {
    'deepseek-sister': [{ ...rest, durationMinutes: 25 }, { id: 'quiet-music', title: '安静听歌', at: '20:30', durationMinutes: 30, kind: 'leisure' },
      { id: 'seaside', title: '看看海、放松一下', at: '17:30', durationMinutes: 20, kind: 'leisure' }],
    'deepseek-flash': [{ ...rest, durationMinutes: 15 }, { id: 'new-ideas', title: '探索新点子', at: '20:00', durationMinutes: 25, kind: 'study' },
      { id: 'light-exercise', title: '轻运动', at: '16:30', durationMinutes: 15, kind: 'exercise' }, { id: 'music', title: '听音乐', at: '17:30', durationMinutes: 20, kind: 'leisure' }],
    'huan-white': [rest, { id: 'daily-observation', title: '观察日常的小事', at: '16:00', durationMinutes: 20, kind: 'leisure' }],
    'huan-black': [rest, { id: 'quiet-observation', title: '安静观察与思考', at: '20:30', durationMinutes: 20, kind: 'study' }],
    gemini: [rest, { id: 'colors-ideas', title: '整理星光、颜色与新点子', at: '20:00', durationMinutes: 20, kind: 'leisure' }],
    gpt: [rest, { id: 'knowledge-notes', title: '整理知识笔记', at: '20:00', durationMinutes: 25, kind: 'study' }],
    grok: [rest, { id: 'counterexamples', title: '想想问题和反例', at: '20:00', durationMinutes: 20, kind: 'study' }],
    kimi: [rest, { id: 'reading-music', title: '安静阅读与音乐', at: '20:30', durationMinutes: 25, kind: 'study' }],
    minimax: [rest, { id: 'daily-story', title: '整理日常的声音与小故事', at: '20:00', durationMinutes: 20, kind: 'leisure' }],
    qwen: [rest, { id: 'language-practice', title: '语言与生活习惯练习', at: '20:00', durationMinutes: 20, kind: 'study' }],
    gugugaga: [rest, { id: 'little-stones', title: '看看小石头', at: '17:00', durationMinutes: 15, kind: 'leisure' }],
    guga: [rest, { id: 'tidy-care', title: '整理和小小照料', at: '17:00', durationMinutes: 15, kind: 'custom' }],
    doro: [rest, { id: 'small-surprises', title: '想想橘子和小惊喜', at: '17:00', durationMinutes: 15, kind: 'leisure' }],
    phoebe: [rest, { id: 'little-travel', title: '小旅行随想', at: '17:00', durationMinutes: 20, kind: 'leisure' }],
    phrolova: [rest, { id: 'quiet-music', title: '在安静空间整理音乐', at: '20:30', durationMinutes: 30, kind: 'study' }],
  };
  return companionRoutineConfigSchema.parse({ habits: authored[companionId ?? ''] ?? [rest] });
}

/** Sleep wins overlaps, then meals, rest and habits; these are virtual activities. */
export function evaluateCompanionRoutine(config: CompanionRoutineConfig, at: string | Date, interruptedUntil?: string): CompanionRoutineRuntime {
  const now = epoch(at), zone = resolveCompanionScheduleTimeZone(config.timeZone);
  if (interruptedUntil && epoch(interruptedUntil) > now) return { phase: 'awake', activity: '临时回应当前互动',
    nextTransitionAt: interruptedUntil, canRespond: true, interruptedUntil, simulation: true };
  const intervals = timeline(config, now - 2 * DAY, now + 9 * DAY), active = activeInterval(intervals, now);
  const boundaries = [...new Set(intervals.flatMap(interval => [interval.start, interval.end]).filter(value => value > now))].sort((a, b) => a - b);
  const identity = active ? `${active.phase}/${active.activity}/${active.habitId ?? ''}` : 'awake';
  let next = boundaries.find(value => {
    const candidate = activeInterval(intervals, value);
    return (candidate ? `${candidate.phase}/${candidate.activity}/${candidate.habitId ?? ''}` : 'awake') !== identity;
  });
  next ??= epoch(nextLocalDay(now, zone));
  return { phase: active?.phase ?? 'awake', ...(active ? { activity: active.activity } : {}),
    ...(active?.habitId ? { activeHabitId: active.habitId } : {}), nextTransitionAt: new Date(next).toISOString(),
    canRespond: !active, simulation: true };
}

/** Exact piecewise phase integration; full civil weeks reuse affine-clamp maps. */
export function advanceCompanionRoutineEnergy(config: CompanionRoutineConfig, from: string | Date, to: string | Date,
  energy: number, interruptedUntil?: string): number {
  const start = epoch(from), end = epoch(to);
  if (!Number.isFinite(energy)) throw new Error('作息精力无效。');
  if (end <= start) return clamp(energy);
  let current = start, result = clamp(energy);
  const interruption = interruptedUntil ? epoch(interruptedUntil) : undefined;
  while (current < end) {
    const nextWeek = addCivilDays(current, 7, config.timeZone), chunkEnd = Math.min(end, nextWeek);
    const full = chunkEnd === nextWeek && (!interruption || interruption <= current);
    let map: EnergyMap;
    if (full) map = weekSummary(config, current, nextWeek).energy;
    else map = energyMap(timeline(config, current, chunkEnd), current, chunkEnd, interruption);
    result = Math.max(map.low, Math.min(map.high, result + map.offset)); current = chunkEnd;
  }
  return clamp(result);
}

/** Derived virtual adherence, never a user fact or proof of an external action. */
export function deriveCompanionHabitProgress(config: CompanionRoutineConfig, since: string | Date, at: string | Date,
  interruptions: readonly CompanionRoutineInterruption[] = []): CompanionHabitProgress[] {
  const start = epoch(since), end = epoch(at), counts: Record<string, number> = {}, missed: Record<string, number> = {};
  let current = start;
  while (current < end) {
    const next = Math.min(end, addCivilDays(current, 7, config.timeZone));
    const summary = weekSummary(config, current, next);
    for (const [id, count] of Object.entries(summary.completed)) counts[id] = (counts[id] ?? 0) + count;
    for (const [id, relative] of Object.entries(summary.lastMissed)) missed[id] = Math.max(missed[id] ?? start, current + relative);
    if (current === start) for (const interval of timeline(config, start, Math.min(next, start + DAY))) {
      if (interval.habitId && interval.start < start && interval.end > start && interval.end <= next && fullyActive(interval, timeline(config, start, next))) counts[interval.habitId] = Math.max(0, (counts[interval.habitId] ?? 0) - 1);
    }
    current = next;
  }
  const interrupted = new Set<string>();
  for (const window of interruptions) {
    const left = Math.max(start, epoch(window.start)), right = Math.min(end, epoch(window.end));
    if (right <= left) continue;
    const intervals = timeline(config, left, right);
    for (const interval of intervals) if (interval.habitId && interval.start >= start && interval.end <= end && interval.start < right && interval.end > left && fullyActive(interval, intervals)) {
      const key = interval.habitId + '/' + interval.start;
      if (interrupted.has(key)) continue;
      interrupted.add(key); counts[interval.habitId] = Math.max(0, (counts[interval.habitId] ?? 0) - 1);
      missed[interval.habitId] = Math.max(missed[interval.habitId] ?? start, interval.end);
    }
  }
  const recent = timeline(config, Math.max(start, end - 9 * DAY), end);
  return config.habits.map(habit => {
    const complete = recent.filter(interval => interval.habitId === habit.id && interval.start >= start && interval.end <= end && fullyActive(interval, recent)
      && !interruptions.some(window => epoch(window.start) < interval.end && epoch(window.end) > interval.start))
      .sort((a, b) => b.end - a.end), last = complete[0];
    const count = counts[habit.id] ?? 0;
    return { id: habit.id, completedCount: count, strength: 100 * (1 - Math.exp(-count / 14)),
      streak: last ? missed[habit.id] !== undefined ? countCompletions(config, habit.id, missed[habit.id]!, end, interruptions) : count : 0,
      ...(last ? { lastCompletedAt: new Date(last.end).toISOString() } : {}) };
  });
}

function weekSummary(config: CompanionRoutineConfig, start: number, end: number): WeekSummary {
  const local = companionTimeInZone(start, config.timeZone), full = end === addCivilDays(start, 7, config.timeZone);
  const offsets: number[] = [];
  if (full) for (let day = 0; day <= 7; day++) {
    const time = addCivilDays(start, day, config.timeZone), parts = companionTimeInZone(time, config.timeZone);
    offsets.push(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond) - time);
  }
  const steady = full && end - start === 7 * DAY && new Set(offsets).size === 1;
  const key = steady ? JSON.stringify([config, new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay(),
    local.hour, local.minute, local.second, local.millisecond, offsets[0]]) : undefined;
  const cached = key ? weekMaps.get(key) : undefined;
  if (cached) return cached;
  const intervals = timeline(config, start, end), completed: Record<string, number> = {}, lastMissed: Record<string, number> = {};
  for (const interval of intervals) if (interval.habitId && interval.end > start && interval.end <= end) {
    if (fullyActive(interval, intervals)) completed[interval.habitId] = (completed[interval.habitId] ?? 0) + 1;
    else lastMissed[interval.habitId] = Math.max(lastMissed[interval.habitId] ?? 0, interval.end - start);
  }
  const result = { energy: energyMap(intervals, start, end), completed, lastMissed };
  if (key) { weekMaps.set(key, result); if (weekMaps.size > 128) weekMaps.delete(weekMaps.keys().next().value!); } return result;
}
function countCompletions(config: CompanionRoutineConfig, id: string, from: number, to: number, interruptions: readonly CompanionRoutineInterruption[]): number {
  let current = from, count = 0;
  while (current < to) { const next = Math.min(to, addCivilDays(current, 7, config.timeZone)); count += weekSummary(config, current, next).completed[id] ?? 0; current = next; }
  const seen = new Set<number>();
  for (const window of interruptions) {
    const left = Math.max(from, epoch(window.start)), right = Math.min(to, epoch(window.end)); if (right <= left) continue;
    const intervals = timeline(config, left, right);
    for (const interval of intervals) if (interval.habitId === id && interval.end > from && interval.end <= to && interval.start < right && interval.end > left && fullyActive(interval, intervals)) seen.add(interval.start);
  }
  return Math.max(0, count - seen.size);
}
function energyMap(intervals: Interval[], from: number, to: number, interruptedUntil?: number): EnergyMap {
  const boundaries = [...new Set([from, to, ...(interruptedUntil && interruptedUntil > from && interruptedUntil < to ? [interruptedUntil] : []),
    ...intervals.flatMap(interval => [interval.start, interval.end]).filter(value => value > from && value < to)])].sort((a, b) => a - b);
  const result: EnergyMap = { offset: 0, low: 0, high: 100 };
  for (let index = 1; index < boundaries.length; index++) {
    const left = boundaries[index - 1]!, right = boundaries[index]!, mid = (left + right) / 2;
    const active = interruptedUntil && mid < interruptedUntil ? undefined : activeInterval(intervals, mid);
    const rate = active?.phase === 'sleeping' ? 0.3 : active?.phase === 'eating' ? 0.5 : active?.phase === 'resting' ? 0.15
      : active?.kind === 'exercise' ? -0.12 : active?.kind === 'study' ? -0.06 : active?.kind === 'leisure' ? 0.04 : active?.phase === 'habit' ? -0.04 : -0.08;
    const delta = (right - left) / MINUTE * rate;
    result.offset += delta; result.low = clamp(result.low + delta); result.high = clamp(result.high + delta);
  }
  return result;
}
function timeline(config: CompanionRoutineConfig, from: number, to: number): Interval[] {
  const zone = resolveCompanionScheduleTimeZone(config.timeZone), first = companionTimeInZone(from, zone), last = companionTimeInZone(to, zone);
  const firstDay = Date.UTC(first.year, first.month - 1, first.day) - 2 * DAY, lastDay = Date.UTC(last.year, last.month - 1, last.day) + 2 * DAY;
  const intervals: Interval[] = [];
  for (let day = firstDay; day <= lastDay; day += DAY) {
    const sleep = atClock(day, config.sleepAt, zone), wake = atClock(day + (config.wakeAt <= config.sleepAt ? DAY : 0), config.wakeAt, zone);
    if (sleep !== undefined && wake !== undefined) intervals.push({ start: sleep, end: wake, phase: 'sleeping', activity: '睡眠', priority: 4 });
    for (const meal of config.meals) {
      const start = atClock(day, meal.at, zone);
      if (start !== undefined) intervals.push({ start, end: start + meal.durationMinutes * MINUTE, phase: 'eating', activity: meal.name, priority: 3 });
    }
    for (const habit of config.habits) {
      if (habit.weekDays && !habit.weekDays.includes(new Date(day).getUTCDay())) continue;
      const start = atClock(day, habit.at, zone);
      if (start !== undefined) intervals.push({ start, end: start + habit.durationMinutes * MINUTE, phase: habit.kind === 'rest' ? 'resting' : 'habit',
        activity: habit.title, priority: habit.kind === 'rest' ? 2 : 1, habitId: habit.id, kind: habit.kind });
    }
  }
  return intervals.filter(interval => interval.end > from - DAY && interval.start < to + DAY);
}
function activeInterval(intervals: Interval[], at: number): Interval | undefined {
  return intervals.filter(interval => interval.start <= at && interval.end > at).sort((a, b) => b.priority - a.priority || a.start - b.start || a.activity.localeCompare(b.activity))[0];
}
function fullyActive(interval: Interval, intervals: Interval[]): boolean {
  const others = intervals.filter(other => other !== interval && other.start < interval.end && other.end > interval.start);
  return !others.some(other => other.priority > interval.priority || other.priority === interval.priority && (other.start < interval.start || other.start === interval.start && other.activity.localeCompare(interval.activity) < 0));
}
function atClock(day: number, value: string, zone: string): number | undefined {
  const date = new Date(day), [hour, minute] = value.split(':').map(Number);
  return companionCivilInstantInZone({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: hour!, minute: minute!, second: 0, millisecond: 0 }, zone, 'next_valid');
}
function addCivilDays(epochValue: number, days: number, zone: string): number {
  const local = companionTimeInZone(epochValue, zone), date = new Date(Date.UTC(local.year, local.month - 1, local.day) + days * DAY);
  return companionCivilInstantInZone({ ...local, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }, zone, 'next_valid')!;
}
function nextLocalDay(at: number, zone: string): string { return new Date(addCivilDays(at, 1, zone)).toISOString(); }
function epoch(value: string | Date): number { const at = value instanceof Date ? value.getTime() : Date.parse(value); if (!Number.isFinite(at)) throw new Error('作息时间无效。'); return at; }
function clamp(value: number): number { return Math.max(0, Math.min(100, value)); }
