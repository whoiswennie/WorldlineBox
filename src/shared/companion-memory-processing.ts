import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionMemoryProcessingFilterSchema = z.enum(['all', 'active', 'failed', 'completed']);
export type CompanionMemoryProcessingFilter = z.infer<typeof companionMemoryProcessingFilterSchema>;
export const companionMemoryJobScheduleSchema = z.object({
  scheduleKind: z.enum(['running', 'timer', 'retry', 'condition', 'manual', 'finished', 'unknown']),
  timeBasis: z.enum(['real', 'world']), observedAt: z.iso.datetime(), nextCheckAt: z.iso.datetime().optional(),
  nextAttemptAt: z.iso.datetime().optional(), waitingReason: z.string().max(100).optional(),
  condition: z.string().max(600), triggerRule: z.string().max(1000), explanation: z.string().max(1000),
});
export type CompanionMemoryJobSchedule = z.infer<typeof companionMemoryJobScheduleSchema>;
export const companionMemoryOwnerScheduleSchema = z.object({ observedAt: z.iso.datetime(), timeBasis: z.literal('real'),
  nextCheckAt: z.iso.datetime().optional(), condition: z.string().max(600), explanation: z.string().max(1000),
  schedulers: z.array(companionMemoryJobScheduleSchema.extend({ kind: z.enum(['capture', 'index', 'tags', 'timeline']) })).max(4),
});
export type CompanionMemoryOwnerSchedule = z.infer<typeof companionMemoryOwnerScheduleSchema>;
export const MEMORY_SCHEDULE_EXPLANATION = '检查时间来自当前已登记的后台定时器；最早重试时间仅是冷却下限，都不保证届时开始或完成。应用关闭时不执行，重新打开后继续检查。';
export const MEMORY_PROCESSING_TRIGGERS = {
  capture: '正式发布且允许记忆的聊天、伙伴互动及实际经历进入来源队列；后台检查后判断是否值得写成日记，不是每句话都记录。',
  index: '日记或资料保存、修订、标签变更和撤回后进入投递队列；同一记忆范围依次提交到本地向量与 VCP 索引。',
  tags: '允许自动标签且没有手工标签的资料进入队列；正文末尾明确的 Tag 行优先，否则使用全局聊天模型整理。',
  timeline: '有可用来源日记且此伙伴聊天模型可用时，经公平资源准入在后台整理月时间线与摘要，普通任务期间也可推进；同一身份与模型的同月自动重整至少间隔五分钟，手动失败重试可解除该冷却。',
} as const;
export const companionMemoryProcessingCommand = z.strictObject({ type: z.literal('memory.processing.status'), companionId: id,
  filter: companionMemoryProcessingFilterSchema.optional(), limit: z.number().int().min(1).max(50).default(30) });
export const companionMemoryProcessingJobSchema = z.object({ id, kind: z.enum(['capture', 'index', 'tags', 'timeline']),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale', 'waiting_model']),
  stage: z.string().max(300), title: z.string().max(160), attempts: z.number().int().nonnegative(),
  createdAt: z.string().optional(), startedAt: z.string().optional(), updatedAt: z.string().optional(), nextAttemptAt: z.string().optional(),
  sourceRevision: z.string().max(160).optional(),
  schedule: companionMemoryJobScheduleSchema.optional(),
  error: z.string().max(1000).optional(), preview: z.string().max(160).optional(), noteId: id.optional(), sourceMessageId: id.optional(), conversationId: id.optional(),
});
export const companionMemoryProcessingSchema = z.object({ companionId: id,
  schedule: companionMemoryOwnerScheduleSchema.optional(),
  summary: z.object({ pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative() }),
  jobs: z.array(companionMemoryProcessingJobSchema).max(50), hasMore: z.boolean(),
});
export type CompanionMemoryProcessing = z.infer<typeof companionMemoryProcessingSchema>;
export type CompanionMemoryProcessingJob = z.infer<typeof companionMemoryProcessingJobSchema>;
