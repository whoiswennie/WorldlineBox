import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionResetCleanupStageSchema = z.enum(['stop', 'knowledge', 'native-records', 'documents', 'asset-index', 'profile']);
export const COMPANION_RESET_CLEANUP_LABELS = { stop: '正在停止旧任务', knowledge: '正在清理知识索引',
  'native-records': '正在清理原生任务记录', documents: '正在清理旧记忆文件', 'asset-index': '正在更新资产索引', profile: '正在恢复资料与形象' } as const;
export const companionResetSchema = z.strictObject({
  id, companionId: id, scope: z.literal('all'), status: z.enum(['running', 'completed', 'failed']),
  phase: z.string().max(80), processed: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), error: z.string().max(1000).optional(),
  cleanupStage: companionResetCleanupStageSchema.optional(),
});
export type CompanionReset = z.infer<typeof companionResetSchema>;
export const companionResetCommands = [
  z.strictObject({ type: z.literal('companion.reset'), id, scope: z.literal('all'), expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal('companion.reset.status'), id }),
] as const;
