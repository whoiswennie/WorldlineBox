import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const companionJobKindSchema = z.enum(['capture', 'index', 'tags', 'world', 'learning', 'learning_goal', 'timeline', 'growth', 'source_files', 'history_files', 'topic_compaction']);
export const companionJobStateSchema = z.enum(['pending', 'running', 'completed', 'failed', 'parked', 'abandoned', 'cancelled', 'stale', 'waiting_model']);
export const companionJobFailureKindSchema = z.enum(['processing', 'waiting', 'cancelled', 'stale']);
export const companionJobDispositionSchema = z.strictObject({ ownerId: id, kind: companionJobKindSchema, id,
  inputVersion: digest, revision: z.number().int().nonnegative().safe(),
  state: companionJobStateSchema,
  failureCount: z.number().int().nonnegative().safe(), cycleFailureCount: z.number().int().nonnegative().safe(),
  attemptCount: z.number().int().nonnegative().safe().optional(), processorId: id.optional(),
  lastError: z.string().max(1000).optional(), lastErrorAt: z.iso.datetime().optional(),
  sourceMessageId: id.optional(), conversationId: id.optional(), topicId: id.optional(),
  memoryId: id.optional(), contentRevision: z.number().int().positive().safe().optional(),
  sourceRevision: z.number().int().positive().safe().optional(), retryCycle: z.number().int().nonnegative().safe().optional(),
  assetId: z.string().min(1).max(4096).optional(), assetRevisionId: z.string().min(1).max(4096).optional(), offset: z.number().int().nonnegative().optional(),
});
export const companionJobControlCommandSchema = z.strictObject({ type: z.literal('jobs.control'), ownerId: id, kind: companionJobKindSchema, id,
  inputVersion: digest, expectedRevision: z.number().int().nonnegative().safe(), operationId: z.string().uuid(),
  action: z.enum(['park', 'resume', 'abandon']) });
export const companionJobInspectCommandSchema = z.strictObject({ type: z.literal('jobs.inspect'), ownerId: id, kind: companionJobKindSchema, id });
export const companionJobPageCommandSchema = z.strictObject({ type: z.literal('jobs.page'), ownerId: id, kind: companionJobKindSchema,
  states: z.array(companionJobStateSchema).min(1).max(9).optional(), afterId: id.optional(), limit: z.number().int().min(1).max(50).default(30) });
export const companionJobPageSchema = z.strictObject({ items: z.array(companionJobDispositionSchema).max(50), hasMore: z.boolean(), nextId: id.optional() });
export const companionJobCommands = [companionJobControlCommandSchema, companionJobInspectCommandSchema, companionJobPageCommandSchema] as const;
export type CompanionJobKind = z.infer<typeof companionJobKindSchema>;
export type CompanionJobDisposition = z.infer<typeof companionJobDispositionSchema>;
export type CompanionJobControlCommand = z.infer<typeof companionJobControlCommandSchema>;
export type CompanionJobFailureKind = z.infer<typeof companionJobFailureKindSchema>;
export type CompanionJobPageCommand = z.infer<typeof companionJobPageCommandSchema>;
export type CompanionJobPage = z.infer<typeof companionJobPageSchema>;

/** Initial engineering policy: only actual processing failures count. Waiting,
 * cancellation and invalidated inputs are separate outcomes. */
export const COMPANION_JOB_FAILURES_PER_CYCLE = 3;
