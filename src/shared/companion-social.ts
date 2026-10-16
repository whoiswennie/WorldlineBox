import { z } from 'zod';
import { messageSchema, type CompanionMessage } from './companions';
import { companionSocialWorkOfferSchema } from './companion-social-work';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionSocialDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = Date.parse(value + 'T00:00:00Z'); return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}, '日期无效');
const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
export interface CompanionSocialMessage { message: CompanionMessage; virtualCreatedAt: string; recipientIds: string[]; channel?: 'phone' | 'face_to_face' }
export const companionSocialMessageSchema: z.ZodType<CompanionSocialMessage> = z.strictObject({
  message: z.lazy(() => messageSchema), virtualCreatedAt: z.iso.datetime(), recipientIds: z.array(id).max(20), channel: z.enum(['phone', 'face_to_face']).optional(),
});
export const companionSocialConversationSchema = z.strictObject({
  id, kind: z.enum(['private', 'group']), title: z.string().max(100), memberIds: z.array(id).min(2).max(20),
  updatedAt: z.iso.datetime(), lastMessage: companionSocialMessageSchema.optional(),
  messageCount: z.number().int().nonnegative(),
});
const context = { timeZone: z.string(), observedDay: companionSocialDaySchema, virtualNow: z.iso.datetime(), backlog: z.boolean() };
export const companionSocialConversationCursorSchema = z.strictObject({ updatedAt: z.iso.datetime(), id });
export const companionSocialMessageCursorSchema = z.strictObject({ sequence: z.number().int().positive() });
export const companionSocialConversationPageSchema = z.strictObject({
  ...context, items: z.array(companionSocialConversationSchema), total: z.number().int().nonnegative(), hasMore: z.boolean(), nextCursor: companionSocialConversationCursorSchema.optional(),
});
export const companionSocialMessagePageSchema = z.strictObject({
  ...context, items: z.array(companionSocialMessageSchema), total: z.number().int().nonnegative(), hasMore: z.boolean(), nextCursor: companionSocialMessageCursorSchema.optional(),
});
export const companionSocialDaysSchema = z.strictObject({ ...context,
  days: z.array(z.strictObject({ day: companionSocialDaySchema, messageCount: z.number().int().nonnegative(), conversationCount: z.number().int().nonnegative() })),
});
/** The human's private room, full request and profile never cross into peer context. */
export const companionSocialOriginSchema = z.strictObject({
  id, initiatorId: id, initiatorKind: z.enum(['human_player', 'companion']), ownerId: id,
  sharedText: z.string().max(2000), provenance: z.enum(['current_player_request', 'companion_initiative']),
});
export const companionSocialJobSchema = z.strictObject({ id, companionId: id, conversationId: id, sourceMessageId: id,
  throughSequence: z.number().int().positive(), chainId: id, remainingTurns: z.number().int().min(0).max(4),
  memberIds: z.array(id).min(2).max(20), channel: z.enum(['phone', 'face_to_face']),
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']), attempts: z.number().int().nonnegative(),
  leaseToken: id.optional(), typingNotBefore: z.iso.datetime(), createdAt: z.iso.datetime(),
  origin: companionSocialOriginSchema.optional(),
});
export const companionSocialNotificationSchema = z.strictObject({
  id, companionId: id, conversationId: id, sourceMessageId: id, origin: companionSocialOriginSchema,
  kind: z.enum(['peer_reply', 'visit_permission']), eventId: id, peerConversationId: id.optional(),
  evidence: z.strictObject({ authorId: id, text: z.string().max(65536), messageId: id.optional(),
    visitId: id.optional(), visitStatus: z.enum(['allowed', 'denied', 'expired', 'left']).optional() }),
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']), attempts: z.number().int().nonnegative(),
  leaseToken: id.optional(), createdAt: z.iso.datetime(),
});
export const companionSocialPublicCommands = [
  z.strictObject({ type: z.literal('social.conversations'), companionId: id.optional(), day: companionSocialDaySchema.optional(), query: z.string().trim().max(500).optional(), before: companionSocialConversationCursorSchema.optional(), limit: z.number().int().min(1).max(100).default(20) }),
  z.strictObject({ type: z.literal('social.messages'), conversationId: id, day: companionSocialDaySchema.optional(), query: z.string().trim().max(500).optional(), before: companionSocialMessageCursorSchema.optional(), around: id.optional(), limit: z.number().int().min(1).max(100).default(50) }),
  z.strictObject({ type: z.literal('social.days'), companionId: id.optional(), month: month.optional(), query: z.string().trim().max(500).optional() }),
] as const;
export const companionSocialStorageCommands = [...companionSocialPublicCommands,
  z.strictObject({ type: z.literal('social.conversation.ensure'), companionId: id, memberIds: z.array(id).min(2).max(20), title: z.string().trim().max(100).default('') }),
  z.strictObject({ type: z.literal('social.message.append'), conversationId: id, authorId: id, content: z.string().min(1).max(65536), virtualCreatedAt: z.iso.datetime(), clientId: id, recipientIds: z.array(id).max(20).optional(), replyToId: id.optional() }),
  z.strictObject({ type: z.literal('social.send'), companionId: id, conversationId: id, content: z.string().min(1).max(2000), channel: z.enum(['phone', 'face_to_face']), sourceMessageId: id.optional(), authorizationMessageId: id.optional(), replyToId: id.optional(), clientId: id }),
  z.strictObject({ type: z.literal('social.job.claim') }),
  z.strictObject({ type: z.literal('social.job.complete'), id, leaseToken: id, text: z.string().trim().max(2000).nullable().optional(), nextRecipientId: id.optional(), workOffer: companionSocialWorkOfferSchema.optional(), shareAddress: z.boolean().optional() }),
  z.strictObject({ type: z.literal('social.job.fail'), id, leaseToken: id, error: z.string().max(2000) }),
  z.strictObject({ type: z.literal('social.delegation.record'), companionId: id, conversationId: id, sourceMessageId: id,
    recipientIds: z.array(id).min(1).max(19), sharedText: z.string().trim().min(1).max(2000), visitId: id.optional(), intent: z.enum(['visit', 'message']).default('visit') }),
  z.strictObject({ type: z.literal('social.notification.claim') }),
  z.strictObject({ type: z.literal('social.notification.complete'), id, leaseToken: id, text: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal('social.notification.fail'), id, leaseToken: id, error: z.string().max(2000) }),
] as const;
export type CompanionSocialConversation = z.infer<typeof companionSocialConversationSchema>;
export type CompanionSocialConversationPage = z.infer<typeof companionSocialConversationPageSchema>;
export type CompanionSocialMessagePage = z.infer<typeof companionSocialMessagePageSchema>;
export type CompanionSocialDays = z.infer<typeof companionSocialDaysSchema>;
export type CompanionSocialJob = z.infer<typeof companionSocialJobSchema>;
export type CompanionSocialOrigin = z.infer<typeof companionSocialOriginSchema>;
export type CompanionSocialNotification = z.infer<typeof companionSocialNotificationSchema>;
