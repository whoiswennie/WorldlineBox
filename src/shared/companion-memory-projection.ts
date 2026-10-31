import { z } from 'zod';
import { companionMemorySchema } from './companion-memory';
import { companionMemoryContentKindsSchema } from './companion-memory-scope';

const projectionId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), counter = z.number().int().nonnegative().safe();
const projectionScope = { companionId: projectionId, conversationId: projectionId, beforeSequence: counter.optional(), contentKinds: companionMemoryContentKindsSchema.optional(), publishedOnly: z.boolean().optional() };
/** Host-only metadata describes an authorized native projection, never supplies
 * model prose. Canonical owner files still supply every changed/selected body. */
export const companionMemoryProjectionNoteSchema = companionMemorySchema.omit({ content: true }).extend({
  bodyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), notBeforeSequence: counter,
}).strict();
export type CompanionMemoryProjectionNote = z.infer<typeof companionMemoryProjectionNoteSchema>;
export const companionMemoryProjectionStateSchema = z.strictObject({ companionId: projectionId, sequence: counter, floorSequence: counter,
  revocationEpoch: counter, resetRevision: counter, externalVersion: counter, generation: counter });
export type CompanionMemoryProjectionState = z.infer<typeof companionMemoryProjectionStateSchema>;
export const companionMemoryProjectionPageSchema = z.strictObject({ state: companionMemoryProjectionStateSchema,
  notes: z.array(companionMemoryProjectionNoteSchema), removedIds: z.array(projectionId), hasMore: z.boolean(), nextId: projectionId.optional(), nextSequence: counter.optional() });
export const companionMemoryProjectionCommands = [
  z.strictObject({ type: z.literal('memory.projection.state'), ...projectionScope }),
  z.strictObject({ type: z.literal('memory.projection.page'), ...projectionScope, expected: companionMemoryProjectionStateSchema,
    afterId: projectionId.optional(), limit: z.number().int().min(1).max(256).default(128) }),
  z.strictObject({ type: z.literal('memory.projection.delta'), ...projectionScope, expected: companionMemoryProjectionStateSchema,
    afterSequence: counter, limit: z.number().int().min(1).max(256).default(128) }),
  z.strictObject({ type: z.literal('memory.projection.release'), companionId: projectionId, expected: companionMemoryProjectionStateSchema }),
] as const;
