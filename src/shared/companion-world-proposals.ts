import { z } from 'zod';
import { companionMemoryCandidateSchema, companionMemoryConsolidateSchema } from './companion-memory';
import { companionStateProposalSchema } from './companion-state';
import { companionDreamInvestigationProposalSchema } from './companion-memory-investigation';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const companionWorldReflectionProposalSchema = z.strictObject({ notes: z.array(companionMemoryCandidateSchema).max(40),
  stateProposal: companionStateProposalSchema.optional(), dream: z.null() });
export const companionWorldMaintenanceProposalSchema = z.strictObject({ decision: z.enum(['merge', 'defer']), reason: z.string().trim().min(1).max(2000),
  consolidations: z.array(companionMemoryConsolidateSchema).max(4) }).refine(value => (value.decision === 'merge') === (value.consolidations.length > 0));
export const companionWorldNarrativeProposalSchema = z.strictObject({ text: z.string().trim().min(1).max(4000), relatedMemoryIds: z.array(id).min(1).max(30),
  investigations: z.array(companionDreamInvestigationProposalSchema).max(3).optional() }).nullable();
const common = { basis: hash, prohibitionRevision: z.string().min(1).max(128),
  checks: z.record(hash, z.boolean()).refine(value => Object.keys(value).length <= 64), expectedStateRevision: z.number().int().positive().optional() };
/** An unpublished host proposal is never a fact or an authorization. Only the
 * current source-fenced job can resume its outstanding semantic checks. */
export const companionWorldProposalSchema = z.discriminatedUnion('phase', [
  z.strictObject({ ...common, phase: z.literal('reflection'), writer: companionWorldReflectionProposalSchema }),
  z.strictObject({ ...common, phase: z.literal('real'), writer: companionWorldMaintenanceProposalSchema }),
  z.strictObject({ ...common, phase: z.literal('dream'), writer: companionWorldNarrativeProposalSchema }),
]).refine(value => JSON.stringify(value).length <= 524288);
export type CompanionWorldProposal = z.infer<typeof companionWorldProposalSchema>;
export const companionWorldProposalCommands = [
  z.strictObject({ type: z.literal('world.job.proposal.read'), id, leaseToken: id, phase: z.enum(['reflection', 'real', 'dream']), basis: hash, prohibitionRevision: z.string().min(1).max(128) }),
  z.strictObject({ type: z.literal('world.job.proposal.save'), id, leaseToken: id, proposal: companionWorldProposalSchema }),
] as const;
