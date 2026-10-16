import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const timestamp = z.iso.datetime({ offset: true });
export const companionScheduleRecurrenceSchema = z.enum(['once', 'daily', 'weekly', 'monthly', 'interval']);
export const companionScheduleKindSchema = z.enum(['reminder', 'task', 'activity']);
export const companionScheduleStatusSchema = z.enum(['active', 'paused', 'cancelled']);
export const companionScheduleEntrySchema = z.strictObject({
  title: z.string().trim().min(1).max(160), prompt: z.string().trim().min(1).max(16000),
  kind: companionScheduleKindSchema.default('reminder'), runAt: timestamp,
  timeZone: z.string().trim().min(1).max(100).default('system'),
  recurrence: companionScheduleRecurrenceSchema.default('once'),
  flexible: z.boolean().default(false),
  intervalMinutes: z.number().int().min(1).max(525600).optional(),
  weekDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
}).superRefine((entry, context) => {
  if (entry.recurrence === 'interval' && !entry.intervalMinutes) context.addIssue({ code: 'custom', path: ['intervalMinutes'], message: '按间隔执行需要填写分钟数。' });
  if (entry.recurrence !== 'interval' && entry.intervalMinutes !== undefined) context.addIssue({ code: 'custom', path: ['intervalMinutes'], message: '分钟间隔只适用于按间隔执行。' });
  if (entry.recurrence !== 'weekly' && entry.weekDays !== undefined) context.addIssue({ code: 'custom', path: ['weekDays'], message: '星期选择只适用于每周执行。' });
});
export type CompanionScheduleEntry = z.input<typeof companionScheduleEntrySchema>;
export const companionSchedulePatchSchema = z.strictObject({
  title: z.string().trim().min(1).max(160).optional(), prompt: z.string().trim().min(1).max(16000).optional(),
  kind: companionScheduleKindSchema.optional(), runAt: timestamp.optional(), timeZone: z.string().trim().min(1).max(100).optional(),
  recurrence: companionScheduleRecurrenceSchema.optional(), intervalMinutes: z.number().int().min(1).max(525600).nullable().optional(),
  flexible: z.boolean().optional(),
  weekDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable().optional(),
});
export type CompanionSchedulePatch = z.input<typeof companionSchedulePatchSchema>;
export const companionScheduleSchema = z.object({
  id, companionId: id, conversationId: id, sourceMessageId: id, authorizationSourceMessageIds: z.array(id),
  title: z.string().max(160), prompt: z.string().max(16000), kind: companionScheduleKindSchema,
  runAt: timestamp, timeZone: z.string(), recurrence: companionScheduleRecurrenceSchema,
  intervalMinutes: z.number().int().positive().optional(), weekDays: z.array(z.number().int().min(0).max(6)).optional(),
  flexible: z.boolean(), blockedReason: z.enum(['resting', 'unavailable']).optional(), deferredUntil: timestamp.optional(),
  status: companionScheduleStatusSchema, revision: z.number().int().positive(),
  createdAt: timestamp, updatedAt: timestamp, nextRunAt: timestamp.optional(), lastRunAt: timestamp.optional(),
  lastResult: z.string().max(4000).optional(), lastError: z.string().max(1000).optional(),
  lastOccurrenceStatus: z.enum(['pending', 'dispatching', 'running', 'done', 'failed', 'cancelled']).optional(),
});
export type CompanionSchedule = z.infer<typeof companionScheduleSchema>;
export const companionScheduleOccurrenceSchema = z.object({
  id, scheduleId: id, companionId: id, conversationId: id, scheduledAt: timestamp,
  status: z.enum(['pending', 'dispatching', 'running', 'done', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(), createdAt: timestamp, updatedAt: timestamp,
  leaseToken: id.optional(), leaseUntil: timestamp.optional(), actionId: id.optional(), messageId: id.optional(),
  activityTaskId: id.optional(),
  startedAt: timestamp.optional(), finishedAt: timestamp.optional(), result: z.string().max(4000).optional(),
  error: z.string().max(1000).optional(), forced: z.boolean().default(false),
});
export type CompanionScheduleOccurrence = z.infer<typeof companionScheduleOccurrenceSchema>;
export const companionScheduleScopeSchema = z.object({ companionId: id, conversationId: id });
export const companionSchedulePublicCommands = [
  companionScheduleScopeSchema.extend({ type: z.literal('schedule.list'), includeHistory: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  companionScheduleScopeSchema.extend({ type: z.literal('schedule.create'), sourceMessageId: id.optional(), clientId: id.optional(), entries: z.array(companionScheduleEntrySchema).min(1).max(20) }).strict(),
  companionScheduleScopeSchema.extend({ type: z.literal('schedule.update'), id, expectedRevision: z.number().int().positive(), patch: companionSchedulePatchSchema, sourceMessageId: id.optional() }).strict(),
  companionScheduleScopeSchema.extend({ type: z.literal('schedule.pause'), id, expectedRevision: z.number().int().positive(), paused: z.boolean() }).strict(),
  companionScheduleScopeSchema.extend({ type: z.literal('schedule.cancel'), id, expectedRevision: z.number().int().positive() }).strict(),
  companionScheduleScopeSchema.extend({ type: z.literal('schedule.run-now'), id, expectedRevision: z.number().int().positive() }).strict(),
] as const;
export const companionScheduleStorageCommands = [
  ...companionSchedulePublicCommands,
  z.strictObject({ type: z.literal('schedule.recover-activities') }),
  z.strictObject({ type: z.literal('schedule.due.claim'), now: timestamp.optional(), leaseMs: z.number().int().min(1000).max(600000).default(30000) }),
  z.strictObject({ type: z.literal('schedule.occurrence.update'), id, leaseToken: id.optional(),
    status: companionScheduleOccurrenceSchema.shape.status, actionId: id.optional(), messageId: id.optional(),
    activityTaskId: id.optional(),
    result: z.string().max(4000).optional(), error: z.string().max(1000).optional() }),
] as const;
