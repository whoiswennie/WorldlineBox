import { z } from 'zod';
import { isCompanionScheduleTimeZone } from './companion-schedule-time';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z.string().trim().min(1).max(100).refine(isCompanionScheduleTimeZone, '作息时区无效。');
export const companionRoutineMealSchema = z.strictObject({ name: z.string().trim().min(1).max(60), at: clock, durationMinutes: z.number().int().min(1).max(180) });
export const companionRoutineHabitSchema = z.strictObject({ id, title: z.string().trim().min(1).max(120), at: clock,
  durationMinutes: z.number().int().min(1).max(240), weekDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  kind: z.enum(['rest', 'exercise', 'study', 'leisure', 'custom']) }).superRefine((habit, context) => {
  if (habit.weekDays && new Set(habit.weekDays).size !== habit.weekDays.length) context.addIssue({ code: 'custom', path: ['weekDays'], message: '习惯星期不能重复。' });
});
export const companionRoutineConfigSchema = z.strictObject({
  timeZone: timeZone.default('system'), sleepAt: clock.default('23:00'), wakeAt: clock.default('07:00'),
  meals: z.array(companionRoutineMealSchema).max(8).default([{ name: '早餐', at: '08:00', durationMinutes: 20 },
    { name: '午餐', at: '12:00', durationMinutes: 30 }, { name: '晚餐', at: '19:00', durationMinutes: 30 }]),
  habits: z.array(companionRoutineHabitSchema).max(20).default([]),
}).superRefine((config, context) => {
  if (config.sleepAt === config.wakeAt) context.addIssue({ code: 'custom', path: ['wakeAt'], message: '睡觉与醒来时间须不同。' });
  if (new Set(config.habits.map(habit => habit.id)).size !== config.habits.length) context.addIssue({ code: 'custom', path: ['habits'], message: '习惯标识不能重复。' });
});
export type CompanionRoutineConfig = z.output<typeof companionRoutineConfigSchema>;
export const companionRoutinePatchSchema = z.strictObject({ timeZone: timeZone.optional(), sleepAt: clock.optional(), wakeAt: clock.optional(),
  meals: z.array(companionRoutineMealSchema).max(8).optional(), habits: z.array(companionRoutineHabitSchema).max(20).optional() })
  .refine(patch => Object.keys(patch).length > 0, '请提供作息修改。');
export type CompanionRoutinePatch = z.input<typeof companionRoutinePatchSchema>;
export const companionRoutineRuntimeSchema = z.object({ phase: z.enum(['awake', 'sleeping', 'eating', 'resting', 'habit']),
  activity: z.string().max(120).optional(), activeHabitId: id.optional(), nextTransitionAt: z.iso.datetime(), canRespond: z.boolean(),
  interruptedUntil: z.iso.datetime().optional(), simulation: z.literal(true).default(true) });
export type CompanionRoutineRuntime = z.output<typeof companionRoutineRuntimeSchema>;
export const companionHabitProgressSchema = z.object({ id, strength: z.number().min(0).max(100), completedCount: z.number().int().nonnegative(),
  streak: z.number().int().nonnegative(), lastCompletedAt: z.iso.datetime().optional() });
export type CompanionHabitProgress = z.infer<typeof companionHabitProgressSchema>;
export const companionRoutineSchema = z.object({ companionId: id, config: companionRoutineConfigSchema,
  revision: z.number().int().positive(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  sourceConversationId: id.optional(), sourceMessageId: id.optional(), habitProgress: z.array(companionHabitProgressSchema),
  runtime: companionRoutineRuntimeSchema });
export type CompanionRoutine = z.output<typeof companionRoutineSchema>;
const scope = z.object({ companionId: id, conversationId: id });
export const companionRoutinePublicCommands = [
  scope.extend({ type: z.literal('routine.get'), beforeSequence: z.number().int().positive().optional() }).strict(),
  scope.extend({ type: z.literal('routine.configure'), expectedRevision: z.number().int().positive(), patch: companionRoutinePatchSchema, sourceMessageId: id.optional() }).strict(),
] as const;
export const companionRoutineStorageCommands = [
  ...companionRoutinePublicCommands,
  scope.extend({ type: z.literal('routine.interrupt'), sourceMessageId: id }).strict(),
  z.strictObject({ type: z.literal('routine.complete-interrupt'), companionId: id }),
] as const;
