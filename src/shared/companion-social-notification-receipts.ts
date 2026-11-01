import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Host-only projection of an already published same-room report. No peer
 * prose is returned and ordinary assistant assertions cannot produce it. */
export const companionSocialNotificationReceiptsCommandSchema = z.strictObject({
  type: z.literal('social.notifications.receipts'), companionId: id, conversationId: id,
  messageIds: z.array(id).min(1).max(256),
});
export const companionSocialNotificationReceiptSchema = z.strictObject({
  messageId: id, companionId: id, conversationId: id, revision: z.number().int().positive().safe(), checksum: digest,
  kind: z.literal('peer_reply'), notificationIds: z.array(id).min(1).max(16),
  peerReplies: z.array(z.strictObject({ messageId: id, authorId: id, conversationId: id,
    revision: z.number().int().positive().safe(), checksum: digest })).min(1).max(16),
  observationChecksum: digest,
});
export type CompanionSocialNotificationReceipt = z.infer<typeof companionSocialNotificationReceiptSchema>;
