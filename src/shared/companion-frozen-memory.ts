import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionExecutionSourceReferenceSchema = z.strictObject({ id, conversationId: id, checksum: z.string().regex(/^[a-f0-9]{64}$/u) });
/** Immutable passive-task inputs retain their original source closure. Ordinary
 * note edits may change relevance without withdrawing those historical bytes. */
export const companionFrozenMemoryDependencySchema = z.strictObject({ id, sources: z.array(companionExecutionSourceReferenceSchema.extend({
  /** Native maintenance may require the exact raw source revision as well as
   * its bytes. Passive replies keep their existing byte-and-ACL semantics. */
  revision: z.number().int().positive().safe().optional(),
})).min(1) });
