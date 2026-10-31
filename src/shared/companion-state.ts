import { z } from 'zod';
import { companionRoutineRuntimeSchema } from './companion-routine';
import { companionStateChangeSchema } from './companion-state-change';
import { companionCurrentExperienceDraftSchema, companionCurrentExperienceSchema,
  companionRelationshipRecordDraftSchema, companionRelationshipRecordSchema, companionQualitativeSourceVersionSchema } from './companion-current-experience';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionExpressionSchema = z.enum(['gentle', 'direct', 'playful', 'reserved']);
export const companionStateProposalSchema = z.strictObject({
  expression: companionExpressionSchema.optional(), focus: z.string().trim().max(300).nullable().optional(),
  experience: companionCurrentExperienceDraftSchema.optional(), relationshipUpdates: z.array(companionRelationshipRecordDraftSchema).max(8).default([]),
  reason: z.string().trim().min(1).max(1000), sourceMessageIds: z.array(id).min(1).max(20),
  evidence: z.array(z.strictObject({ sourceMessageId: id, quote: z.string().min(1).max(4000) })).min(1).max(20),
});
export type CompanionStateProposal = z.input<typeof companionStateProposalSchema>;
export const companionRuntimeStateSchema = z.strictObject({
  schema: z.literal('companion-runtime-qualitative-v1'), companionId: id, energy: z.number().min(0).max(100), expression: companionExpressionSchema,
  experience: companionCurrentExperienceSchema.optional(), relationshipRecords: z.array(companionRelationshipRecordSchema).max(24).default([]),
  focus: z.string().max(300).optional(), reason: z.string().max(1000).optional(), sourceConversationId: id.optional(), sourceMessageIds: z.array(id).max(100).optional(),
  sourceVersions: z.array(companionQualitativeSourceVersionSchema).max(100).optional(),
  evidence: z.array(z.strictObject({ sourceMessageId: id, quote: z.string().max(4000) })).optional(), routine: companionRoutineRuntimeSchema.optional(),
  recentChanges: z.array(companionStateChangeSchema).max(5).optional(), updatedAt: z.iso.datetime(), revision: z.number().int().positive(),
});
export type CompanionRuntimeState = z.infer<typeof companionRuntimeStateSchema>;
const scope = z.object({ companionId: id, conversationId: id, beforeSequence: z.number().int().positive().optional() });
export const companionStatePublicCommands = [scope.extend({ type: z.literal('state.get') }).strict(), scope.extend({ type: z.literal('state.inspect') }).strict()] as const;
export const companionStateStorageCommands = [...companionStatePublicCommands,
  scope.extend({ type: z.literal('state.update'), proposal: companionStateProposalSchema, expectedRevision: z.number().int().positive().optional() }).strict(),
  z.strictObject({ type: z.literal('state.interaction'), companionId: id, messageId: id }), z.strictObject({ type: z.literal('state.action'), actionId: id }),
  z.strictObject({ type: z.literal('state.tick'), at: z.iso.datetime().optional() }),
] as const;
