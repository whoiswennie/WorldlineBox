import { z } from 'zod';

const fact = z.object({ label: z.string().max(100), value: z.string().max(1000) });
const match = z.object({
  memoryId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), rank: z.number().int().positive().optional(),
  sourcePath: z.string().max(4096).optional(),
  excerpt: z.string().max(300).optional(), facts: z.array(fact).max(12), tags: z.array(z.string().max(100)).max(8),
});
/** Observed receipts of this request, not a simulated live progress indicator. */
export const companionMemoryRetrievalSchema = z.object({
  mode: z.enum(['active', 'passive']), engine: z.enum(['river', 'knn', 'none']), observedAt: z.string(), resultCount: z.number().int().nonnegative(),
  candidateQuerySeparateFromContext: z.literal(true),
  stages: z.array(z.object({
    id: z.enum(['scope', 'embedding', 'sensing', 'candidates', 'ranking', 'context']),
    state: z.enum(['completed', 'not_observed', 'degraded', 'skipped']), title: z.string().max(100), description: z.string().max(1500),
    facts: z.array(fact).max(16), tags: z.array(z.string().max(100)).max(30), matches: z.array(match).max(12),
  })).max(6),
});
export type CompanionMemoryRetrieval = z.infer<typeof companionMemoryRetrievalSchema>;
