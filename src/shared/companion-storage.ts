import { companionTopicCompactionCommands, companionTopicCompactionJobSchema } from './companion-topic-compaction-jobs';
import { companionContactGroupCommands } from './companion-contact-groups';
import { companionRecoveryWorkspaceCommands, companionRecoveryReviewCommand, companionRecoveryReviewPageCommand, companionRecoveryResultSchema } from './companion-recovery';
import { companionGrowthStorageCommands, companionGrowthGoalSchema } from './companion-cognition';
import { companionAgendaStorageCommands } from './companion-agenda';
import { companionCreationIdentitySchema, companionCreationStatusCommand, companionCreationReceiptSchema } from './companion-creation';
import { COMPANION_TEMPLATE_IDS } from './companion-template-ids';
import { companionRegistryStorageCommands, companionRegistryStorageResponseShape } from './companion-registry-storage';
import { COMPANION_ATTACHMENT_SNAPSHOT_MAX_BYTES } from './companion-media';
import { companionInterruptionCommands, companionInterruptionSchema } from './companion-interruption';
import { companionTaskStopStorageCommands, companionTaskStopReceiptSchema } from './companion-task-stop';
import { companionTaskConcurrencyCommands } from './companion-task-concurrency';
import { companionTaskControlStopCommand, companionTaskControlResultSchema } from './companion-task-control';
import { companionTaskPageStorageCommand, companionTaskResolveStorageCommand } from './companion-task-overview';
import { companionTaskInspectCommand, companionTaskContentCommand, companionTaskTimelineRecordCommand } from './companion-task-detail';
import { companionAgentRunCommands, companionAgentRunSchema } from './companion-agent-run';
import { companionExecutionReadsetSchema, companionFrozenMemoryDependencySchema } from './companion-execution-evidence';
import { companionPreparedRecallReferenceSchema } from './companion-prepared-recall';
import { companionThoughtAuthorizationSchema } from './companion-activity-thought';
import { companionExperienceCommands, companionExperiencePublishSchema } from './companion-experience';
import { companionKnowledgeCommandSchema } from './companion-knowledge-store';
import { companionSocialReplyReceiptSchema } from './companion-social-reply';
import { z } from 'zod';
import { companionToolPolicySchema } from './companion-tool-policy';
import { companionJobCommands, companionJobDispositionSchema, companionJobPageSchema } from './companion-job-control';
import { companionDshMailboxCommands, companionDshMailSchema } from './companion-dsh-background';
import { companionMemoryInvestigationSchema } from './companion-memory-investigation';
import { companionMemoryHistoryDescriptorSchema, companionMemoryHistoryOutboxSchema } from './companion-memory-history';
import { companionMemoryFileInspectCommand, companionMemoryFileReadinessSchema, companionMemoryFileStateCommand, companionMemoryFileStateSchema } from './companion-memory-file-readiness';
import { companionWorldProposalSchema } from './companion-world-proposals';
import { companionMemoryProjectionCommands, companionMemoryProjectionStateSchema, companionMemoryProjectionPageSchema } from './companion-memory-projection';
import { companionLearningStorageCommands, companionLearningStatusSchema, companionLearningJobSchema,
  companionLearningAssetSnapshotSchema, companionLearningAssetValidationSchema } from './companion-learning';
import { companionLearningGoalStorageCommands, companionLearningGoalSchema, companionLearningGoalPageSchema, companionLearningGoalRoundPageSchema, companionLearningGoalJobSchema } from './companion-learning-goals';
import { companionWorldSleepPlanSchema } from './companion-life-plan';
import { companionLifeOverviewReadCommand, companionLifeOverviewContextSchema } from './companion-life-overview';
import { companionMemoryTraceListCommand, companionMemoryTraceInspectCommand } from './companion-memory-trace';
import { companionDocumentCatalogCommands, companionDocumentCatalogPageSchema } from './companion-document-catalog';
import { activityStorageCommands, activityMemoryIntentSchema, activityPlanningStateSchema, activityHandoffSchema, activityPassiveRecallSchema, activityAgendaPageSchema } from './companion-activity-task';
import { companionMemoryTagCommands, companionMemoryTagJobSchema, companionMemoryTagStatusSchema } from './companion-memory-tags';

import {
  actionSchema, attachmentSchema, companionDraftSchema, companionIdSchema, messageSchema, memorySchema,
  companionsResponseSchema, companionActionPageQuerySchema, companionActionReadWindowSchema, companionReplyRecoverySchema, companionMessagesQuerySchema, companionSearchQuerySchema,
} from './companions';
import { dshTaskRecordSchema } from './dsh-tasks';
import { dshTaskSpecSchema } from './dsh-task-spec';
import { companionLoopCheckpointSchema, companionWorkSchema } from './companion-loop';
import { companionMemoryStorageCommands, companionMemoryJobSchema, companionMemoryDomainSchema, companionMemoryOutboxSchema, companionMemorySourceOutboxSchema, companionMemorySnapshotSchema, companionMemoryPolicySchema, companionMemoryProhibitionSchema, companionMemoryDescriptorSchema } from './companion-memory';
import { companionMemoryLibraryIndexStateSchema, companionMemoryLibraryIndexPageSchema, companionMemoryLibraryChangesSchema,
  companionMemoryLifecycleStateSchema, companionMemoryLifecycleChangesSchema, companionMemoryCaptureContributionsSchema, companionCaptureProposalSchema } from './companion-memory';
import { companionScheduleStorageCommands, companionScheduleOccurrenceSchema, companionScheduleSchema } from './companion-schedule';
import { companionStateStorageCommands, companionRuntimeStateSchema } from './companion-state';
import { companionRoutineStorageCommands } from './companion-routine';
import { companionWorldStorageCommands, companionWorldSnapshotSchema, companionWorldWorkSchema, companionWorldJobSchema, companionWorldTimeSchema } from './companion-world';
import { companionSocialStorageCommands, companionSocialConversationSchema, companionSocialMessageSchema, companionSocialJobSchema, companionSocialNotificationSchema, companionSocialGameContextSchema, companionSocialProgressEvidenceSchema } from './companion-social';
import { playerProfileCommands } from './companion-profile';
import { companionResetCommands, companionResetCleanupStageSchema } from './companion-reset';
import { companionWorkOrderStorageCommands, companionWorkOrderClaimSchema } from './companion-work-order';
import { companionLifeStorageCommands } from './companion-life-event';
import { companionTopicStorageCommands } from './companion-topic';
import { companionCollaborationStorageCommands, companionCollaborationGrantSchema } from './companion-collaboration';

export const appendCompanionMessageSchema = z.strictObject({
  conversationId: companionIdSchema, authorId: companionIdSchema,
  topicId: companionIdSchema.nullable().optional(),
  content: z.string().max(65536), clientId: companionIdSchema.optional(),
  kind: z.enum(['text', 'notice', 'action']).default('text'),
  replyToId: companionIdSchema.optional(), actionId: companionIdSchema.optional(),
  attachmentIds: z.array(companionIdSchema).max(10).default([]),
  status: z.enum(['sent', 'failed']).default('sent'),
  replyDirective: z.enum(['auto', 'steer', 'queue', 'parallel', 'chat', 'none']).optional(),
  replyCompletion: z.object({ sourceMessageId: companionIdSchema, companionId: companionIdSchema }).optional(),
  loopStep: z.number().int().nonnegative().optional(),
  executionReadset: companionExecutionReadsetSchema.optional(),
  toolPolicy: companionToolPolicySchema.optional(),
});
export type AppendCompanionMessage = z.input<typeof appendCompanionMessageSchema>;

// File ownership is assigned by Main after its native file picker copies a file.
// The worker accepts only this ID-derived relative name, never a renderer path.
export const storedCompanionAttachmentSchema = z.strictObject({
  attachment: attachmentSchema.omit({ url: true }),
  relativePath: z.string().regex(/^attachments\/[a-zA-Z0-9_-]{1,100}(?:\.[a-zA-Z0-9]{1,16})?$/),
  sourcePath: z.string().max(4096).optional(),
});
export type StoredCompanionAttachment = z.infer<typeof storedCompanionAttachmentSchema>;

const fileToolResultKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);
// Durable results contain metadata and managed IDs, never an image payload.
const fileToolResultSchema = z.string().max(1024 * 1024).refine(value => {
  if (new TextEncoder().encode(value).byteLength > 1024 * 1024) return false;
  try {
    const result: unknown = JSON.parse(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const pending: unknown[] = [result];
    while (pending.length) {
      const item = pending.pop();
      if (!item || typeof item !== 'object') continue;
      if (Object.hasOwn(item, 'base64')) return false;
      pending.push(...Object.values(item));
    }
    return true;
  } catch { return false; }
}, '文件工具结果必须是最多 1 MiB、不含图像像素的 JSON 元数据。');
const fileToolAttachmentSchema = storedCompanionAttachmentSchema.refine(value => !value.attachment.path && (value.sourcePath
  ? value.attachment.size <= Number.MAX_SAFE_INTEGER
  : value.attachment.size <= COMPANION_ATTACHMENT_SNAPSHOT_MAX_BYTES), '文件快照超过 256 MiB 时必须登记原文件引用。');

export const createCompanionActionSchema = actionSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type CreateCompanionAction = z.infer<typeof createCompanionActionSchema>;
export const companionTaskCheckpointSchema = z.strictObject({ prompt: z.string().min(1).max(65536),
  memoryPreparation: companionPreparedRecallReferenceSchema.optional(),
  feedbackRecall: activityPassiveRecallSchema.extend({ memories: z.array(memorySchema).max(100), sources: z.array(messageSchema).max(100) }).optional(),
  dshTask: dshTaskSpecSchema.optional(),
  activityThought: companionThoughtAuthorizationSchema.optional(),
  executionReadset: companionExecutionReadsetSchema.optional(),
  waitForActionIds: z.array(companionIdSchema).max(100).default([]),
  execution: dshTaskRecordSchema.optional(), supplements: z.array(z.object({ id: companionIdSchema, content: z.string().max(16000), mode: z.enum(['steer', 'queue']) })).max(100).default([]) });
export type CompanionTaskCheckpoint = z.infer<typeof companionTaskCheckpointSchema>;
export const updateCompanionActionSchema = actionSchema.pick({ status: true, taskId: true, sessionId: true, result: true, error: true, stage: true, events: true, accessMode: true, startedAt: true, finishedAt: true, pid: true, executionSummary: true }).partial();
export type UpdateCompanionAction = z.infer<typeof updateCompanionActionSchema>;
export const saveCompanionMemorySchema = z.strictObject({ companionId: companionIdSchema, conversationId: companionIdSchema,
  autoTags: z.boolean().optional(),
  id: companionIdSchema.optional(), content: z.string().trim().min(1).max(65536), tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  operationId: companionIdSchema.optional(), diaryName: z.string().trim().min(1).max(160).optional(),
  expectedProhibitionRevision: z.string().min(1).max(128).optional(),
  sourceMessageId: companionIdSchema.optional(), expectedVersion: z.number().int().positive().optional() });
export type SaveCompanionMemory = z.input<typeof saveCompanionMemorySchema>;
export const companionProactiveStateSchema = z.strictObject({
  lastAttemptAt: z.string().optional(),
  lastSentAt: z.string().optional(), lastUserMessageId: companionIdSchema.optional(),
  date: z.string().optional(), count: z.number().int().nonnegative(),
});
export type CompanionProactiveState = z.infer<typeof companionProactiveStateSchema>;

export const companionStorageCommandSchema = z.discriminatedUnion('type', [
  ...companionAgendaStorageCommands,
  ...companionRecoveryWorkspaceCommands, companionRecoveryReviewCommand, companionRecoveryReviewPageCommand,
  ...companionJobCommands,
  ...companionTopicCompactionCommands,
  ...companionRegistryStorageCommands,
  ...companionGrowthStorageCommands,
  ...companionContactGroupCommands,
  ...companionMemoryProjectionCommands,
  companionTaskControlStopCommand,
  companionTaskPageStorageCommand, companionTaskResolveStorageCommand, companionTaskInspectCommand, companionTaskContentCommand, companionTaskTimelineRecordCommand,
  ...companionTaskStopStorageCommands,
  ...companionTaskConcurrencyCommands,
  z.strictObject({ type: z.literal('companion.assets.initialized'), companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('companion.assets.mark-initialized'), companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('companion.assets.portrait.initialized'), companionId: companionIdSchema, role: z.enum(['avatar', 'orthographic']) }),
  z.strictObject({ type: z.literal('companion.assets.portrait.mark-initialized'), companionId: companionIdSchema, role: z.enum(['avatar', 'orthographic']) }),
  z.strictObject({ type: z.literal('memory.frozen.valid'), companionId: companionIdSchema, conversationId: companionIdSchema,
    beforeSequence: z.number().int().nonnegative().safe().optional(), memories: z.array(companionFrozenMemoryDependencySchema).max(100) }),
  z.strictObject({ type: z.literal('tasks.capacity.claim-action'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('activity.port.adopt_candidate'), companionId: companionIdSchema,
    conversationId: companionIdSchema, topicId: companionIdSchema }),
  ...companionExperienceCommands,
  companionExperiencePublishSchema,
  ...companionAgentRunCommands,
  companionKnowledgeCommandSchema,
  ...companionLearningStorageCommands,
  ...companionLearningGoalStorageCommands,
  companionLifeOverviewReadCommand,
  companionMemoryTraceListCommand, companionMemoryTraceInspectCommand,
  ...companionDocumentCatalogCommands,
  ...companionMemoryTagCommands,
  ...activityStorageCommands, ...companionInterruptionCommands,
  ...playerProfileCommands,
  ...companionResetCommands,
  ...companionWorkOrderStorageCommands,
  ...companionLifeStorageCommands,
  ...companionTopicStorageCommands,
  ...companionCollaborationStorageCommands,
  z.strictObject({ type: z.literal('companion.retire.cleanup'), id: companionIdSchema, jobId: companionIdSchema }),
  z.strictObject({ type: z.literal('companion.retire.progress'), id: companionIdSchema, jobId: companionIdSchema, stage: companionResetCleanupStageSchema }),
  z.strictObject({ type: z.literal('companion.retire.cleanup-failed'), id: companionIdSchema, jobId: companionIdSchema, error: z.string().max(1000) }),
  z.strictObject({ type: z.literal('companion.task-ids'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('companion.task.track'), id: companionIdSchema, companionId: companionIdSchema, taskId: companionIdSchema }),
  z.strictObject({ type: z.literal('state'), includeHidden: z.boolean().optional(), includeConversations: z.boolean().optional(), activeOnly: z.boolean().optional(), conversationId: companionIdSchema.optional(), companionId: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('companion.set-active'), id: companionIdSchema, active: z.boolean(), expectedRevision: z.number().int().positive().optional() }),
  companionCreationStatusCommand,
  companionCreationIdentitySchema.extend({ type: z.literal('companion.creation.prepare'), request: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('custom'), companion: companionDraftSchema.strict() }),
    z.strictObject({ kind: z.literal('builtin'), templateId: z.enum(COMPANION_TEMPLATE_IDS) }),
  ]) }).strict(),
  z.strictObject({ type: z.literal('companion.creation.commit'), operationId: z.uuid() }),
  z.strictObject({ type: z.literal('companion.creation.fail'), operationId: z.uuid(), error: z.string().max(1000) }),
  z.strictObject({ type: z.literal('companion.creation.pending'), after: z.uuid().optional(), limit: z.number().int().min(1).max(50).default(20) }),
  z.strictObject({ type: z.literal('companion.update'), id: companionIdSchema, companion: companionDraftSchema, expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal('companion.delete'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('conversation.open'), companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('conversation.create-group'), title: z.string().trim().max(100).default(''), memberIds: z.array(companionIdSchema).min(1).max(20) }),
  z.strictObject({ type: z.literal('conversation.update'), id: companionIdSchema, title: z.string().trim().max(100).optional(), memberIds: z.array(companionIdSchema).min(1).max(20).optional(), pinned: z.boolean().optional(), muted: z.boolean().optional() }),
  z.strictObject({ type: z.literal('conversation.read'), id: companionIdSchema, sequence: z.number().int().nonnegative().optional() }),
  z.strictObject({ type: z.literal('conversation.delete'), id: companionIdSchema, mode: z.enum(['hide', 'dissolve']) }),
  z.strictObject({ type: z.literal('conversation.reopen'), id: companionIdSchema }),
  companionMessagesQuerySchema.extend({ type: z.literal('messages') }).strict(),
  z.strictObject({ type: z.literal('message.get'), id: companionIdSchema }),
  companionSearchQuerySchema.extend({ type: z.literal('message.search') }).strict(),
  z.strictObject({ type: z.literal('message.append'), message: appendCompanionMessageSchema }),
  z.strictObject({ type: z.literal('agenda.message.commit'), companionId: companionIdSchema, runId: companionIdSchema, leaseToken: companionIdSchema,
    unsolicited: z.boolean(), message: appendCompanionMessageSchema }),
  z.strictObject({ type: z.literal('memory.list'), companionId: companionIdSchema }),
  ...companionMemoryStorageCommands,
  companionMemoryFileInspectCommand,
  companionMemoryFileStateCommand,
  ...companionScheduleStorageCommands,
  ...companionStateStorageCommands,
  ...companionRoutineStorageCommands,
  ...companionWorldStorageCommands,
  ...companionSocialStorageCommands,
  z.strictObject({ type: z.literal('memory.save'), memory: saveCompanionMemorySchema }),
  z.strictObject({ type: z.literal('memory.delete'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('actions'), conversationId: companionIdSchema.optional(), ...companionActionReadWindowSchema.shape }),
  ...companionDshMailboxCommands,
  z.strictObject({ type: z.literal('actions.invocation'), conversationId: companionIdSchema, companionId: companionIdSchema, parentMessageId: companionIdSchema }),
  z.strictObject({ type: z.literal('actions.ongoing'), conversationId: companionIdSchema, companionId: companionIdSchema }),
  companionActionPageQuerySchema.extend({ type: z.literal('actions.page') }).strict(),
  z.strictObject({ type: z.literal('action.get'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('capability.revalidation.read'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('capability.revalidation.commit'), id: companionIdSchema,
    invalidation: z.string().max(1000), writeGeneration: z.number().int().nonnegative().safe(), actionDigest: z.string().regex(/^[a-f0-9]{64}$/u) }),
  z.strictObject({ type: z.literal('capability.for-task'), companionId: companionIdSchema, conversationId: companionIdSchema, taskId: companionIdSchema }),
  z.strictObject({ type: z.literal('action.create'), action: createCompanionActionSchema, checkpoint: companionTaskCheckpointSchema.optional() }),
  z.strictObject({ type: z.literal('capability.begin'), companionId: companionIdSchema, conversationId: companionIdSchema,
    title: z.string().min(1).max(120), name: z.string().min(1).max(100), callId: z.string().min(1).max(200), invocationId: z.string().min(1).max(200),
    input: z.string().max(65536), sourceMessageId: companionIdSchema.optional(), parentMessageId: companionIdSchema.optional(),
    loopStep: z.number().int().nonnegative().optional(), agendaRunId: companionIdSchema.optional(), leaseToken: companionIdSchema.optional(), authorizationGrantId: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('activity.thought.create'), taskId: companionIdSchema, leaseToken: companionIdSchema,
    expectedStep: z.number().int().nonnegative().safe(), effectId: z.string().min(1).max(200),
    observationFingerprint: z.string().min(2).max(65536), executionReadset: companionExecutionReadsetSchema,
    prompt: z.string().trim().min(1).max(65536), title: z.string().trim().min(1).max(120) }),
  z.strictObject({ type: z.literal('peer.thought.create'), companionId: companionIdSchema, conversationId: companionIdSchema,
    jobId: companionIdSchema, leaseToken: companionIdSchema, effectId: z.string().min(1).max(200), executionReadset: companionExecutionReadsetSchema,
    prompt: z.string().trim().min(1).max(65536), title: z.string().trim().min(1).max(120) }),
  z.strictObject({ type: z.literal('activity.thought.validate'), authorization: companionThoughtAuthorizationSchema,
    executionReadset: companionExecutionReadsetSchema, mode: z.enum(['execute', 'read']), renew: z.boolean().optional() }),
  z.strictObject({ type: z.literal('action.update'), id: companionIdSchema, patch: updateCompanionActionSchema }),
  z.strictObject({ type: z.literal('action.interrupt-pending') }),
  z.strictObject({ type: z.literal('checkpoint.get'), id: companionIdSchema, includeFeedbackRecall: z.boolean().optional() }),
  z.strictObject({ type: z.literal('checkpoint.save'), id: companionIdSchema, checkpoint: companionTaskCheckpointSchema }),
  z.strictObject({ type: z.literal('checkpoint.execution'), id: companionIdSchema, execution: dshTaskRecordSchema }),
  z.strictObject({ type: z.literal('checkpoint.input'), id: companionIdSchema, input: z.strictObject({ id: companionIdSchema, content: z.string().max(16000), mode: z.enum(['steer', 'queue']) }) }),
  z.strictObject({ type: z.literal('action.resume'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('reply.checkpoint.get'), conversationId: companionIdSchema, sourceMessageId: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('loop.get'), sourceMessageId: companionIdSchema, companionId: companionIdSchema, invocationKey: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('loop.for-message'), messageId: companionIdSchema }),
  z.strictObject({ type: z.literal('memory.corpus.stamp'), companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('loop.save'), checkpoint: companionLoopCheckpointSchema, executionReadset: companionExecutionReadsetSchema.optional() }),
  z.strictObject({ type: z.literal('execution.sources'), sourceMessageIds: z.array(companionIdSchema).max(100), memoryIds: z.array(companionIdSchema).max(100).default([]) }),
  z.strictObject({ type: z.literal('execution.capabilities.validate'), actions: z.array(z.strictObject({ id: companionIdSchema,
    companionId: companionIdSchema, conversationId: companionIdSchema, capability: actionSchema.shape.capability })).max(512) }),
  z.strictObject({ type: z.literal('execution.invalidate'), kind: z.enum(['message', 'action']), id: companionIdSchema, companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('work.enqueue'), work: companionWorkSchema, resume: z.boolean().optional() }),
  z.strictObject({ type: z.literal('work.claim'), companionId: companionIdSchema.optional(), id: companionIdSchema.optional(),
    agendaRunId: companionIdSchema.optional(), agendaLeaseToken: companionIdSchema.optional() })
    .refine(value => (!value.agendaRunId && !value.agendaLeaseToken) || !!(value.companionId && value.id && value.agendaRunId && value.agendaLeaseToken), '日程聊天认领需要完整的原始任务与父租约。'),
  z.strictObject({ type: z.literal('work.get'), companionId: companionIdSchema, id: companionIdSchema }),
  z.strictObject({ type: z.literal('work.agenda.restore'), companionId: companionIdSchema, id: companionIdSchema,
    agendaRunId: companionIdSchema, expectedUpdatedAt: z.string() }),
  z.strictObject({ type: z.literal('work.list'), sourceMessageId: companionIdSchema.optional(), unfinishedOnly: z.boolean().optional() }),
  z.strictObject({ type: z.literal('work.interrupt-running') }),
  z.strictObject({ type: z.literal('work.promote'), sourceMessageId: companionIdSchema, companionId: companionIdSchema.optional(), checkpoint: companionLoopCheckpointSchema.optional() }),
  z.strictObject({ type: z.literal('work.status'), id: companionIdSchema, status: companionWorkSchema.shape.status, resumeOnRestart: z.boolean().optional(),
    agendaRunId: companionIdSchema.optional(), agendaLeaseToken: companionIdSchema.optional() })
    .refine(value => (!value.agendaRunId && !value.agendaLeaseToken) || !!(value.agendaRunId && value.agendaLeaseToken), '日程聊天结算需要完整父租约。'),
  z.strictObject({ type: z.literal('reply.checkpoint.status'), conversationId: companionIdSchema, sourceMessageId: companionIdSchema, status: z.enum(['pending', 'interrupted', 'done', 'cancelled']) }),
  z.strictObject({ type: z.literal('reply.checkpoint.complete'), conversationId: companionIdSchema, sourceMessageId: companionIdSchema, companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('reply.checkpoint.reset'), conversationId: companionIdSchema, sourceMessageId: companionIdSchema, delivery: z.enum(['auto', 'steer', 'queue', 'parallel', 'chat']) }),
  z.strictObject({ type: z.literal('attachment.register'), stored: storedCompanionAttachmentSchema }),
  z.strictObject({ type: z.literal('attachment.get'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('file.result.get'), key: fileToolResultKeySchema }),
  z.strictObject({ type: z.literal('file.result.commit'), key: fileToolResultKeySchema, result: fileToolResultSchema, attachments: z.array(fileToolAttachmentSchema).max(10) }),
  z.strictObject({ type: z.literal('proactive.get'), companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('proactive.attempt'), companionId: companionIdSchema, at: z.iso.datetime() }),
  z.strictObject({ type: z.literal('proactive.record'), companionId: companionIdSchema, lastUserMessageId: companionIdSchema,
    sentAt: z.iso.datetime(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);
export type CompanionStorageCommand = z.input<typeof companionStorageCommandSchema>;
/** Host-selected actual formal sources. Scan cursors can advance over hidden
 * rows, but neither their identifiers nor their content hashes are projected. */
export const companionTopicCompactionPageSchema = z.strictObject({
  items: z.array(z.strictObject({ message: messageSchema,
    publicationRevision: z.number().int().positive().safe().optional(),
    sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u), legacyOrderUnknown: z.literal(true).optional() })).max(100),
  afterPublicationRevision: z.number().int().nonnegative().safe(),
  throughPublicationRevision: z.number().int().nonnegative().safe(),
  legacyScannedThroughSequence: z.number().int().nonnegative().safe(),
  legacyThroughSequence: z.number().int().nonnegative().safe(),
  legacyComplete: z.boolean(), hasMore: z.boolean(),
});
export type CompanionTopicCompactionPage = z.infer<typeof companionTopicCompactionPageSchema>;
export const companionStorageResponseSchema = companionsResponseSchema.extend({
  capabilityRevalidation: z.strictObject({ action: actionSchema, invalidation: z.string().max(1000),
    writeGeneration: z.number().int().nonnegative().safe(), actionDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).optional(),
  capabilityRevalidated: z.boolean().optional(),
  agendaMessageRejected: z.literal(true).optional(),
  recovery: companionRecoveryResultSchema.optional(),
  recoveryReview: z.strictObject({ownerIds:z.array(companionIdSchema).max(50),hasMore:z.boolean(),nextId:companionIdSchema.optional()}).optional(),
  jobDisposition: companionJobDispositionSchema.optional(),
  topicCompactionJob: companionTopicCompactionJobSchema.optional(),
  jobPage: companionJobPageSchema.optional(),
  worldInputAccepted: z.boolean().optional(),
  ...companionRegistryStorageResponseShape,
  pendingCreations: z.array(z.strictObject({ creation: companionCreationReceiptSchema, companion: companionsResponseSchema.shape.companion.unwrap() })).optional(),
  growthGoal: companionGrowthGoalSchema.optional(), growthGoals: z.array(companionGrowthGoalSchema).max(40).optional(),
  dshMailbox: z.object({ items: z.array(companionDshMailSchema).max(50), nextAfter: z.number().int().nonnegative(), hasMore: z.boolean() }).optional(),
  taskCapacityClaimed: z.boolean().optional(),
  memoryFrozenValid: z.boolean().optional(),
  taskControl: companionTaskControlResultSchema.optional(),
  userTaskStops: z.array(companionTaskStopReceiptSchema).max(20).optional(),
  activityThoughtValid: z.boolean().optional(),
  capabilityAuthorityResults: z.array(z.strictObject({ id: companionIdSchema, companionId: companionIdSchema,
    conversationId: companionIdSchema, valid: z.boolean() })).max(512).optional(),
  experienceEvidence: companionExecutionReadsetSchema.optional(),
  agentRun: companionAgentRunSchema.optional(),
  executionSources: z.array(z.object({ kind: z.enum(['message', 'action']), id: companionIdSchema, companionId: companionIdSchema,
    conversationId: companionIdSchema, sourceMessageIds: z.array(companionIdSchema), invalidated: z.boolean().optional(), executionReadset: companionExecutionReadsetSchema.optional(),
    capability: actionSchema.shape.capability,
    storageValidatedReadsetDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    storageValidatedAuthorityEpoch: z.number().int().nonnegative().safe().optional() })).optional(),
  topicSourcesValid: z.boolean().optional(),
  topicCompactionPage: companionTopicCompactionPageSchema.optional(),
  collaboration: companionCollaborationGrantSchema.optional(), collaborations: z.array(companionCollaborationGrantSchema).max(100).optional(),
  interruption: companionInterruptionSchema.optional(),
  inserted: z.boolean().optional(),
  storedAttachment: storedCompanionAttachmentSchema.optional(),
  fileToolResult: fileToolResultSchema.optional(),
  resetTaskIds: z.array(z.string().max(200)).optional(),
  companionTaskIds: z.array(z.string().max(200)).optional(),
  worldClock: companionWorldTimeSchema.optional(),
  worldSleepPlan: companionWorldSleepPlanSchema.optional(),
  lifeOverviewContext: companionLifeOverviewContextSchema.optional(),
  workOrderClaim: companionWorkOrderClaimSchema.optional(),
  action: actionSchema.optional(),
  proactive: companionProactiveStateSchema.optional(),
  checkpoint: companionTaskCheckpointSchema.optional(), replyRecovery: companionReplyRecoverySchema.optional(),
  loop: companionLoopCheckpointSchema.optional(), memoryCorpusStamp: z.string().optional(), memoryRecallAuthorityStamp: z.string().min(1).max(1000).optional(),
  work: companionWorkSchema.optional(), works: z.array(companionWorkSchema).optional(),
  memoryJob: companionMemoryJobSchema.optional(),
  memoryCaptureContributions: companionMemoryCaptureContributionsSchema.optional(),
  memoryCaptureProposal: companionCaptureProposalSchema.optional(),
  memoryOutboxPending: z.boolean().optional(),
  memorySourceOutbox: companionMemorySourceOutboxSchema.optional(), memorySourceOutboxAccepted: z.boolean().optional(),
  memorySourceChangedCompanionIds: z.array(companionIdSchema).optional(), memorySourcePendingOwners: z.array(companionIdSchema).optional(),
  assetProfileInitialized: z.boolean().optional(),
  assetPortraitInitialized: z.boolean().optional(),
  memoryTagJob: companionMemoryTagJobSchema.optional(), memoryTagStatus: companionMemoryTagStatusSchema.optional(), memoryTagValid: z.boolean().optional(),
  memoryDomains: z.array(companionMemoryDomainSchema).optional(), memoryOutbox: companionMemoryOutboxSchema.optional(),
  memoryOutboxDisposition: z.strictObject({ state: z.enum(['completed', 'stale']), reason: z.string().max(1000).optional() }).optional(),
  memoryConsolidationDeferred: z.strictObject({ requiresFreshReadSet: z.literal(true), reason: z.string().max(1000) }).optional(),
  memorySnapshot: companionMemorySnapshotSchema.optional(),
  memoryDescriptors: z.array(companionMemoryDescriptorSchema).optional(),
  memorySearchTimings: z.record(z.string(), z.number().nonnegative()).optional(),
  memoryFileReadiness: companionMemoryFileReadinessSchema.optional(),
  memoryFileState: companionMemoryFileStateSchema.optional(),
  memoryFilesPending: z.boolean().optional(),
  memoryLibraryIndexState: companionMemoryLibraryIndexStateSchema.optional(),
  memoryProjectionState: companionMemoryProjectionStateSchema.optional(),
  memoryProjectionPage: companionMemoryProjectionPageSchema.optional(),
  memoryProjectionDisposition: z.enum(['capacity', 'reset_required']).optional(),
  memoryLibraryIndexPage: companionMemoryLibraryIndexPageSchema.optional(),
  memoryLibraryChanges: companionMemoryLibraryChangesSchema.optional(),
  memoryPolicies: z.array(companionMemoryPolicySchema).optional(),
  memoryProhibitions: z.array(companionMemoryProhibitionSchema).optional(),
  memoryProhibitionRevision: z.string().min(1).max(128).optional(),
  memoryProhibitionConversationId: companionIdSchema.optional(),
  memoryInvalidatedCompanionIds: z.array(companionIdSchema).optional(),
  memoryInvalidatedScopeIds: z.array(companionIdSchema).optional(),
  memoryChangedCompanionIds: z.array(companionIdSchema).optional(),
  memoryLifecycleState: companionMemoryLifecycleStateSchema.optional(),
  memoryLifecycleChanges: companionMemoryLifecycleChangesSchema.optional(),
  activityMemoryIntent: activityMemoryIntentSchema.optional(),
  activityAgendaPage: activityAgendaPageSchema.optional(),
  activityPlanningState: activityPlanningStateSchema.optional(),
  activityPassiveRecall: activityPassiveRecallSchema.optional(),
  activityHandoff: activityHandoffSchema.optional(),
  activitySocialRoute: z.strictObject({ taskId: companionIdSchema, sourceMessageId: companionIdSchema }).optional(),
  activityGameRoom: z.strictObject({ conversationId: companionIdSchema, memberIds: z.array(companionIdSchema).min(2).max(20) }).optional(),
  documentCatalog: companionDocumentCatalogPageSchema.optional(),
  documentCatalogUnchanged: z.boolean().optional(),
  learning: companionLearningStatusSchema.optional(), learningJob: companionLearningJobSchema.optional(),
  learningAssetSnapshot: companionLearningAssetSnapshotSchema.optional(), learningAssetValidation: companionLearningAssetValidationSchema.optional(),
  learningGoal: companionLearningGoalSchema.optional(), learningGoals: companionLearningGoalPageSchema.optional(),
  learningRounds: companionLearningGoalRoundPageSchema.optional(), learningGoalJob: companionLearningGoalJobSchema.optional(),
  rebuiltCount: z.number().int().nonnegative().optional(),
  schedule: companionScheduleSchema.optional(), schedules: z.array(companionScheduleSchema).optional(),
  scheduleOccurrence: companionScheduleOccurrenceSchema.optional(), scheduleOccurrences: z.array(companionScheduleOccurrenceSchema).optional(),
  runtimeState: companionRuntimeStateSchema.optional(),
  world: companionWorldSnapshotSchema.optional(), worldWork: companionWorldWorkSchema.optional(), worldJob: companionWorldJobSchema.optional(),
  worldProposal: companionWorldProposalSchema.optional(),
  memoryInvestigations: z.array(companionMemoryInvestigationSchema).optional(), memoryInvestigation: companionMemoryInvestigationSchema.optional(),
  memoryHistoryDescriptor: companionMemoryHistoryDescriptorSchema.optional(), memoryHistoryDescriptors: z.array(companionMemoryHistoryDescriptorSchema).max(10000).optional(), memoryHistoryOutbox: companionMemoryHistoryOutboxSchema.optional(),
  memoryHistoryPendingOwners: z.array(z.string()).optional(), memoryHistoryOutboxAccepted: z.boolean().optional(),
  socialConversation: companionSocialConversationSchema.optional(), socialMessage: companionSocialMessageSchema.optional(), socialJob: companionSocialJobSchema.optional(),
  socialReplyReceipt: companionSocialReplyReceiptSchema.optional(),
  socialGameContext: companionSocialGameContextSchema.optional(),
  socialPending: z.boolean().optional(), socialNotification: companionSocialNotificationSchema.optional(),
  activityProgressEvidence: companionSocialProgressEvidenceSchema.optional(),
  activityReport: z.strictObject({ id: companionIdSchema, leaseToken: companionIdSchema,
    executionReadset: companionExecutionReadsetSchema }).optional(),
  socialDeliveryClientId: companionIdSchema.optional(), socialDeliveryReused: z.boolean().optional(),
  activityPortCandidate: z.strictObject({ id: companionIdSchema, conversationId: companionIdSchema, topicId: companionIdSchema,
    creatorCompanionId: companionIdSchema, requiresJoin: z.literal(true), notice: z.string().max(1000) }).optional(),
  topicDelivery: z.strictObject({ stateStored: z.literal(true), messageSent: z.literal(false), recipientAwakened: z.literal(false), notice: z.string().max(1000) }).optional(),
  gameStateHandoff: z.strictObject({ automaticTopicStateTransfer: z.literal(false), gamePort: z.strictObject({ conversationId: companionIdSchema, topicId: companionIdSchema }), notice: z.string().max(2000) }).optional(),
  socialDelivery: z.strictObject({ socialOnly: z.literal(true), operation: z.enum(['message', 'introduce', 'create_group', 'social']),
    executionGrantCreated: z.literal(false), collaborationCreated: z.literal(false), continuationKind: z.enum(['virtual_social_activity', 'none']),
    continuationId: companionIdSchema.optional(), continuationStatus: z.string().optional(), nextAction: z.literal('collaborate').optional(), guidance: z.string().optional() }).optional(),
});
export type CompanionStorageResponse = z.infer<typeof companionStorageResponseSchema>;

export const companionStorageRequestSchema = z.strictObject({
  requestId: companionIdSchema, command: companionStorageCommandSchema,
});
export const companionStorageReplySchema = z.strictObject({
  requestId: companionIdSchema, response: companionStorageResponseSchema,
});
