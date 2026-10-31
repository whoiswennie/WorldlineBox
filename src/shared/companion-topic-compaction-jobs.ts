import { z } from 'zod';
import { companionJobStateSchema, companionJobFailureKindSchema } from './companion-job-control';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const sequence = z.number().int().nonnegative().safe();
export const companionTopicCompactionJobSchema = z.strictObject({
  id, companionId: id, conversationId: id, topicId: id, sourceMessageId: id,
  requestedThroughSequence: sequence, claimedThroughSequence: sequence.optional(),
  requestedPublicationRevision: sequence, claimedPublicationRevision: sequence.optional(), checkedPublicationRevision: sequence,
  /** An inspected horizon, never a claim that all its messages were summarized. */
  checkedThroughSequence: sequence, attempts: sequence, status: companionJobStateSchema,
  revision: sequence, inputVersion: z.string().regex(/^[a-f0-9]{64}$/u), leaseToken: z.string().uuid().optional(),
});
const leased = { id, leaseToken: z.string().uuid() };
export const companionTopicCompactionCommands = [
  z.strictObject({ type: z.literal('topic.compaction.enqueue'), companionId: id, conversationId: id, topicId: id, sourceMessageId: id }),
  z.strictObject({ type: z.literal('topic.compaction.claim'), excludedCompanionIds: z.array(id).max(100).default([]), leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
  z.strictObject({ type: z.literal('topic.compaction.bind'), ...leased,
    sources: z.array(z.strictObject({ id, revision: z.number().int().positive().safe(), checksum: z.string().regex(/^[a-f0-9]{64}$/u) })).min(1).max(255),
    checkpointEventIds: z.array(id).max(2) }),
  z.strictObject({ type: z.literal('topic.compaction.check'), ...leased, extendLeaseMs: z.number().int().min(1000).max(600000).optional() }),
  z.strictObject({ type: z.literal('topic.compaction.settle'), ...leased, checkpointEventId: id.optional(), hasMore: z.boolean() }),
  z.strictObject({ type: z.literal('topic.compaction.fail'), ...leased, error: z.string().max(1000),
    failureKind: companionJobFailureKindSchema, unknownOutcome: z.literal(true).optional(), retryAfterMs: z.number().int().min(0).max(86400000).default(30000) }),
] as const;
export const companionTopicCompactionCommandSchema = z.discriminatedUnion('type', companionTopicCompactionCommands);
export type CompanionTopicCompactionJob = z.infer<typeof companionTopicCompactionJobSchema>;
export type CompanionTopicCompactionCommand = z.infer<(typeof companionTopicCompactionCommands)[number]>;
