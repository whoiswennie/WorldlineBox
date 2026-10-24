import { z } from 'zod';

export const companionTopicCanonRangeSchema = z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(0).max(1439), includeStart: z.boolean(), includeEnd: z.boolean() });
export const companionTopicCanonDraftSchema = z.object({ sourceMessageId: z.string(), quote: z.string().trim().min(1).max(8000), rule: z.string().trim().min(1).max(8000), timeRange: companionTopicCanonRangeSchema.optional() });
export const companionTopicCanonEntrySchema = companionTopicCanonDraftSchema.extend({ id: z.string(), sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u) });
export const companionTopicUserCanonSchema = z.object({ version: z.literal(1), throughSequence: z.number().int().nonnegative(), entries: z.array(companionTopicCanonEntrySchema).max(80) });
export type CompanionTopicUserCanon = z.infer<typeof companionTopicUserCanonSchema>;
export const companionTopicNarrativeTimeSchema = z.object({ sourceMessageId: z.string(), sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u), minutes: z.number().int().min(0).max(1439), quote: z.string().min(1), rangeDigest: z.string().regex(/^[a-f0-9]{64}$/u) });
/** This is host-created loop metadata, never a model/tool argument. */
export const companionTopicNarrativeApprovalSchema = z.object({ minutes: z.number().int().min(0).max(1439), quote: z.string().min(1), contentChecksum: z.string().regex(/^[a-f0-9]{64}$/u), rangeDigest: z.string().regex(/^[a-f0-9]{64}$/u), userCanon: companionTopicUserCanonSchema.optional(),
  expectedStateChecksum: z.string().regex(/^[a-f0-9]{64}$/u).optional() });
export type CompanionTopicNarrativeApproval = z.infer<typeof companionTopicNarrativeApprovalSchema>;
/** Independent host review of the full story reply, including clock-free prose. */
export const companionTopicPublicationApprovalSchema = z.strictObject({ companionId: z.string(), conversationId: z.string(), topicId: z.string(),
  contentScope: z.literal('full_reply'), contentChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedStateChecksum: z.string().regex(/^[a-f0-9]{64}$/u), expectedFormalPublicationRevision: z.number().int().nonnegative().safe(),
  userCanon: companionTopicUserCanonSchema.optional() });
export type CompanionTopicPublicationApproval = z.infer<typeof companionTopicPublicationApprovalSchema>;
/** Only semantic narrative state participates in this publication CAS.
 * A summary timestamp or a no-op scan watermark is not a new story event. */
export function companionTopicNarrativeBasis(checkpoint?: { state?: Record<string, unknown> }): string {
  const canon = checkpoint?.state?.__topicUserCanon, time = checkpoint?.state?.__topicNarrativeTime;
  return JSON.stringify([canon === undefined ? [] : companionTopicUserCanonSchema.parse(canon).entries,
    time === undefined ? null : companionTopicNarrativeTimeSchema.parse(time)]);
}
