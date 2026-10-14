import { companionRoutineConfigSchema, type CompanionRoutineConfig, type CompanionRoutineRuntime } from './companion-routine';
import { companionCivilInstantInZone, companionTimeInZone, resolveCompanionScheduleTimeZone } from './companion-schedule-time';

const MINUTE = 60_000, DAY = 86_400_000;
const phaseCache = new Map<string, { from: number; until: number; runtime: CompanionRoutineRuntime }>();
type Interval = { start: number; end: number; phase: CompanionRoutineRuntime['phase']; activity: string; priority: number;
  habitId?: string; kind?: CompanionRoutineConfig['habits'][number]['kind'] };
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
  const cacheKey = JSON.stringify(config), cached = phaseCache.get(cacheKey);
  if (cached && now >= cached.from && now < cached.until) return { ...cached.runtime };
  const intervals = timeline(config, now - 2 * DAY, now + 9 * DAY), active = activeInterval(intervals, now);
  const boundaries = [...new Set(intervals.flatMap(interval => [interval.start, interval.end]).filter(value => value > now))].sort((a, b) => a - b);
  const identity = active ? `${active.phase}/${active.activity}/${active.habitId ?? ''}` : 'awake';
  let next = boundaries.find(value => {
    const candidate = activeInterval(intervals, value);
    return (candidate ? `${candidate.phase}/${candidate.activity}/${candidate.habitId ?? ''}` : 'awake') !== identity;
  });
  next ??= epoch(nextLocalDay(now, zone));
  const runtime: CompanionRoutineRuntime = { phase: active?.phase ?? 'awake', ...(active ? { activity: active.activity } : {}),
    ...(active?.habitId ? { activeHabitId: active.habitId } : {}), nextTransitionAt: new Date(next).toISOString(),
    canRespond: !active, simulation: true };
  phaseCache.set(cacheKey, { from: now, until: next, runtime }); if (phaseCache.size > 128) phaseCache.delete(phaseCache.keys().next().value!);
  return { ...runtime };
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
