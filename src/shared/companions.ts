import { z } from 'zod';
import { companionReplyProgressSchema } from './companion-reply-progress';
import { companionReplyMemoryCommand, companionReplyMemorySchema } from './companion-reply-memory';
import { companionMemoryCorpusStateCommand, companionMemoryProbeCommand, companionMemoryProbeSchema } from './companion-memory-probe';
import { companionMemoryRetrievalSchema } from './companion-memory-retrieval';
import type { CompanionWorkspaceRequest, CompanionWorkspaceResponse } from './companion-workspace';
import { companionWorldObservationSchema } from './companion-knowledge';
import { companionContactReceiptSchema } from './companion-contact';
import { activityPublicCommands, activityTaskSchema } from './companion-activity-task';
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
import { companionRoutinePublicCommands, companionRoutineSchema, companionRoutineRuntimeSchema } from './companion-routine';
import { companionWorldPublicCommands, companionWorldStatusSchema, companionWorldSnapshotSchema, companionWorldWorkSchema, companionWorldJobSchema } from './companion-world';
import { companionSocialPublicCommands, companionSocialConversationPageSchema, companionSocialMessagePageSchema, companionSocialDaysSchema, companionSocialFlowPageSchema, companionSocialGraphSchema } from './companion-social';
import { playerProfileCommands, playerProfileSchema } from './companion-profile';
import { companionAvatarCropRequestSchema } from './companion-avatar-crop';
import { companionResetCommands, companionResetSchema } from './companion-reset';
import { companionWorkOrderPublicCommands, companionWorkOrderSchema, companionWorkOrderPageSchema } from './companion-work-order';
import { companionLifePublicCommands, companionLifeRuleSchema, companionLifeOccurrenceSchema } from './companion-life-event';

export const COMPANIONS_CHANNEL = 'worldlinebox:companions';
export const COMPANIONS_CHANGED_CHANNEL = 'worldlinebox:companions-changed';
export const COMPANION_REPLY_STREAM_CHANNEL = 'worldlinebox:companion-reply-stream';
export const companionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionReplyStreamEventSchema = z.strictObject({
  conversationId: companionIdSchema, companionId: companionIdSchema, sourceMessageId: companionIdSchema,
  messageId: companionIdSchema, step: z.number().int().min(0).max(63), attemptId: companionIdSchema,
  text: z.string().max(65536), phase: z.enum(['streaming', 'committed', 'interrupted', 'discarded', 'progress']), progress: companionReplyProgressSchema.optional(),
});
export type CompanionReplyStreamEvent = z.infer<typeof companionReplyStreamEventSchema>;
export const companionLlmSchema = z.object({
  apiFormat: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native']),
  baseUrl: z.string().trim().max(4096), model: z.string().trim().min(1).max(160), hasKey: z.boolean().optional(),
});
export const companionSchema = z.object({
  id: companionIdSchema, name: z.string().trim().min(1).max(60),
  description: z.string().max(500), persona: z.string().min(1).max(12000),
  model: z.string().max(160), avatar: z.enum(COMPANION_AVATAR_IDS),
  builtin: z.boolean(), proactive: z.boolean(), active: z.boolean().optional(), createdAt: z.string(),
  llm: companionLlmSchema.optional(),
  avatarAttachmentId: companionIdSchema.optional(),
  appearanceAttachmentId: companionIdSchema.optional(), revision: z.number().int().positive().optional(),
  availability: z.enum(['ready', 'working', 'waiting', 'offline', 'dormant']).optional(), availabilityReason: z.string().max(500).optional(), activeCount: z.number().int().nonnegative().optional(), queuedCount: z.number().int().nonnegative().optional(),
});
export type Companion = z.infer<typeof companionSchema>;
export const conversationSchema = z.object({
  id: companionIdSchema, kind: z.enum(['private', 'group']), title: z.string().max(100),
  memberIds: z.array(companionIdSchema).max(20), pinned: z.boolean(), muted: z.boolean(),
  unread: z.number().int().min(0), updatedAt: z.string(), lastMessage: z.string().max(500),
});
export type CompanionConversation = z.infer<typeof conversationSchema>;
export const attachmentSchema = z.object({ id: companionIdSchema, name: z.string().max(240),
  mime: z.string().max(120), size: z.number().int().min(0), url: z.string().max(4096).optional(), path: z.string().max(4096).optional() });
export type CompanionAttachment = z.infer<typeof attachmentSchema>;
export const messageSchema = z.object({
  id: companionIdSchema, sequence: z.number().int().min(1), conversationId: companionIdSchema,
  authorId: companionIdSchema, kind: z.enum(['text', 'notice', 'action']), content: z.string().max(65536),
  createdAt: z.string(), worldCreatedAt: z.string().optional(), replyToId: companionIdSchema.optional(),
  status: z.enum(['sent', 'failed']), actionId: companionIdSchema.optional(),
  attachments: z.array(attachmentSchema).max(10),
  worldObservation: companionWorldObservationSchema.optional(),
  memoryEvidenceOnly: z.boolean().optional(),
  replyProgress: companionReplyProgressSchema.optional(), isReplyDraft: z.boolean().optional(), replyDraft: companionLoopDraftSchema.optional(),
  segments: z.array(z.object({ text: z.string().max(65536), actionIds: z.array(companionIdSchema).max(16) })).max(64).optional(),
});
export type CompanionMessage = z.infer<typeof messageSchema>;
export const companionMessagesQuerySchema = z.object({
  conversationId: companionIdSchema, before: z.number().int().positive().optional(),
  after: z.number().int().nonnegative().optional(), around: companionIdSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const companionSearchQuerySchema = z.object({
  conversationId: companionIdSchema.optional(), query: z.string().trim().max(200).default(''),
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
  companionId: companionIdSchema, sourceMessageId: companionIdSchema, title: z.string().max(120),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  taskId: companionIdSchema.optional(), sessionId: z.string().max(200).optional(),
  result: z.string().max(65536).optional(), error: z.string().max(1000).optional(),
  executionSummary: dshRecordOverviewSchema.optional(),
  createdAt: z.string(), updatedAt: z.string(),
  startedAt: z.string().optional(), finishedAt: z.string().optional(),
  canResume: z.boolean().optional(), pid: z.number().int().positive().optional(), attempt: z.number().int().positive().optional(), attemptCreatedAt: z.string().optional(),
  stage: z.string().max(1000).optional(), events: z.array(companionActionEventSchema).max(150).optional(),
  accessMode: dshExecutionAccessModeSchema.optional(),
});
export type CompanionAction = z.infer<typeof actionSchema>;
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

export const companionDraftSchema = companionSchema.pick({ name: true, description: true, persona: true, model: true, avatar: true, proactive: true, avatarAttachmentId: true, appearanceAttachmentId: true })
  .extend({ llm: companionLlmSchema.omit({ hasKey: true }).optional() });
export type CompanionDraft = z.infer<typeof companionDraftSchema>;
export const companionsRequestSchema = z.discriminatedUnion('type', [
  companionMemoryProbeCommand, companionMemoryCorpusStateCommand,
  companionReplyMemoryCommand,
  ...activityPublicCommands,
  z.strictObject({ type: z.literal('message.guide'), id: companionIdSchema, targetSourceMessageId: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('state') }),
  ...playerProfileCommands,
  ...companionResetCommands,
  companionAvatarCropRequestSchema,
  z.strictObject({ type: z.literal('companion.add-builtin'), templateId: z.enum(COMPANION_TEMPLATE_IDS) }),
  z.strictObject({ type: z.literal('companion.create'), companion: companionDraftSchema, apiKey: z.string().max(8192).optional() }),
  z.strictObject({ type: z.literal('companion.update'), id: companionIdSchema, companion: companionDraftSchema, expectedRevision: z.number().int().positive().optional(), apiKey: z.string().max(8192).optional() }),
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
  z.strictObject({ type: z.literal('actions'), conversationId: companionIdSchema }),
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
]);
export type CompanionsRequest = z.infer<typeof companionsRequestSchema>;
export const companionsResponseSchema = z.object({
  memoryProbe: companionMemoryProbeSchema.optional(),
  memoryCorpusStamp: z.string().min(1).max(1000).optional(),
  replyMemory: companionReplyMemorySchema.optional(),
  activityTask: activityTaskSchema.optional(), activityTasks: z.array(activityTaskSchema).max(50).optional(), activityMessages: z.array(messageSchema).max(20).optional(),
  ok: z.boolean(), error: z.string().optional(), state: companionStateSchema.optional(),
  playerProfile: playerProfileSchema.optional(),
  reset: companionResetSchema.optional(),
  conversation: conversationSchema.optional(), messages: z.array(messageSchema).optional(), hasMore: z.boolean().optional(),
  hasNewer: z.boolean().optional(), searchPage: companionSearchPageSchema.optional(),
  memories: z.array(memorySchema).optional(), actions: z.array(actionSchema).optional(), attachments: z.array(attachmentSchema).optional(),
  action: actionSchema.optional(), actionPage: companionActionPageSchema.optional(),
  taskRecord: dshRecordPageSchema.optional(),
  message: messageSchema.optional(), companion: companionSchema.optional(),
  memoryPage: companionMemoryPageSchema.optional(), memoryStatus: companionMemoryStatusSchema.optional(), memoryRetrieval: companionMemoryRetrievalSchema.optional(),
  memoryProcessing: companionMemoryProcessingSchema.optional(),
  memoryLifePlan: companionMemoryLifePlanSchema.optional(),
  lifeOverview: companionLifeOverviewSchema.optional(),
  memoryTracePage: companionMemoryTracePageSchema.optional(), memoryTrace: companionMemoryTraceSchema.optional(),
  memoryContext: z.object({ text: z.string().max(1024 * 1024), revision: z.string(), profileKey: z.string(),
    evidence: z.object({ capturedAt: z.string(), corpusHash: z.string(), beforeSequence: z.number().int().nonnegative().optional() }).optional() }).optional(),
  memoryPolicies: z.array(companionMemoryPolicySchema).optional(),
  memoryRead: z.object({ memory: memorySchema, sources: z.array(messageSchema), related: z.array(memorySchema), hasMore: z.boolean(), nextSourceCursor: z.number().int().nonnegative().optional() }).optional(),
  memorySources: z.array(messageSchema).optional(), forgottenCount: z.number().int().nonnegative().optional(),
  sourceHasMore: z.boolean().optional(), sourceNextCursor: z.number().int().nonnegative().optional(),
  schedule: companionScheduleSchema.optional(), schedules: z.array(companionScheduleSchema).optional(),
  scheduleOccurrence: companionScheduleOccurrenceSchema.optional(), scheduleOccurrences: z.array(companionScheduleOccurrenceSchema).optional(),
  workOrder: companionWorkOrderSchema.optional(), workOrderPage: companionWorkOrderPageSchema.optional(),
  lifeRule: companionLifeRuleSchema.optional(), lifeRules: z.array(companionLifeRuleSchema).optional(), lifeOccurrence: companionLifeOccurrenceSchema.optional(), lifeOccurrences: z.array(companionLifeOccurrenceSchema).optional(),
  runtimeState: companionRuntimeStateSchema.optional(),
  routine: companionRoutineSchema.optional(),
  routineRuntime: companionRoutineRuntimeSchema.optional(),
  worldKnowledge: z.object({ category: z.enum(['contacts', 'scenes', 'social', 'observations']), observedAt: z.iso.datetime(), observedAtVirtual: z.iso.datetime(), internalized: z.literal(false), items: z.array(z.record(z.string(), z.unknown())).max(20), hasMore: z.boolean().optional(), evidenceMessageId: companionIdSchema }).optional(),
  worldStatus: companionWorldStatusSchema.optional(),
  socialRecipients: z.array(companionContactReceiptSchema).max(20).optional(),
  world: companionWorldSnapshotSchema.optional(),
  worldWork: companionWorldWorkSchema.optional(),
  worldJob: companionWorldJobSchema.optional(),
  socialConversationPage: companionSocialConversationPageSchema.optional(),
  socialGraph: companionSocialGraphSchema.optional(),
  socialFlowPage: companionSocialFlowPageSchema.optional(),
  socialMessagePage: companionSocialMessagePageSchema.optional(),
  socialDays: companionSocialDaysSchema.optional(),
});
export type CompanionsResponse = z.infer<typeof companionsResponseSchema>;
export interface WorldlineBoxCompanionsApi {
  workspace?(input: CompanionWorkspaceRequest): Promise<CompanionWorkspaceResponse>;
  importFiles?(files: File[]): Promise<CompanionsResponse>;
  request(input: CompanionsRequest): Promise<CompanionsResponse>;
  onChanged(listener: () => void): () => void;
  onReplyStream(listener: (event: CompanionReplyStreamEvent) => void): () => void;
}
