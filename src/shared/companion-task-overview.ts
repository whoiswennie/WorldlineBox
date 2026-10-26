import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionTaskKindSchema = z.enum(['reply', 'action', 'activity', 'work_order', 'schedule', 'schedule_occurrence', 'social', 'social_notification',
  'world', 'world_action', 'life_occurrence', 'learning', 'learning_goal', 'memory_capture', 'memory_index', 'memory_tags', 'memory_timeline']);
export type CompanionTaskKind = z.infer<typeof companionTaskKindSchema>;
export const companionTaskStatusSchema = z.enum(['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']);
export const companionTaskCursorSchema = z.strictObject({ at: z.string().max(80), kind: companionTaskKindSchema, id });
export const companionTaskListCommand = z.strictObject({ type: z.literal('tasks.list'), companionId: id.optional(),
  view: z.enum(['current', 'history', 'all']).default('current'), cursor: companionTaskCursorSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20) });
export const companionTaskStopCommand = z.strictObject({ type: z.literal('task.stop'), companionId: id, kind: companionTaskKindSchema, id });
export const companionTaskResumeCommand = companionTaskStopCommand.extend({ type: z.literal('task.resume') }).strict();
export const companionTaskItemSchema = z.strictObject({ id, kind: companionTaskKindSchema, companionId: id, conversationId: id.optional(),
  conversationTitle: z.string().max(100).optional(),
  title: z.string().max(200), status: companionTaskStatusSchema, rawStatus: z.string().max(50), stage: z.string().max(500),
  createdAt: z.string().max(80).optional(), startedAt: z.string().max(80).optional(), updatedAt: z.string().max(80),
  finishedAt: z.string().max(80).optional(), scheduledAt: z.string().max(80).optional(), revision: z.number().int().nonnegative().optional(),
  canStop: z.boolean(), stopLabel: z.string().max(40).optional(), stopReason: z.string().max(300).optional(),
  stoppedByUser: z.boolean().default(false), stopRequestedAt: z.string().max(80).optional(),
  relatedActionId: id.optional(), sourceMessageId: id.optional(), messageId: id.optional(), parentId: id.optional(),
});
export type CompanionTaskItem = z.infer<typeof companionTaskItemSchema>;
export const companionTaskPageSchema = z.strictObject({ items: z.array(companionTaskItemSchema).max(50), hasMore: z.boolean(),
  nextCursor: companionTaskCursorSchema.optional(), total: z.number().int().nonnegative(),
  current: z.number().int().nonnegative(), history: z.number().int().nonnegative(),
  owners: z.array(z.strictObject({ companionId: id, name: z.string().max(60), current: z.number().int().nonnegative(), history: z.number().int().nonnegative() })),
  observedAt: z.string(), coverage: z.array(companionTaskKindSchema),
});
export type CompanionTaskPage = z.infer<typeof companionTaskPageSchema>;
export type CompanionTaskListQuery = z.infer<typeof companionTaskListCommand>;
export const companionTaskPageStorageCommand = companionTaskListCommand.extend({ type: z.literal('tasks.page'),
  runtimeItems: z.array(companionTaskItemSchema).max(1000).optional() }).strict();
export const companionTaskResolveStorageCommand = companionTaskStopCommand.extend({ type: z.literal('tasks.resolve') }).strict();
export const COMPANION_TASK_KIND_LABELS: Record<CompanionTaskKind, string> = {
  reply: '聊天回复', action: '工具执行', activity: '自主活动', work_order: '工作委托', schedule: '定时计划', schedule_occurrence: '定时执行',
  social: '伙伴交流', social_notification: '后续回报', world: '世界活动', world_action: '世界行动记录', life_occurrence: '自主生活行动', learning: '资料学习', learning_goal: '学习目标', memory_capture: '来源整理', memory_index: '记忆索引', memory_tags: '自动标签', memory_timeline: '时间线整理',
};
