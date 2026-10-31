import { z } from 'zod';
import { companionUserStopSchema } from './companion-task-stop';
import { messageSchema, type CompanionMessage } from './companions';
import { companionSocialWorkOfferSchema } from './companion-social-work';
import { COMPANION_AVATAR_IDS } from './companion-template-ids';
import { companionReplyProgressSchema } from './companion-reply-progress';
import { companionSocialRecallSchema, companionSocialReplyProgressCommand, companionSocialReplyMemoryCommand } from './companion-social-reply';
import { companionTopicSchema, companionTopicStateSchema } from './companion-topic';
import { companionExecutionReadsetSchema } from './companion-execution-evidence';
import { companionReplyReceivedStateSchema } from './companion-reply-observation';
import { companionTaskAssetsBlobSchema } from './companion-task-assets-binding';
import { companionTaskPreparationBlobSchema } from './companion-task-preparation';

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
export const companionSocialFlowEventSchema = z.strictObject({
  id, at: z.iso.datetime(), realAt: z.iso.datetime(), actorId: id, targetIds: z.array(id).max(20),
  kind: z.enum(['phone', 'face_to_face', 'unknown', 'visit_request', 'visit_response', 'scene_depart', 'scene_enter', 'travel_blocked', 'visit_leave', 'social_interrupt', 'social_resume']),
  label: z.string().max(100), text: z.string().max(65536), sceneId: id.optional(), visitId: id.optional(),
  actorName: z.string().optional(), targetNames: z.array(z.string()).max(20).optional(),
  textTruncated: z.boolean().optional(),
  message: companionSocialMessageSchema.optional(),
});
export const companionSocialFlowCursorSchema = z.strictObject({ at: z.iso.datetime(), id });
export const companionSocialFlowPageSchema = z.strictObject({ ...context,
  items: z.array(companionSocialFlowEventSchema).max(100), hasMore: z.boolean(), nextCursor: companionSocialFlowCursorSchema.optional(),
  visits: z.array(z.strictObject({ id, guestId: id, hostId: id, status: z.enum(['requested', 'allowed', 'denied', 'left', 'expired']), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), hostState: z.string().max(40).optional() })).max(20),
});
export type CompanionSocialFlowEvent = z.infer<typeof companionSocialFlowEventSchema>;
export type CompanionSocialFlowPage = z.infer<typeof companionSocialFlowPageSchema>;
export const companionSocialGraphGroupSchema = z.enum(['active', 'dormant', 'player']);
export const companionSocialGraphSchema = z.strictObject({ ...context, centerId: id,
  nodes: z.array(z.strictObject({ id, name: z.string(), active: z.boolean(), state: z.string().max(40), avatar: z.enum(COMPANION_AVATAR_IDS).optional(), avatarAttachmentId: id.optional() })).max(42),
  links: z.array(z.strictObject({ targetId: id, fromId: id.optional(), kind: z.enum(['player', 'peer']), conversationIds: z.array(id).max(20), status: z.enum(['idle', 'phone', 'face', 'queued', 'reply', 'permission', 'visiting']), phoneCount: z.number().int().nonnegative(), faceCount: z.number().int().nonnegative(), lastAt: z.iso.datetime().optional() })).max(41),
  total: z.number().int().nonnegative().optional(), matchedTotal: z.number().int().nonnegative().optional(),
  groups: z.array(z.strictObject({ id: companionSocialGraphGroupSchema, count: z.number().int().nonnegative() })).max(3).optional(),
  hasMorePeers: z.boolean().optional(), nextPeerId: id.optional(),
  events: z.array(companionSocialFlowEventSchema).max(60), visits: companionSocialFlowPageSchema.shape.visits,
  hasMoreEvents: z.boolean(),
});
export type CompanionSocialGraph = z.infer<typeof companionSocialGraphSchema>;
export const companionSocialDaysSchema = z.strictObject({ ...context,
  days: z.array(z.strictObject({ day: companionSocialDaySchema, messageCount: z.number().int().nonnegative(), conversationCount: z.number().int().nonnegative() })),
});
/** The human's private room, full request and profile never cross into peer context. */
export const companionSocialOriginSchema = z.strictObject({
  id, initiatorId: id, initiatorKind: z.enum(['human_player', 'companion']), ownerId: id,
  sharedText: z.string().max(2000), provenance: z.enum(['current_player_request', 'companion_initiative']),
});
const agendaNativeState = { agendaInputVersion: z.string().regex(/^[a-f0-9]{64}$/u).optional(), agendaRevision: z.number().int().nonnegative().optional(),
  agendaFailureCount: z.number().int().nonnegative().optional(), agendaCycleFailureCount: z.number().int().nonnegative().optional(), agendaUncertain: z.boolean().optional(), agendaRetryAt: z.iso.datetime().optional(), agendaParentRunId: id.optional() };
const agendaNativeClaim = { companionId: id.optional(), id: id.optional(), agendaRunId: id.optional(), agendaLeaseToken: id.optional(), expectedInputVersion: z.string().regex(/^[a-f0-9]{64}$/u).optional() };
const agendaNativeControl = { companionId: id, id, inputVersion: z.string().regex(/^[a-f0-9]{64}$/u), expectedRevision: z.number().int().nonnegative(),
  operationId: z.string().uuid(), action: z.enum(['park', 'resume', 'abandon']) };
export const companionSocialJobSchema = z.strictObject({ id, companionId: id, conversationId: id, sourceMessageId: id, ...agendaNativeState,
  receivedState: companionReplyReceivedStateSchema.optional(),
  taskAssets: companionTaskAssetsBlobSchema.optional(),
  preparation: companionTaskPreparationBlobSchema.optional(),
  stop: companionUserStopSchema.optional(), updatedAt: z.iso.datetime().optional(), finishedAt: z.iso.datetime().optional(),
  throughSequence: z.number().int().positive(), chainId: id, remainingTurns: z.number().int().min(0).max(4),
  memberIds: z.array(id).min(2).max(20), channel: z.enum(['phone', 'face_to_face']), urgent: z.boolean().optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled', 'parked', 'abandoned']), attempts: z.number().int().nonnegative(),
  terminal: z.boolean().optional(), error: z.string().max(2000).optional(),
  leaseToken: id.optional(), typingNotBefore: z.iso.datetime(), createdAt: z.iso.datetime(),
  origin: companionSocialOriginSchema.optional(),
});
/** A host-selected same-game reference, never an imported human request or grant. */
export const companionSocialGameContextSchema = z.strictObject({
  gamePort: z.strictObject({ conversationId: id, topicId: id }),
  topic: companionTopicSchema,
  topicState: companionTopicStateSchema,
  binding: z.strictObject({ jobId: id, companionId: id, sourceMessageId: id, sourceConversationId: id,
    sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/) }),
  trust: z.literal('actual_job_same_game_reference_not_source_or_human_authority'),
});
export type CompanionSocialGameContext = z.infer<typeof companionSocialGameContextSchema>;
const companionSocialNotificationEventSchema = z.strictObject({
  kind: z.enum(['peer_reply', 'visit_permission']), eventId: id, peerConversationId: id.optional(),
  evidence: z.strictObject({ authorId: id, text: z.string().max(65536), messageId: id.optional(),
    visitId: id.optional(), visitStatus: z.enum(['allowed', 'denied', 'expired', 'left']).optional() }),
});
export const companionSocialProgressEvidenceSchema = z.strictObject({ observationChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  outbound: z.array(z.strictObject({ message: z.lazy(() => messageSchema), recipientIds: z.array(id).max(19) })).max(100),
  complete: z.boolean() });
export const companionSocialNotificationSchema = z.strictObject({
  ...agendaNativeState,
  stop: companionUserStopSchema.optional(), updatedAt: z.iso.datetime().optional(), finishedAt: z.iso.datetime().optional(),
  id, companionId: id, conversationId: id, sourceMessageId: id, origin: companionSocialOriginSchema,
  ...companionSocialNotificationEventSchema.shape,
  events: z.array(companionSocialNotificationEventSchema).min(1).max(16).optional(),
  dialogue: z.array(z.lazy(() => messageSchema)).max(50).optional(),
  /** Host claim only: actual sent bodies linked to this human goal and its
   * exact recipients. Unrelated owner rooms are never part of this view. */
  progressEvidence: companionSocialProgressEvidenceSchema.optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled', 'parked', 'abandoned']), attempts: z.number().int().nonnegative(),
  terminal: z.boolean().optional(), error: z.string().max(2000).optional(),
  leaseToken: id.optional(), createdAt: z.iso.datetime(),
});
export const companionSocialPublicCommands = [
  companionSocialReplyProgressCommand,
  companionSocialReplyMemoryCommand,
  z.strictObject({ type: z.literal('social.graph'), companionId: id, query: z.string().trim().max(100).optional(), group: companionSocialGraphGroupSchema.optional(), afterPeerId: id.optional(), peerId: id.optional(), limit: z.number().int().min(1).max(40).optional() }),
  z.strictObject({ type: z.literal('social.flow'), conversationId: id, day: companionSocialDaySchema.optional(), before: companionSocialFlowCursorSchema.optional(), limit: z.number().int().min(1).max(100).default(60) }),
  z.strictObject({ type: z.literal('social.conversations'), companionId: id.optional(), day: companionSocialDaySchema.optional(), query: z.string().trim().max(500).optional(), before: companionSocialConversationCursorSchema.optional(), limit: z.number().int().min(1).max(100).default(20) }),
  z.strictObject({ type: z.literal('social.messages'), conversationId: id, day: companionSocialDaySchema.optional(), query: z.string().trim().max(500).optional(), before: companionSocialMessageCursorSchema.optional(), around: id.optional(), limit: z.number().int().min(1).max(100).default(50) }),
  z.strictObject({ type: z.literal('social.days'), companionId: id.optional(), month: month.optional(), query: z.string().trim().max(500).optional() }),
] as const;
export const companionSocialStorageCommands = [...companionSocialPublicCommands,
  z.strictObject({ type: z.literal('social.contact.check'), companionId: id, recipientIds: z.array(id).min(1).max(19) }),
  z.strictObject({ type: z.literal('social.conversation.ensure'), companionId: id, memberIds: z.array(id).min(2).max(20), roomId: id.optional(), title: z.string().trim().max(100).default('') }),
  z.strictObject({ type: z.literal('social.message.append'), conversationId: id, authorId: id, content: z.string().min(1).max(65536), virtualCreatedAt: z.iso.datetime(), clientId: id, recipientIds: z.array(id).max(20).optional(), replyToId: id.optional() }),
  z.strictObject({ type: z.literal('social.send'), urgent: z.boolean().optional(), companionId: id, conversationId: id, content: z.string().min(1).max(2000), channel: z.enum(['phone', 'face_to_face']), sourceMessageId: id.optional(), authorizationMessageId: id.optional(), replyToId: id.optional(), clientId: id,
    topicId: id.nullable().optional(), agentSource: z.strictObject({ conversationId: id, messageId: id }).optional(), executionReadset: companionExecutionReadsetSchema.optional() }),
  z.strictObject({ type: z.literal('social.job.claim'), ...agendaNativeClaim }),
  z.strictObject({ type: z.literal('social.job.read'), companionId: id, id }),
  z.strictObject({ type: z.literal('social.job.check'), companionId: id, id, leaseToken: id }),
  z.strictObject({ type: z.literal('social.job.assets.save'), companionId: id, id, leaseToken: id, taskAssets: companionTaskAssetsBlobSchema }),
  z.strictObject({ type: z.literal('social.job.preparation.save'), companionId: id, id, leaseToken: id, preparation: companionTaskPreparationBlobSchema }),
  z.strictObject({ type: z.literal('social.job.defer'), companionId: id, id, leaseToken: id, error: z.string().max(2000), retryAfterMs: z.number().int().min(1000).max(86_400_000), uncertain: z.boolean().optional() }),
  z.strictObject({ type: z.literal('social.job.control'), ...agendaNativeControl }),
  z.strictObject({ type: z.literal('social.job.game_context'), id, leaseToken: id, companionId: id, conversationId: id, sourceMessageId: id,
    sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/), recipientIds: z.array(id).max(19).optional() }),
  z.strictObject({ type: z.literal('social.job.complete'), id, leaseToken: id, text: z.string().trim().max(2000).nullable().optional(), nextRecipientId: id.optional(), workOffer: companionSocialWorkOfferSchema.optional(), shareAddress: z.boolean().optional(), expectedMemoryRevision: z.string().min(1).max(160).optional(), memoryRecall: companionSocialRecallSchema.optional(), executionReadset: companionExecutionReadsetSchema.optional() }),
  z.strictObject({ type: z.literal('social.job.progress'), id, leaseToken: id,
    phase: z.enum(['context', 'memory', 'thinking', 'waiting']), detail: z.string().max(500),
    memory: companionReplyProgressSchema.shape.memory, memoryRecall: companionSocialRecallSchema.optional() }),
  z.strictObject({ type: z.literal('social.reply.for-message'), messageId: id }),
  z.strictObject({ type: z.literal('social.reply.for-job'), jobId: id }),
  z.strictObject({ type: z.literal('social.job.fail'), id, leaseToken: id, error: z.string().max(2000), terminal: z.boolean().optional() }),
  z.strictObject({ type: z.literal('social.delegation.record'), companionId: id, conversationId: id, sourceMessageId: id,
    recipientIds: z.array(id).min(1).max(19), sharedText: z.string().trim().min(1).max(2000), visitId: id.optional(), intent: z.enum(['visit', 'message']).default('visit') }),
  z.strictObject({ type: z.literal('social.notification.claim'), ...agendaNativeClaim }),
  z.strictObject({ type: z.literal('social.notification.read'), companionId: id, id }),
  z.strictObject({ type: z.literal('social.notification.defer'), companionId: id, id, leaseToken: id, error: z.string().max(2000), retryAfterMs: z.number().int().min(1000).max(86_400_000), uncertain: z.boolean().optional() }),
  z.strictObject({ type: z.literal('social.notification.control'), ...agendaNativeControl }),
  z.strictObject({ type: z.literal('social.notification.complete'), id, leaseToken: id, text: z.string().trim().min(1).max(2000).nullable(), executionReadset: companionExecutionReadsetSchema.optional() }),
  z.strictObject({ type: z.literal('social.notification.fail'), id, leaseToken: id, error: z.string().max(2000), terminal: z.boolean().optional() }),
] as const;
export type CompanionSocialConversation = z.infer<typeof companionSocialConversationSchema>;
export type CompanionSocialConversationPage = z.infer<typeof companionSocialConversationPageSchema>;
export type CompanionSocialMessagePage = z.infer<typeof companionSocialMessagePageSchema>;
export type CompanionSocialDays = z.infer<typeof companionSocialDaysSchema>;
export type CompanionSocialJob = z.infer<typeof companionSocialJobSchema>;
export type CompanionSocialOrigin = z.infer<typeof companionSocialOriginSchema>;
export type CompanionSocialNotification = z.infer<typeof companionSocialNotificationSchema>;
