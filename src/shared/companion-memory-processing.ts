import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionMemoryProcessingFilterSchema = z.enum(['all', 'active', 'failed', 'completed']);
export type CompanionMemoryProcessingFilter = z.infer<typeof companionMemoryProcessingFilterSchema>;
export const companionMemoryProcessingCommand = z.strictObject({ type: z.literal('memory.processing.status'), companionId: id,
  filter: companionMemoryProcessingFilterSchema.optional(), limit: z.number().int().min(1).max(50).default(30) });
export const companionMemoryProcessingJobSchema = z.object({ id, kind: z.enum(['capture', 'index', 'tags', 'timeline']),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale', 'waiting_model']),
  stage: z.string().max(300), title: z.string().max(160), attempts: z.number().int().nonnegative(),
  createdAt: z.string().optional(), startedAt: z.string().optional(), updatedAt: z.string().optional(), nextAttemptAt: z.string().optional(),
  sourceRevision: z.string().max(160).optional(),
  error: z.string().max(1000).optional(), preview: z.string().max(160).optional(), noteId: id.optional(), sourceMessageId: id.optional(), conversationId: id.optional(),
});
export const companionMemoryProcessingSchema = z.object({ companionId: id,
  summary: z.object({ pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative() }),
  jobs: z.array(companionMemoryProcessingJobSchema).max(50), hasMore: z.boolean(),
});
export type CompanionMemoryProcessing = z.infer<typeof companionMemoryProcessingSchema>;
export type CompanionMemoryProcessingJob = z.infer<typeof companionMemoryProcessingJobSchema>;
