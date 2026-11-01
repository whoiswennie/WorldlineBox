import { z } from 'zod';
import { companionReplyTaskMessageSchema } from './companion-reply-task-snapshot';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Private receipt from a completed Store publication transaction. It is an
 * input to Main's full final gate, never a model/renderer publication grant. */
export const companionReplyPublicationSchema = z.strictObject({
  schema: z.literal('worldlinebox.companion-reply-publication-v1'),
  companionId: id, conversationId: id, sourceMessageId: id, invocationKey: id.optional(), authorizationGrantId: id.optional(),
  executionReadsetDigest: digest,
  newlyPublished: z.boolean(),
  source: z.strictObject({ id, authorId: id, conversationId: id, revision: z.number().int().positive().safe(), checksum: digest }),
  message: companionReplyTaskMessageSchema,
});
export type CompanionReplyPublication = z.infer<typeof companionReplyPublicationSchema>;
