import { z } from 'zod';
import { companionKnowledgeReadSchema } from './companion-agent-run';
import { companionExecutionSourceReferenceSchema, companionFrozenMemoryDependencySchema } from './companion-frozen-memory';
import { companionMemoryFileReceiptsSchema } from './companion-memory-files';
export { companionFrozenMemoryDependencySchema } from './companion-frozen-memory';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionExecutionReadsetSchema = z.strictObject({
  schema: z.literal('worldlinebox.companion-execution-readset-v1'),
  companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().safe().optional(),
  /** False means legacy/untyped inputs were consumed and cannot be replayed. */
  complete: z.boolean(),
  memories: z.array(z.strictObject({ id, version: z.number().int().positive().safe() })),
  frozenMemories: z.array(companionFrozenMemoryDependencySchema).optional(),
  sources: z.array(companionExecutionSourceReferenceSchema),
  knowledgeReads: z.array(companionKnowledgeReadSchema),
  contexts: z.array(z.strictObject({ revision: z.string().min(1).max(1024), profileKey: z.string().min(1).max(4096),
    fileReceipts: companionMemoryFileReceiptsSchema.optional(), fileReceiptOnly: z.literal(true).optional(),
    beforeSequence: z.number().int().nonnegative().safe().optional() })),
  /** Captured immutable topic checkpoints, including their transitive DAG.
   * Missing legacy closure is deliberately not accepted as complete evidence. */
  topics: z.array(z.strictObject({ conversationId: id, topicId: id, checkpointEventIds: z.array(id).min(1).max(2), sourceMessageIds: z.array(id).max(512) })),
});
export type CompanionExecutionReadset = z.infer<typeof companionExecutionReadsetSchema>;
