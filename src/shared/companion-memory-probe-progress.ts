import { z } from 'zod';

export const COMPANION_MEMORY_PROBE_PROGRESS_CHANNEL = 'worldlinebox:companion-memory-probe-progress';
export const companionMemoryProbeRequestIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionMemoryProbeStageIdSchema = z.enum(['preparation', 'queue', 'sources', 'runtime', 'projection', 'retrieval', 'focus', 'verification']);
export type CompanionMemoryProbeStageId = z.infer<typeof companionMemoryProbeStageIdSchema>;
export const COMPANION_MEMORY_PROBE_STAGE_LABELS: Record<CompanionMemoryProbeStageId, string> = {
  preparation: '准备回忆测试', queue: '等待记忆查询', sources: '核验记忆来源', runtime: '连接记忆引擎',
  projection: '同步记忆索引', retrieval: '检索相关记忆', focus: '整理检索片段', verification: '核验回忆结果',
};
const milliseconds = z.number().finite().nonnegative();
export const companionMemoryProbeStageTimingSchema = z.strictObject({
  id: companionMemoryProbeStageIdSchema, label: z.string().min(1).max(200), elapsedMs: milliseconds,
});
export type CompanionMemoryProbeStageTiming = z.infer<typeof companionMemoryProbeStageTimingSchema>;
const stages = z.array(companionMemoryProbeStageTimingSchema).max(8)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Memory probe stages must have unique IDs.');
export const companionMemoryProbeTimingSchema = z.strictObject({ totalMs: milliseconds, stages });
export type CompanionMemoryProbeTiming = z.infer<typeof companionMemoryProbeTimingSchema>;
/** Stages include the current stage's accrued duration. Do not add
 * stageElapsedMs to their sum again. Missing stages were not observed. */
export const companionMemoryProbeProgressEventSchema = z.strictObject({
  requestId: companionMemoryProbeRequestIdSchema, companionId: companionMemoryProbeRequestIdSchema,
  mode: z.enum(['active', 'passive']), state: z.enum(['running', 'completed', 'failed']),
  sequence: z.number().int().positive().safe(), stageId: companionMemoryProbeStageIdSchema,
  label: z.string().min(1).max(200), elapsedMs: milliseconds, stageElapsedMs: milliseconds, stages,
});
export type CompanionMemoryProbeProgressEvent = z.infer<typeof companionMemoryProbeProgressEventSchema>;
