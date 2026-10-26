import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Durable task checkpoint locator. Candidate/source bodies remain in the
 * same owner-owned prepared package, not in model-visible task metadata. */
export const companionPreparedRecallReferenceSchema = z.strictObject({ schema: z.literal('worldlinebox.task-prepared-recall-v1'),
  ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), taskKey: digest, profileKey: z.string().min(1).max(4096),
  scopeId: z.string().min(1).max(4096), id: z.string().regex(/^prepared_[a-f0-9]{32}$/u), contentHash: digest,
  expiresAt: z.string().datetime({ offset: true }), focusHash: digest.optional() });
export type CompanionPreparedRecallReference = z.infer<typeof companionPreparedRecallReferenceSchema>;
