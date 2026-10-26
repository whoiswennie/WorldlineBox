import { z } from 'zod';
import { companionMemoryHitSchema } from './companion-memory';
import { companionMemoryRetrievalSchema } from './companion-memory-retrieval';
import { companionMemoryProbeRequestIdSchema, companionMemoryProbeTimingSchema } from './companion-memory-probe-progress';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionMemoryProbeModeSchema = z.enum(['active', 'passive']);
export const companionMemoryCorpusStateCommand = z.strictObject({ type: z.literal('memory.recall.state'), companionId: id });
/** A human-triggered query through the companion's real VCP recall pipeline. */
export const companionMemoryProbeCommand = z.strictObject({
  type: z.literal('memory.recall.test'), companionId: id,
  requestId: companionMemoryProbeRequestIdSchema.optional(),
  query: z.string().trim().min(1).max(16000), mode: companionMemoryProbeModeSchema,
  limit: z.number().int().min(1).max(12).optional(),
});
export const companionMemoryProbeSchema = z.strictObject({
  companionId: id, mode: companionMemoryProbeModeSchema, query: z.string().max(16000), observedAt: z.string(),
  contextText: z.string().max(1024 * 1024), memories: z.array(companionMemoryHitSchema).max(12),
  pending: z.boolean(), degraded: z.boolean(), explanation: z.string().max(2000), corpusStamp: z.string().min(1).max(1000),
  memoryRetrieval: companionMemoryRetrievalSchema.optional(),
  timing: companionMemoryProbeTimingSchema.optional(),
});
export type CompanionMemoryProbe = z.infer<typeof companionMemoryProbeSchema>;
