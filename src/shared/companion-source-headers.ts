import { z } from 'zod';
import { companionSourceReferenceHeaderSchema } from './companion-reference-validation';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
/** Private predicate/presentation metadata. It grants no authority without the
 * original source guard and its final live/file/SQL fences. */
export const companionAuthorizedSourceHeaderSchema = companionSourceReferenceHeaderSchema.extend({
  sequence: z.number().int().positive().safe(), kind: z.enum(['text', 'notice', 'action']),
  status: z.enum(['sent', 'failed']), createdAt: z.string(),
  worldCreatedAt: z.string().optional(), worldTimeZone: z.string().optional(),
  replyToId: id.optional(), topicId: id.optional(), memoryEvidenceOnly: z.boolean(),
  hasWorldObservation: z.boolean(), hasAttachments: z.boolean(), hasAction: z.boolean(),
});
export const companionSourceHeadersCommandSchema = z.strictObject({ type: z.literal('memory.sources.headers'),
  companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().safe().optional(),
  ids: z.array(id).max(1000) });
export const companionSourceHeadersResultSchema = z.strictObject({
  headers: z.array(companionAuthorizedSourceHeaderSchema).max(1000), unsupportedIds: z.array(id).max(1000),
});
export type CompanionAuthorizedSourceHeader = z.infer<typeof companionAuthorizedSourceHeaderSchema>;
export type CompanionSourceHeadersResult = z.infer<typeof companionSourceHeadersResultSchema>;
