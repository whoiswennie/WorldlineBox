import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionVisibleExpressionSchema = z.enum(['idle', 'pleased', 'troubled', 'sad', 'angry', 'surprised', 'tired']);
/** The owner's statements, not a host measurement of their mind. */
export const companionCurrentExperienceDraftSchema = z.strictObject({
  situation: z.string().trim().min(1).max(1000), touchedGoalIds: z.array(id).max(12).default([]),
  statement: z.string().trim().min(1).max(600).optional(), focus: z.string().trim().min(1).max(300).optional(),
  uncertainty: z.string().trim().min(1).max(500).optional(), responsePreference: z.string().trim().min(1).max(500).optional(),
  reassessWhen: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  visibleExpression: companionVisibleExpressionSchema.optional(), validUntil: z.iso.datetime().optional(),
});
export const companionRelationshipRecordDraftSchema = z.strictObject({
  targetId: id, topic: z.string().trim().min(1).max(120), context: z.string().trim().min(1).max(600),
  kind: z.enum(['agreement', 'shared_experience', 'commitment', 'fulfilment', 'disagreement', 'repair', 'boundary', 'expectation']),
  statement: z.string().trim().min(1).max(1000), currentExpectation: z.string().trim().min(1).max(600).optional(),
  reassessWhen: z.array(z.string().trim().min(1).max(300)).min(1).max(8), replacesRecordIds: z.array(id).max(12).default([]),
});
export const companionQualitativeSourceVersionSchema = z.strictObject({ messageId: id, revision: z.number().int().positive(), checksum: z.string().regex(/^[a-f0-9]{64}$/u) });
const provenance = { id, companionId: id, sourceConversationId: id, sourceMessageIds: z.array(id).min(1).max(100),
  sourceVersions: z.array(companionQualitativeSourceVersionSchema).min(1).max(100),
  occurredAt: z.iso.datetime(), recordedAt: z.iso.datetime(), revision: z.number().int().positive() };
export const companionCurrentExperienceSchema = companionCurrentExperienceDraftSchema.extend({ ...provenance, type: z.literal('current_experience') });
export const companionRelationshipRecordSchema = companionRelationshipRecordDraftSchema.extend({ ...provenance, type: z.literal('relationship_record') });
export type CurrentExperienceDraft = z.output<typeof companionCurrentExperienceDraftSchema>;
export type RelationshipRecordDraft = z.output<typeof companionRelationshipRecordDraftSchema>;
export type CurrentExperience = z.output<typeof companionCurrentExperienceSchema>;
export type RelationshipRecord = z.output<typeof companionRelationshipRecordSchema>;

/** Deliberate field projection prevents scores leaking via rest spread. */
export function currentExperienceGuidance(experience: CurrentExperience | undefined) {
  if (!experience) return undefined;
  return { situation: experience.situation, statement: experience.statement, focus: experience.focus,
    uncertainty: experience.uncertainty, responsePreference: experience.responsePreference, reassessWhen: experience.reassessWhen,
    trust: 'owner_subjective_expression_not_measured_psychology' as const };
}
