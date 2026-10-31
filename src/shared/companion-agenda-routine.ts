import { z } from 'zod';
import type { CompanionAgendaRule, CompanionAgendaRuleDraft } from './companion-agenda';
import type { CompanionRoutineConfig } from './companion-routine';

export const companionAgendaRoutineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sleep') }),
  z.strictObject({ kind: z.literal('meal'), name: z.string().trim().min(1).max(60) }),
  z.strictObject({ kind: z.literal('habit'), habitKind: z.enum(['rest', 'exercise', 'study', 'leisure', 'custom']) }),
]);
type RoutineRule = Pick<CompanionAgendaRule, 'id' | 'revision' | 'title' | 'executor' | 'clock' | 'routine' | 'trigger' | 'status' | 'createdAt' | 'updatedAt' | 'conversationId' | 'sourceMessageId'>;
const minuteClock = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const clockMinute = (value: string) => { const [hour, minute] = value.split(':').map(Number); return hour! * 60 + minute!; };

/** Window boundaries are the only time authority; payloads carry meaning,
 * never another independently editable copy of the start/end/duration. */
export function validateCompanionAgendaRoutine(rule: { executor: string; clock?: string; routine?: z.output<typeof companionAgendaRoutineSchema>;
  trigger: { kind: string; startMinute?: number; endMinute?: number; probability?: number; weekDays?: number[] } }): string[] {
  if (rule.executor !== 'routine') return rule.clock === 'world' || rule.routine ? ['只有虚拟作息规则可以使用世界时钟与身体活动参数。'] : [];
  if (rule.clock !== 'world' || !rule.routine || rule.trigger.kind !== 'window') return ['虚拟作息必须绑定世界时钟、明确的活动类型与完整时间窗口。'];
  const window = rule.trigger;
  if (window.startMinute === undefined || window.endMinute === undefined) return ['虚拟作息缺少完整的起止时间。'];
  const duration = (window.endMinute - window.startMinute + 1440) % 1440;
  if (window.probability !== 1) return ['基础身体作息使用确定的时间窗口；机会概率属于其他自主事件。'];
  if (!duration) return ['身体活动窗口不能占满或清空一整天。'];
  if (rule.routine.kind !== 'habit' && window.weekDays && window.weekDays.length !== 7) return ['睡眠与用餐目前使用每日窗口，不能伪装成按周生效。'];
  if (rule.routine.kind === 'meal' && duration > 180) return ['用餐窗口不能超过180分钟。'];
  if (rule.routine.kind === 'habit' && duration > 240) return ['习惯活动窗口不能超过240分钟。'];
  return [];
}

export function projectCompanionAgendaRoutine(rules: readonly RoutineRule[], timeZone: string): {
  config: CompanionRoutineConfig;
  sources: Array<Pick<RoutineRule, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'conversationId' | 'sourceMessageId'>>;
} {
  const active = rules.filter(rule => rule.executor === 'routine' && rule.status === 'active').sort((a, b) => a.id.localeCompare(b.id));
  const config: CompanionRoutineConfig = { timeZone, sleepEnabled: false, sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] };
  let sleeps = 0;
  for (const rule of active) {
    const errors = validateCompanionAgendaRoutine(rule); if (errors.length) throw new Error(errors[0]);
    if (rule.trigger.kind !== 'window' || !rule.routine) throw new Error('虚拟作息缺少结构化窗口。');
    const { startMinute, endMinute, weekDays } = rule.trigger, durationMinutes = (endMinute - startMinute + 1440) % 1440;
    if (rule.routine.kind === 'sleep') {
      if (++sleeps > 1) throw new Error('当前伙伴存在重复的每日睡眠窗口，请先处理日程冲突。');
      config.sleepEnabled = true; config.sleepAt = minuteClock(startMinute); config.wakeAt = minuteClock(endMinute);
    } else if (rule.routine.kind === 'meal') config.meals.push({ name: rule.routine.name, at: minuteClock(startMinute), durationMinutes });
    else config.habits.push({ id: rule.id, title: rule.title, kind: rule.routine.habitKind, at: minuteClock(startMinute), durationMinutes, ...(weekDays ? { weekDays } : {}) });
  }
  if (config.meals.length > 8 || config.habits.length > 20) throw new Error('虚拟作息的活动过多，请先整理冲突的日程规则。');
  return { config, sources: active.map(({ id, revision, createdAt, updatedAt, conversationId, sourceMessageId }) => ({ id, revision, createdAt, updatedAt, conversationId, sourceMessageId })) };
}

/** Creation-only seed drafts. Callers create these idempotently and explicitly
 * adopt them after the complete seed; reads never repair or re-enable plans. */
export function companionAgendaRoutineRuleDrafts(config: CompanionRoutineConfig): CompanionAgendaRuleDraft[] {
  const window = (start: string, durationMinutes: number, weekDays?: number[]) => ({ kind: 'window' as const,
    startMinute: clockMinute(start), endMinute: (clockMinute(start) + durationMinutes) % 1440, timeZone: config.timeZone,
    probability: 1, ...(weekDays ? { weekDays } : {}) });
  const base = { kind: 'rest' as const, executor: 'routine' as const, clock: 'world' as const, flexible: true, protected: false,
    conditions: [], resourceKeys: [], overlapPolicy: 'parallel' as const, reason: '创建时提供的初始虚拟生活计划；之后由统一日程维护。' };
  return [
    ...(config.sleepEnabled === false ? [] : [{ ...base, title: '睡眠与起床', intent: '在这个世界时间窗口休息；起床时仍按实际身体动作推进。',
      referenceId: 'routine_sleep', routine: { kind: 'sleep' as const }, trigger: window(config.sleepAt, (clockMinute(config.wakeAt) - clockMinute(config.sleepAt) + 1440) % 1440) }]),
    ...config.meals.map((meal, index) => ({ ...base, title: meal.name, intent: '按此世界时间窗口安排虚拟用餐，实际状态以世界中的行动为准。',
      referenceId: 'routine_meal_' + index, routine: { kind: 'meal' as const, name: meal.name }, trigger: window(meal.at, meal.durationMinutes) })),
    ...config.habits.map((habit, index) => ({ ...base, title: habit.title, intent: '在此世界时间窗口安排这项虚拟日常；计划不等同于已经学习或完成。',
      referenceId: 'routine_habit_' + index, routine: { kind: 'habit' as const, habitKind: habit.kind }, trigger: window(habit.at, habit.durationMinutes, habit.weekDays) })),
  ];
}
