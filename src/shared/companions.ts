import { companionContactGroupCommands, companionContactGroupStateSchema } from './companion-contact-groups';
import { z } from 'zod';
import { companionModelUsageSchema } from './companion-model-usage';
import { companionToolPolicySchema } from './companion-tool-policy';
import { companionAgendaPublicCommands, companionAgendaResponseShape } from './companion-agenda';
import { companionMemoryRecallContextSchema } from './companion-memory-recall-context';
import { companionHostBehaviorReceiptSchema } from './companion-host-behavior';
import { companionCreationIdentitySchema, companionCreationReceiptSchema, companionCreationStatusCommand } from './companion-creation';
import { companionTaskInspectCommand, companionTaskContentCommand, companionTaskDetailSchema, companionTaskContentSchema } from './companion-task-detail';
import { companionTaskListCommand, companionTaskStopCommand, companionTaskResumeCommand, companionTaskItemSchema, companionTaskPageSchema } from './companion-task-overview';
import { companionUserStopSchema } from './companion-task-stop';
import { companionTaskConcurrencyCommands, companionTaskConcurrencySchema } from './companion-task-concurrency';
import { companionThoughtOriginSchema } from './companion-activity-thought';
import { companionKnowledgeCommandSchema, companionKnowledgeResponseSchema } from './companion-knowledge-store';
import { companionReplyProgressSchema } from './companion-reply-progress';
import { companionSocialReplyProgressEntrySchema } from './companion-social-reply';
import { companionReplyMemoryCommand, companionReplyMemorySchema } from './companion-reply-memory';
import { companionMemoryCorpusStateCommand, companionMemoryProbeCommand, companionMemoryProbeSchema } from './companion-memory-probe';
import type { CompanionMemoryProbeProgressEvent } from './companion-memory-probe-progress';
import { companionMemoryRetrievalSchema } from './companion-memory-retrieval';
import { companionMemorySelectionSchema } from './companion-memory-selection';
import { companionMemoryFileReceiptsSchema } from './companion-memory-files';
import { companionExperienceCommands, companionExperienceDayPageSchema, companionExperienceEntryPageSchema, companionExperienceDetailSchema, companionExperienceEntrySchema } from './companion-experience';
import { companionMemoryRetrievalModesSchema } from './companion-memory-modes';
import type { CompanionWorkspaceRequest, CompanionWorkspaceResponse } from './companion-workspace';
import { companionWorldObservationSchema } from './companion-knowledge';
import { companionContactReceiptSchema } from './companion-contact';
import { activityPublicCommands, activityTaskSchema, activityHistoryPageSchema } from './companion-activity-task';
import { dshRecordOverviewSchema, dshRecordQuerySchema, dshRecordPageSchema } from './dsh-task-record';
import { dshExecutionAccessModeSchema } from './dsh-access';
import { companionWorkSchema, companionLoopDraftSchema } from './companion-loop';
import { COMPANION_AVATAR_IDS, COMPANION_TEMPLATE_IDS } from './companion-template-ids';
import { companionMemorySchema, companionMemoryPageSchema, companionMemoryStatusSchema, companionMemoryPublicCommands, companionMemoryPolicySchema } from './companion-memory';
import { companionMemoryProcessingSchema } from './companion-memory-processing';
import { companionMemoryLifePlanCommand, companionMemoryLifePlanSchema } from './companion-life-plan';
import { companionLifeOverviewCommand, companionLifeOverviewSchema } from './companion-life-overview';
import { companionMemoryTraceListCommand, companionMemoryTraceInspectCommand, companionMemoryTracePageSchema, companionMemoryTraceSchema } from './companion-memory-trace';
import { companionSchedulePublicCommands, companionScheduleSchema, companionScheduleOccurrenceSchema } from './companion-schedule';
import { companionStatePublicCommands, companionRuntimeStateSchema } from './companion-state';
import { companionCharacterDevelopmentSchema } from './companion-character-development';
import { companionRoutinePublicCommands, companionRoutineSchema, companionRoutineRuntimeSchema } from './companion-routine';
import { companionWorldPublicCommands, companionWorldStatusSchema, companionWorldSnapshotSchema, companionWorldWorkSchema, companionWorldJobSchema } from './companion-world';
import { companionSocialPublicCommands, companionSocialConversationPageSchema, companionSocialMessagePageSchema, companionSocialDaysSchema, companionSocialFlowPageSchema, companionSocialGraphSchema } from './companion-social';
import { playerProfileCommands, playerProfileSchema } from './companion-profile';
import { companionAvatarCropRequestSchema } from './companion-avatar-crop';
import { companionResetCommands, companionResetSchema } from './companion-reset';
import { companionWorkOrderPublicCommands, companionWorkOrderSchema, companionWorkOrderPageSchema } from './companion-work-order';
import { companionLifePublicCommands, companionLifeRuleSchema, companionLifeOccurrenceSchema } from './companion-life-event';
import { companionTopicPublicCommands, companionTopicSchema, companionTopicStateSchema } from './companion-topic';

export const COMPANIONS_CHANNEL = 'worldlinebox:companions';
export const COMPANIONS_CHANGED_CHANNEL = 'worldlinebox:companions-changed';
export const COMPANION_REPLY_STREAM_CHANNEL = 'worldlinebox:companion-reply-stream';
/** Only a host progress update can avoid rereading authoritative chat bodies.
 * Missing, legacy or unknown notifications always require a full refresh. */
export const companionChangeEventSchema = z.strictObject({ kind: z.literal('progress') });
export type CompanionChangeEvent = z.infer<typeof companionChangeEventSchema>;
export const companionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionReplyStreamEventSchema = z.strictObject({
  conversationId: companionIdSchema, companionId: companionIdSchema, sourceMessageId: companionIdSchema,
  messageId: companionIdSchema, step: z.number().int().nonnegative().safe(), attemptId: companionIdSchema,
  text: z.string().max(65536), phase: z.enum(['streaming', 'committed', 'interrupted', 'discarded', 'progress', 'usage']), progress: companionReplyProgressSchema.optional(),
  modelUsage: companionModelUsageSchema.optional(),
  // Host-created identity of a persisted draft. Progress can mount its empty
  // bubble before an unrelated, fully validated history read returns.
  messageIdentity: z.strictObject({ sequence: z.number().int().positive().safe(), createdAt: z.string(), topicId: companionIdSchema.optional() }).optional(),
});
export type CompanionReplyStreamEvent = z.infer<typeof companionReplyStreamEventSchema>;
export const companionLlmSchema = z.object({
  apiFormat: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native']),
  baseUrl: z.string().trim().max(4096), model: z.string().trim().min(1).max(160), hasKey: z.boolean().optional(),
});
export const companionAssetImageSchema = z.object({ url: z.string().max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
export const companionAssetImagesSchema = z.object({ avatar: companionAssetImageSchema.optional(), orthographic: companionAssetImageSchema.optional() });
export type CompanionAssetImages = z.infer<typeof companionAssetImagesSchema>;
export const companionSchema = z.object({
  templateId: companionIdSchema.optional(),
  id: companionIdSchema, name: z.string().trim().min(1).max(60),
  description: z.string().max(500), persona: z.string().min(1).max(12000),
  model: z.string().max(160), avatar: z.enum(COMPANION_AVATAR_IDS),
  builtin: z.boolean(), proactive: z.boolean(), active: z.boolean().optional(), createdAt: z.string(),
  llm: companionLlmSchema.optional(),
  inputMode: z.enum(['steer', 'queue']).optional(),
  avatarAttachmentId: companionIdSchema.optional(),
  appearanceAttachmentId: companionIdSchema.optional(), revision: z.number().int().positive().optional(),
  assetProfileRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(), assetPromptRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  assetProfileError: z.string().max(500).optional(),
  assetImages: companionAssetImagesSchema.optional(),
  availability: z.enum(['ready', 'working', 'waiting', 'offline', 'dormant']).optional(), availabilityReason: z.string().max(500).optional(), activeCount: z.number().int().nonnegative().optional(), queuedCount: z.number().int().nonnegative().optional(),
});
export type Companion = z.infer<typeof companionSchema>;
export const conversationSchema = z.object({
  id: companionIdSchema, kind: z.enum(['private', 'group']), title: z.string().max(100),
  memberIds: z.array(companionIdSchema).max(20), pinned: z.boolean(), muted: z.boolean(),
  unread: z.number().int().min(0), updatedAt: z.string(), lastMessage: z.string().max(500),
  activeTopicId: companionIdSchema.optional(),
  defaultTopicId: companionIdSchema.optional(),
  peerOnly: z.boolean().optional(),
});
export type CompanionConversation = z.infer<typeof conversationSchema>;
export const attachmentSchema = z.object({ id: companionIdSchema, name: z.string().max(240),
  mime: z.string().max(120), size: z.number().int().min(0), url: z.string().max(4096).optional(), path: z.string().max(4096).optional() });
export type CompanionAttachment = z.infer<typeof attachmentSchema>;
export const messageSchema = z.object({
  id: companionIdSchema, sequence: z.number().int().min(1), conversationId: companionIdSchema,
  revision: z.number().int().positive().optional(),
  authorId: companionIdSchema, kind: z.enum(['text', 'notice', 'action']), content: z.string().max(65536),
  createdAt: z.string(), worldCreatedAt: z.string().optional(), worldTimeZone: z.string().optional(), replyToId: companionIdSchema.optional(),
  topicId: companionIdSchema.optional(),
  status: z.enum(['sent', 'failed']), actionId: companionIdSchema.optional(),
  attachments: z.array(attachmentSchema).max(10),
  worldObservation: companionWorldObservationSchema.optional(),
  hostBehavior: companionHostBehaviorReceiptSchema.optional(),
  memoryEvidenceOnly: z.boolean().optional(),
  toolPolicy: companionToolPolicySchema.optional(),
  sourceUnavailable: z.literal('execution_source_changed').optional(),
  modelUsage: companionModelUsageSchema.optional(),
  audience: z.enum(['conversation', 'agenda']).optional(),
  replyProgress: companionReplyProgressSchema.optional(), isReplyDraft: z.boolean().optional(), replyDraft: companionLoopDraftSchema.optional(),
  segments: z.array(z.object({ text: z.string().max(65536), actionIds: z.array(companionIdSchema).max(16) })).optional(),
});
export type CompanionMessage = z.infer<typeof messageSchema>;
export const companionMessagesQuerySchema = z.object({
  conversationId: companionIdSchema, before: z.number().int().positive().optional(),
  topicId: companionIdSchema.nullable().optional(),
  after: z.number().int().nonnegative().optional(), around: companionIdSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const companionSearchQuerySchema = z.object({
  conversationId: companionIdSchema.optional(), query: z.string().trim().max(200).default(''),
  topicId: companionIdSchema.nullable().optional(),
  authorId: companionIdSchema.optional(), category: z.enum(['all', 'images', 'files', 'links']).default('all'),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  before: z.number().int().positive().optional(), snapshot: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).default(30),
  compact: z.boolean().optional(),
});
export type CompanionSearchQuery = z.input<typeof companionSearchQuerySchema>;
export const companionSearchHitSchema = messageSchema.pick({ id: true, sequence: true, conversationId: true, authorId: true, createdAt: true, attachments: true })
  .extend({ excerpt: z.string().max(600) });
export type CompanionSearchHit = z.infer<typeof companionSearchHitSchema>;
export const companionSearchPageSchema = z.object({
  items: z.array(companionSearchHitSchema).max(100), hasMore: z.boolean(), nextBefore: z.number().int().positive().optional(),
  snapshot: z.number().int().nonnegative(), indexReady: z.boolean(),
});
export type CompanionSearchPage = z.infer<typeof companionSearchPageSchema>;
export const memorySchema = companionMemorySchema;
export type CompanionMemory = z.infer<typeof memorySchema>;
export const companionActionEventSchema = z.object({ sequence: z.number().int().min(0), type: z.string().max(100),
  summary: z.string().max(1000), toolName: z.string().max(160).optional(), receivedAt: z.string(),
  content: z.string().max(16000).optional(), contentKind: z.enum(['input', 'output', 'message']).optional(), callId: z.string().max(200).optional(), streamId: z.string().max(100).optional(), outputState: z.enum(['draft', 'committed', 'abandoned']).optional() });
export type CompanionActionEvent = z.infer<typeof companionActionEventSchema>;
export const actionSchema = z.object({ id: companionIdSchema, conversationId: companionIdSchema,
  parentMessageId: companionIdSchema.optional(), toolCallId: z.string().max(240).optional(), loopStep: z.number().int().nonnegative().optional(),
  scheduleOccurrenceId: companionIdSchema.optional(), workOrderId: companionIdSchema.optional(),
  authorizationGrantId: companionIdSchema.optional(),
  companionId: companionIdSchema, sourceMessageId: companionIdSchema.optional(), title: z.string().max(120),
  thought: companionThoughtOriginSchema.optional(),
  capability: z.strictObject({ name: z.string().min(1).max(100), callId: z.string().min(1).max(200), invocationId: z.string().min(1).max(200),
    agendaRunId: companionIdSchema.optional(), inputHash: z.string().regex(/^[a-f0-9]{64}$/u), audience: z.enum(['conversation', 'agenda']).optional() }).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  taskId: companionIdSchema.optional(), sessionId: z.string().max(200).optional(),
  result: z.string().max(65536).optional(), error: z.string().max(1000).optional(), stop: companionUserStopSchema.optional(),
  executionSummary: dshRecordOverviewSchema.optional(),
  createdAt: z.string(), updatedAt: z.string(),
  startedAt: z.string().optional(), finishedAt: z.string().optional(),
  canResume: z.boolean().optional(), pid: z.number().int().positive().optional(), attempt: z.number().int().positive().optional(), attemptCreatedAt: z.string().optional(),
  contentAvailable: z.boolean().optional(),
  stage: z.string().max(1000).optional(), events: z.array(companionActionEventSchema).max(150).optional(),
  accessMode: dshExecutionAccessModeSchema.optional(),
});
export type CompanionAction = z.infer<typeof actionSchema>;
/** Visible chat cards, independent of the paged task-history browser. */
export const companionActionReadWindowSchema = z.object({
  ids: z.array(companionIdSchema).max(200).optional(), includeOngoing: z.boolean().optional(),
});
export const companionActionPageQuerySchema = z.object({
  conversationId: companionIdSchema, companionId: companionIdSchema.optional(),
  before: z.object({ createdAt: z.iso.datetime(), id: companionIdSchema }).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type CompanionActionPageQuery = z.input<typeof companionActionPageQuerySchema>;
export const companionActionPageSchema = z.object({
  items: z.array(actionSchema).max(50), hasMore: z.boolean(),
  nextCursor: z.object({ createdAt: z.iso.datetime(), id: companionIdSchema }).optional(),
  total: z.number().int().nonnegative(),
  owners: z.array(z.object({ companionId: companionIdSchema, name: z.string().max(60), count: z.number().int().nonnegative() })),
});
export type CompanionActionPage = z.infer<typeof companionActionPageSchema>;
export const companionActivitySchema = z.object({ companionId: companionIdSchema, conversationId: companionIdSchema,
  sourceMessageId: companionIdSchema.optional(),
  status: z.enum(['waiting', 'thinking', 'working']), stage: z.string().max(500).optional(), startedAt: z.string().optional() });
export type CompanionActivity = z.infer<typeof companionActivitySchema>;
export const companionReplyRecoverySchema = z.object({ conversationId: companionIdSchema, sourceMessageId: companionIdSchema,
  dispatcher: z.literal('queue').default('queue'),
  status: z.enum(['pending', 'interrupted', 'done', 'cancelled']), delivery: z.enum(['auto', 'steer', 'queue', 'parallel', 'chat']),
  completedIds: z.array(companionIdSchema).max(20), updatedAt: z.string() });
export type CompanionReplyRecovery = z.infer<typeof companionReplyRecoverySchema>;
export const companionStateSchema = z.object({ companions: z.array(companionSchema), conversations: z.array(conversationSchema), resetJobs: z.array(companionResetSchema).optional(),
  activities: z.array(companionActivitySchema), configured: z.boolean(), recoveries: z.array(companionReplyRecoverySchema).optional(), queue: z.array(companionWorkSchema).optional(), playerProfile: playerProfileSchema.optional() });
export type CompanionState = z.infer<typeof companionStateSchema>;

/** Progress polling carries no canonical identity, images, message bodies or
 * received world snapshots. Those remain on the authoritative state path. */
export const companionRuntimeProgressSchema = z.strictObject({
  queue: z.array(companionWorkSchema.pick({ id: true, conversationId: true, sourceMessageId: true, companionId: true,
    messageId: true, status: true, ordinal: true, proactive: true, inputMode: true, startedAt: true, createdAt: true, updatedAt: true })),
  activities: z.array(companionActivitySchema),
  owners: z.array(z.strictObject({ companionId: companionIdSchema, activeCount: z.number().int().nonnegative(), queuedCount: z.number().int().nonnegative(),
    activityCount: z.number().int().nonnegative(), waitingCount: z.number().int().nonnegative(),
    availability: z.enum(['ready', 'working', 'waiting']), availabilityReason: z.string().max(500).optional() })),
});
export type CompanionRuntimeProgress = z.infer<typeof companionRuntimeProgressSchema>;

export const companionDraftSchema = companionSchema.pick({ name: true, description: true, persona: true, model: true, avatar: true, proactive: true, avatarAttachmentId: true, appearanceAttachmentId: true, inputMode: true })
  .extend({ llm: companionLlmSchema.omit({ hasKey: true }).optional() });
export type CompanionDraft = z.infer<typeof companionDraftSchema>;
export const companionsRequestSchema = z.discriminatedUnion('type', [
  ...companionAgendaPublicCommands,
  z.strictObject({ type: z.literal('agenda.observation.sources'), companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('agenda.capacity.read'), companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('agenda.capacity.configure'), companionId: companionIdSchema, limit: z.number().int().min(1).max(10) }),
  ...companionContactGroupCommands,
  ...companionTaskConcurrencyCommands,
  companionTaskListCommand, companionTaskStopCommand, companionTaskResumeCommand, companionTaskInspectCommand, companionTaskContentCommand,
  ...companionExperienceCommands,
  companionMemoryProbeCommand, companionMemoryCorpusStateCommand,
  companionReplyMemoryCommand,
  ...activityPublicCommands,
  companionKnowledgeCommandSchema,
  ...companionTopicPublicCommands,
  z.strictObject({ type: z.literal('message.guide'), id: companionIdSchema, targetSourceMessageId: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('state'), readiness: z.literal('navigation').optional() }),
  z.strictObject({ type: z.literal('state.progress') }),
  ...playerProfileCommands,
  ...companionResetCommands,
  companionAvatarCropRequestSchema,
  companionCreationStatusCommand,
  companionCreationIdentitySchema.extend({ type: z.literal('companion.add-builtin'), templateId: z.enum(COMPANION_TEMPLATE_IDS) }).strict(),
  companionCreationIdentitySchema.extend({ type: z.literal('companion.create'), companion: companionDraftSchema, apiKey: z.string().max(8192).optional() }).strict(),
  z.strictObject({ type: z.literal('companion.update'), id: companionIdSchema, companion: companionDraftSchema, expectedRevision: z.number().int().positive().optional(), expectedAssetProfileRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(), apiKey: z.string().max(8192).optional() }),
  z.strictObject({ type: z.literal('companion.set-active'), id: companionIdSchema, active: z.boolean(), expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal('companion.delete'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('conversation.open'), companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('conversation.create-group'), title: z.string().trim().max(100).default(''), memberIds: z.array(companionIdSchema).min(1).max(20) }),
  z.strictObject({ type: z.literal('conversation.update'), id: companionIdSchema, title: z.string().trim().max(100).optional(), memberIds: z.array(companionIdSchema).min(1).max(20).optional(), pinned: z.boolean().optional(), muted: z.boolean().optional() }),
  z.strictObject({ type: z.literal('conversation.read'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('conversation.delete'), id: companionIdSchema, mode: z.enum(['hide', 'dissolve']) }),
  z.strictObject({ type: z.literal('conversation.reopen'), id: companionIdSchema }),
  companionMessagesQuerySchema.extend({ type: z.literal('messages') }).strict(),
  z.strictObject({ type: z.literal('message.get'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('message.send'), conversationId: companionIdSchema, content: z.string().max(16000), replyToId: companionIdSchema.optional(), attachmentIds: z.array(companionIdSchema).max(10).optional(), clientId: companionIdSchema,
    toolPolicy: companionToolPolicySchema.optional(),
    topicId: companionIdSchema.nullable().optional(),
    targetSourceMessageId: companionIdSchema.optional(), priority: z.enum(['normal', 'urgent']).optional(),
    delivery: z.enum(['auto', 'steer', 'queue', 'parallel', 'chat']).optional(), targetActionId: companionIdSchema.optional() }),
  companionSearchQuerySchema.extend({ type: z.literal('message.search') }).strict(),
  z.strictObject({ type: z.literal('reply.retry'), conversationId: companionIdSchema, workId: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('reply.cancel'), conversationId: companionIdSchema, workId: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('reply.resume'), conversationId: companionIdSchema }),
  z.strictObject({ type: z.literal('memory.list'), companionId: companionIdSchema }),
  ...companionMemoryPublicCommands,
  companionMemoryLifePlanCommand,
  companionLifeOverviewCommand,
  companionMemoryTraceListCommand, companionMemoryTraceInspectCommand,
  ...companionSchedulePublicCommands,
  ...companionWorkOrderPublicCommands,
  ...companionLifePublicCommands,
  ...companionStatePublicCommands,
  ...companionRoutinePublicCommands,
  ...companionWorldPublicCommands,
  ...companionSocialPublicCommands,
  z.strictObject({ type: z.literal('memory.save'), companionId: companionIdSchema, conversationId: companionIdSchema.optional(), id: companionIdSchema.optional(), content: z.string().trim().min(1).max(65536), sourceMessageId: companionIdSchema.optional(), expectedVersion: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal('memory.delete'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('actions'), conversationId: companionIdSchema, ...companionActionReadWindowSchema.shape }),
  companionActionPageQuerySchema.extend({ type: z.literal('actions.page') }).strict(),
  z.strictObject({ type: z.literal('action.get'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('action.record'), id: companionIdSchema, query: dshRecordQuerySchema }),
  z.strictObject({ type: z.literal('action.run'), conversationId: companionIdSchema, companionId: companionIdSchema, sourceMessageId: companionIdSchema, title: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(16000) }),
  z.strictObject({ type: z.literal('action.cancel'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('action.resume'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('action.terminate'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('attachment.pick'), kind: z.literal('image').optional(), purpose: z.enum(['avatar', 'appearance']).optional() }),
  z.strictObject({ type: z.literal('attachment.import'), paths: z.array(z.string().min(1).max(32768)).min(1).max(10) }),
  z.strictObject({ type: z.literal('attachment.clipboard') }),
  z.strictObject({ type: z.literal('attachment.open'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('attachment.launch'), id: companionIdSchema }),
]);
export type CompanionsRequest = z.infer<typeof companionsRequestSchema>;
export const companionsResponseSchema = z.object({
  ...companionAgendaResponseShape,
  observationSources: z.array(z.strictObject({ id: z.string(), title: z.string(), displayId: z.string().optional() })).optional(),
  agendaCapacity: z.strictObject({ companionId: companionIdSchema, limit: z.number().int().min(1).max(10), active: z.number().int().nonnegative(), queued: z.number().int().nonnegative() }).optional(),
  contactGroups: companionContactGroupStateSchema.optional(),
  taskConcurrency: companionTaskConcurrencySchema.optional(),
  taskPage: companionTaskPageSchema.optional(), task: companionTaskItemSchema.optional(),
  taskDetail: companionTaskDetailSchema.optional(), taskContent: companionTaskContentSchema.optional(),
  experienceDays: companionExperienceDayPageSchema.optional(), experiencePage: companionExperienceEntryPageSchema.optional(),
  experienceDetail: companionExperienceDetailSchema.optional(), experienceEntry: companionExperienceEntrySchema.optional(),
  memoryKnowledge: companionKnowledgeResponseSchema.optional(),
  topic: companionTopicSchema.optional(), topics: z.array(companionTopicSchema).max(500).optional(), topicState: companionTopicStateSchema.optional(),
  topicNextCursor: z.number().int().positive().optional(),
  memoryProbe: companionMemoryProbeSchema.optional(),
  memoryCorpusStamp: z.string().min(1).max(1000).optional(),
  memoryRecallAuthorityStamp: z.string().min(1).max(1000).optional(),
  replyMemory: companionReplyMemorySchema.optional(),
  activityTask: activityTaskSchema.optional(), activityTasks: z.array(activityTaskSchema).max(50).optional(), activityHistory: activityHistoryPageSchema.optional(), activityMessages: z.array(messageSchema).max(100).optional(),
  activityMessageOrigins: z.array(z.strictObject({ messageId: companionIdSchema, sourceMessageId: companionIdSchema, deliveryClientId: companionIdSchema,
    conversationId: companionIdSchema, topicId: companionIdSchema.optional(), chainId: companionIdSchema })).max(100).optional(),
  ok: z.boolean(), error: z.string().optional(), executionPaused: z.boolean().optional(), state: companionStateSchema.optional(),
  runtimeProgress: companionRuntimeProgressSchema.optional(),
  playerProfile: playerProfileSchema.optional(),
  reset: companionResetSchema.optional(),
  creation: companionCreationReceiptSchema.optional(),
  conversation: conversationSchema.optional(), messages: z.array(messageSchema).optional(), hasMore: z.boolean().optional(),
  hasNewer: z.boolean().optional(), searchPage: companionSearchPageSchema.optional(),
  memories: z.array(memorySchema).optional(), actions: z.array(actionSchema).optional(), attachments: z.array(attachmentSchema).optional(),
  action: actionSchema.optional(), actionPage: companionActionPageSchema.optional(),
  taskRecord: dshRecordPageSchema.optional(),
  message: messageSchema.optional(), companion: companionSchema.optional(),
  memoryPage: companionMemoryPageSchema.optional(), memoryStatus: companionMemoryStatusSchema.optional(), memoryRetrieval: companionMemoryRetrievalSchema.optional(), memoryRetrievalModes: companionMemoryRetrievalModesSchema.optional(),
  memorySelection: companionMemorySelectionSchema.optional(),
  memoryProcessing: companionMemoryProcessingSchema.optional(),
  memoryLifePlan: companionMemoryLifePlanSchema.optional(),
  lifeOverview: companionLifeOverviewSchema.optional(),
  memoryTracePage: companionMemoryTracePageSchema.optional(), memoryTrace: companionMemoryTraceSchema.optional(),
  memoryContext: companionMemoryRecallContextSchema.optional(),
  memoryPolicies: z.array(companionMemoryPolicySchema).optional(),
  memoryRead: z.object({ memory: memorySchema, sources: z.array(messageSchema), related: z.array(memorySchema), hasMore: z.boolean(), nextSourceCursor: z.number().int().nonnegative().optional(),
    fileReceipts: companionMemoryFileReceiptsSchema.optional() }).optional(),
  memorySources: z.array(messageSchema).optional(), forgottenCount: z.number().int().nonnegative().optional(),
  sourceHasMore: z.boolean().optional(), sourceNextCursor: z.number().int().nonnegative().optional(),
  schedule: companionScheduleSchema.optional(), schedules: z.array(companionScheduleSchema).optional(),
  scheduleOccurrence: companionScheduleOccurrenceSchema.optional(), scheduleOccurrences: z.array(companionScheduleOccurrenceSchema).optional(),
  workOrder: companionWorkOrderSchema.optional(), workOrderPage: companionWorkOrderPageSchema.optional(),
  lifeRule: companionLifeRuleSchema.optional(), lifeRules: z.array(companionLifeRuleSchema).optional(), lifeOccurrence: companionLifeOccurrenceSchema.optional(), lifeOccurrences: z.array(companionLifeOccurrenceSchema).optional(),
  runtimeState: companionRuntimeStateSchema.optional(),
  characterDevelopment: companionCharacterDevelopmentSchema.optional(),
  characterDevelopmentScopes: z.strictObject({ items: z.array(z.strictObject({ companionId: companionIdSchema, conversationId: companionIdSchema,
    generation: z.number().int().positive(), cursor: companionIdSchema.optional() })).max(16), hasMore: z.boolean(),
    nextCursor: z.strictObject({ companionId: companionIdSchema, conversationId: companionIdSchema }).optional() }).optional(),
  characterDevelopmentScopeAcknowledged: z.boolean().optional(),
  routine: companionRoutineSchema.optional(),
  routineRuntime: companionRoutineRuntimeSchema.optional(),
  worldKnowledge: z.object({ category: z.enum(['contacts', 'people', 'scenes', 'social', 'observations', 'topics']), observedAt: z.iso.datetime(), observedAtVirtual: z.iso.datetime(), internalized: z.literal(false), items: z.array(z.record(z.string(), z.unknown())).max(20), hasMore: z.boolean().optional(), evidenceMessageId: companionIdSchema }).optional(),
  worldStatus: companionWorldStatusSchema.optional(),
  socialRecipients: z.array(companionContactReceiptSchema).max(20).optional(),
  world: companionWorldSnapshotSchema.optional(),
  worldWork: companionWorldWorkSchema.optional(),
  worldJob: companionWorldJobSchema.optional(),
  socialConversationPage: companionSocialConversationPageSchema.optional(),
  socialGraph: companionSocialGraphSchema.optional(),
  socialFlowPage: companionSocialFlowPageSchema.optional(),
  socialMessagePage: companionSocialMessagePageSchema.optional(),
  socialReplyProgress: z.array(companionSocialReplyProgressEntrySchema).max(50).optional(),
  socialDays: companionSocialDaysSchema.optional(),
});
export type CompanionsResponse = z.infer<typeof companionsResponseSchema>;
export interface WorldlineBoxCompanionsApi {
  workspace?(input: CompanionWorkspaceRequest): Promise<CompanionWorkspaceResponse>;
  importFiles?(files: File[]): Promise<CompanionsResponse>;
  request(input: CompanionsRequest): Promise<CompanionsResponse>;
  onChanged(listener: (change?: CompanionChangeEvent) => void): () => void;
  onReplyStream(listener: (event: CompanionReplyStreamEvent) => void): () => void;
  onMemoryProbeProgress?(listener: (event: CompanionMemoryProbeProgressEvent) => void): () => void;
}
