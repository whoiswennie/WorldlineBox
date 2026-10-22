import { z } from 'zod';
import { companionRoutineRuntimeSchema } from './companion-routine';
import { companionStateChangeSchema } from './companion-state-change';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionMoodSchema = z.enum(['calm', 'bright', 'focused', 'tired', 'low']);
export const companionExpressionSchema = z.enum(['gentle', 'direct', 'playful', 'reserved']);
export const companionAppraisalSchema = z.strictObject({
  type: z.enum(['support', 'respect', 'boundary_violation', 'hostility', 'shared_success', 'repair', 'disappointment']),
  target: z.enum(['self', 'user', 'task', 'other']), intensity: z.number().min(0).max(1), confidence: z.number().min(0).max(1),
});
export type CompanionAppraisal = z.infer<typeof companionAppraisalSchema>;
export const companionStateProposalSchema = z.strictObject({
  expression: companionExpressionSchema.optional(),
  focus: z.string().trim().max(300).nullable().optional(), reason: z.string().trim().min(1).max(1000),
  sourceMessageIds: z.array(id).min(1).max(20),
  evidence: z.array(z.strictObject({ sourceMessageId: id, quote: z.string().min(1).max(4000) })).min(1).max(20),
  appraisals: z.array(companionAppraisalSchema).max(8).default([]),
});
export type CompanionStateProposal = z.input<typeof companionStateProposalSchema>;
export const companionRuntimeStateSchema = z.object({
  companionId: id, energy: z.number().min(0).max(100), mood: companionMoodSchema, expression: companionExpressionSchema,
  affect: z.object({ pleasure: z.number().min(-1).max(1), arousal: z.number().min(-1).max(1), dominance: z.number().min(-1).max(1) }),
  relationship: z.object({ affinity: z.number().min(0).max(100), trust: z.number().min(0).max(100), respect: z.number().min(0).max(100) }),
  focus: z.string().max(300).optional(), reason: z.string().max(1000).optional(),
  sourceConversationId: id.optional(), sourceMessageIds: z.array(id).optional(),
  evidence: z.array(z.object({ sourceMessageId: id, quote: z.string().max(4000) })).optional(),
  familiarity: z.object({ stage: z.enum(['new', 'acquainted', 'close']), interactionCount: z.number().int().nonnegative(), sharedEventCount: z.number().int().nonnegative() }),
  routine: companionRoutineRuntimeSchema.optional(),
  recentChanges: z.array(companionStateChangeSchema).max(5).optional(),
  updatedAt: z.iso.datetime(), revision: z.number().int().positive(),
});
export type CompanionRuntimeState = z.infer<typeof companionRuntimeStateSchema>;
const scope = z.object({ companionId: id, conversationId: id, beforeSequence: z.number().int().positive().optional() });
export const companionStatePublicCommands = [
  scope.extend({ type: z.literal('state.get') }).strict(),
  scope.extend({ type: z.literal('state.inspect') }).strict(),
] as const;
export const companionStateStorageCommands = [
  ...companionStatePublicCommands,
  scope.extend({ type: z.literal('state.update'), proposal: companionStateProposalSchema, expectedRevision: z.number().int().positive().optional() }).strict(),
  z.strictObject({ type: z.literal('state.interaction'), companionId: id, messageId: id }),
  z.strictObject({ type: z.literal('state.action'), actionId: id }),
  z.strictObject({ type: z.literal('state.tick'), at: z.iso.datetime().optional() }),
] as const;
