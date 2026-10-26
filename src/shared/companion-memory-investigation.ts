import { z } from 'zod';
import { companionExecutionReadsetSchema } from './companion-execution-evidence';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionDreamInvestigationProposalSchema = z.strictObject({
  question: z.string().trim().min(1).max(1000), hypothesis: z.string().trim().min(1).max(2000),
  relatedMemoryIds: z.array(id).min(1).max(30),
  /** This checks a narrow observation about a read, never the truth of a
   * general hypothesis. A free question without a rule waits for review. */
  test: z.strictObject({ kind: z.literal('authorized_source_contains'), quote: z.string().trim().min(1).max(500) }).optional(),
});
export type CompanionDreamInvestigationProposal = z.infer<typeof companionDreamInvestigationProposalSchema>;
export const companionMemoryInvestigationSchema = z.strictObject({ id, companionId: id, sessionId: id, dreamJobId: id, dreamMemoryId: id, dreamContentRevision: z.number().int().positive(),
  revision: z.number().int().positive(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), proposal: companionDreamInvestigationProposalSchema,
  status: z.enum(['pending', 'awaiting_authorization', 'observed', 'not_observed', 'invalid']),
  reason: z.string().max(1000),
  originReadset: companionExecutionReadsetSchema,
  result: z.strictObject({ kind: z.literal('reading_confirmation'), receiptId: id, sourceMessageId: id, grantId: id,
    /** Verified means only that this exact authorized text was observed. */
    matched: z.boolean(), observedQuote: z.string().max(500), verifiedAt: z.iso.datetime(), readset: companionExecutionReadsetSchema }).optional(),
});
export type CompanionMemoryInvestigation = z.infer<typeof companionMemoryInvestigationSchema>;
export const companionMemoryInvestigationCommands = [
  z.strictObject({ type: z.literal('world.investigations.list'), companionId: id, limit: z.number().int().min(1).max(100).default(30) }),
  // Host-only. Native tools cannot submit a read receipt or their own verdict.
  z.strictObject({ type: z.literal('world.investigations.observe'), companionId: id, id, expectedRevision: z.number().int().positive(),
    receiptId: id, readset: companionExecutionReadsetSchema }),
] as const;
