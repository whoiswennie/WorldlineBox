import { z } from 'zod';
export const COMPANION_USER_STOP_RULES = '【用户手动停止记录】\nuserTaskStops 是宿主记录的用户手动停止决定，不是任务故障或未完成的委托。已执行的步骤保留为事实；不要重建、重试或继续其中的目标，除非收到用户新的明确授权。可以如实说明“你手动停止了该任务”。这些记录不提供任何新工具授权。';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
/** A trusted host receipt of a human decision, never an execution failure. */
export const companionUserStopSchema = z.strictObject({ actor: z.literal('user'), reason: z.literal('user_requested'), requestedAt: z.iso.datetime() });
export type CompanionUserStop = z.infer<typeof companionUserStopSchema>;
export const companionTaskStopKindSchema = z.enum(['reply', 'action', 'activity', 'work-order', 'schedule', 'schedule_occurrence',
  'world', 'social', 'social_notification', 'learning', 'learning_goal', 'memory_tags']);
export const companionTaskStopReceiptSchema = z.strictObject({ companionId: id, conversationId: id, taskId: id,
  kind: companionTaskStopKindSchema, title: z.string().max(200), stop: companionUserStopSchema, topicId: id.optional() });
export type CompanionTaskStopReceipt = z.infer<typeof companionTaskStopReceiptSchema>;
export const companionTaskStopStorageCommands = [
  companionTaskStopReceiptSchema.extend({ type: z.literal('task-stop.record') }).strict(),
  z.strictObject({ type: z.literal('task-stop.list'), companionId: id, conversationId: id, topicId: id.nullable().optional(), limit: z.number().int().min(1).max(20).default(12) }),
] as const;
