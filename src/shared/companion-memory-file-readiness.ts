import { z } from 'zod';
import { companionMemoryHistoryDescriptorSchema } from './companion-memory-history';
import { companionMemoryContentKindsSchema } from './companion-memory-scope';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const revision = z.number().int().positive().safe();
const job = z.strictObject({ id, state: z.enum(['pending', 'running', 'failed', 'done', 'parked', 'abandoned', 'stale', 'cancelled']) });
/** Metadata identifies fixed publication work. It never supplies model prose
 * or proves that committed bytes still exist on disk. */
export const companionMemoryFileReadinessSchema = z.strictObject({ state: z.enum(['pending', 'published']),
  descriptor: companionMemoryHistoryDescriptorSchema, historyJob: job.optional(),
  sourceJobs: z.array(job.extend({ sourceId: id, sourceRevision: revision, sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()) });
export type CompanionMemoryFileReadiness = z.infer<typeof companionMemoryFileReadinessSchema>;
export const companionMemoryFileInspectCommand = z.strictObject({ type: z.literal('memory.files.inspect'), companionId: id, conversationId: id,
  beforeSequence: z.number().int().nonnegative().safe().optional(), id, contentRevision: revision });
export const companionMemoryFileStateCommand = z.strictObject({ type: z.literal('memory.files.state'), companionId: id, conversationId: id,
  beforeSequence: z.number().int().nonnegative().safe().optional(), contentKinds: companionMemoryContentKindsSchema.optional() });
export const companionMemoryFileStateSchema = z.strictObject({ pending: z.boolean(), sourceThroughOrdinal: z.number().int().nonnegative().safe(), historyThroughOrdinal: z.number().int().nonnegative().safe() });
