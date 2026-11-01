import { z } from 'zod';
import { companionReplyReceivedStateSchema } from './companion-reply-observation';
import { messageSchema } from './companions';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
/** Inference input, not the UI's token/progress/usage/segments presentation.
 * A draft's presence remains authoritative even though its text is omitted. */
export const companionReplyTaskMessageSchema = messageSchema.omit({ modelUsage: true, replyProgress: true, replyDraft: true, segments: true }).strict();
export type CompanionReplyTaskMessage = z.infer<typeof companionReplyTaskMessageSchema>;
/** Host-private scalar links and state receipts. Chat body authority stays in
 * replyTaskMessages (or legacy message/messages) and their Main source gate. */
export const companionReplyTaskSnapshotSchema = z.strictObject({
  capturedAt: z.iso.datetime(), sourceMessageId: id, sourceRevision: z.number().int().positive().safe(),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u), sourceSequence: z.number().int().positive().safe(),
  actors: z.array(z.strictObject({ companionId: id, historyIds: z.array(id).max(256), referenceId: id.optional(),
    observation: companionReplyReceivedStateSchema.optional(), worldSettledAt: z.iso.datetime().optional(),
    energySampledAt: z.iso.datetime().optional(), energyElapsedMs: z.number().nonnegative().optional() })).max(100),
});
export type CompanionReplyTaskSnapshot = z.infer<typeof companionReplyTaskSnapshotSchema>;
