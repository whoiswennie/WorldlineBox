import { z } from 'zod';
import { companionFrozenMemoryDependencySchema } from './companion-frozen-memory';
import { companionMemoryArtifactKindSchema } from './companion-memory-scope';

/** The same host VCP evidence crosses public responses and durable peer-reply
 * receipts. Keeping it in a dependency-free leaf avoids a second, stale wire
 * contract and never turns free model metadata into host provenance. */
export const companionMemoryContextEvidenceSchema = z.strictObject({
  capturedAt: z.string(), corpusHash: z.string(), beforeSequence: z.number().int().nonnegative().optional(),
  queryCorpusHash: z.string().optional(), pageMemoryIds: z.array(z.string()).optional(),
  queryClock: z.strictObject({ now: z.string(), timeZone: z.string(), domain: z.literal('world') }).optional(),
  recallPolicy: z.strictObject({ schema: z.literal('episodic-v1'), halfLifeDays: z.literal(180), minScore: z.literal(0), protectedNoteIds: z.array(z.string()),
    applied: z.boolean(), eligibleCount: z.number().int().nonnegative(), protectedCount: z.number().int().nonnegative() }).optional(),
  candidateOrder: z.enum(['independent_native_query', 'context_observation']).optional(), contextOrder: z.literal('original_context_pipeline').optional(),
  referenceCoverage: z.enum(['observed', 'partial', 'unavailable']).optional(), dependencyCoverage: z.literal('complete').optional(),
  dependencies: z.array(z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), version: z.number().int().positive().safe() })).optional(),
  snapshotPolicy: z.literal('task_passive_v1').optional(),
  frozenDependencies: z.array(companionFrozenMemoryDependencySchema).optional(),
  references: z.array(z.strictObject({ id: z.string(), version: z.number().int().positive(), role: z.enum(['returned', 'focus_input']),
    artifactKind: companionMemoryArtifactKindSchema.optional(),
    sourceFile: z.string().optional(), textHash: z.string(),
    sources: z.array(z.strictObject({ messageId: z.string(), revision: z.number().int().positive(), checksum: z.string() })) })).optional(),
});
export type CompanionMemoryContextEvidence = z.infer<typeof companionMemoryContextEvidenceSchema>;
