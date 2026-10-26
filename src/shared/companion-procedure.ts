import { z } from 'zod';
import { dshArtifactRequirementSchema } from './dsh-task-spec';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
/** A proposed method has a bounded scope and an objective, host-checkable
 * delivery contract. It never grants a tool, edits persona, or certifies itself. */
export const companionMemoryProcedureProposalSchema = z.strictObject({
  applicability: z.string().trim().min(1).max(2000),
  steps: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  limitations: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
  verification: z.strictObject({ kind: z.literal('artifact_delivery'),
    artifactRequirements: z.array(dshArtifactRequirementSchema).min(1).max(10) }),
});
export const companionMemoryProcedureEvidenceSchema = z.strictObject({ actionId: id,
  sourceMessageId: id, conversationId: id, checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  contentRevision: z.number().int().positive(), outcome: z.enum(['passed', 'failed']), recordedAt: z.iso.datetime(),
});
export const companionMemoryProcedureValidationSchema = z.strictObject({ state: z.enum(['unverified', 'validated', 'disabled']),
  successes: z.number().int().nonnegative(), failures: z.number().int().nonnegative(),
  evidence: z.array(companionMemoryProcedureEvidenceSchema).max(20),
});
export const companionMemoryProcedureSchema = companionMemoryProcedureProposalSchema.extend({ validation: companionMemoryProcedureValidationSchema });
/** A scope-checked host sidecar, separate from the native RAG's quoted text. */
export const companionMemoryProcedureContextSchema = companionMemoryProcedureValidationSchema.extend({ memoryId: id, contentRevision: z.number().int().positive() });
export const companionMemoryProcedureContextListSchema = z.array(companionMemoryProcedureContextSchema).max(100);
export type CompanionMemoryProcedureContext = z.infer<typeof companionMemoryProcedureContextSchema>;
export type CompanionMemoryProcedureProposal = z.infer<typeof companionMemoryProcedureProposalSchema>;
export type CompanionMemoryProcedureValidation = z.infer<typeof companionMemoryProcedureValidationSchema>;
export type CompanionMemoryProcedure = z.infer<typeof companionMemoryProcedureSchema>;
export const unverifiedCompanionMemoryProcedure = (proposal: CompanionMemoryProcedureProposal): CompanionMemoryProcedure => ({
  ...companionMemoryProcedureProposalSchema.parse(proposal), validation: { state: 'unverified', successes: 0, failures: 0, evidence: [] },
});

/** Internal host command; deliberately absent from companion memory tools. */
export const companionMemoryProcedureObservationCommand = z.strictObject({ type: z.literal('memory.procedure.observe-action'), actionId: id });
