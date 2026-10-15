import { z } from 'zod';

import {
  actionSchema, attachmentSchema, companionDraftSchema, companionIdSchema,
  companionsResponseSchema, memorySchema, companionActionPageQuerySchema, companionReplyRecoverySchema, companionMessagesQuerySchema, companionSearchQuerySchema,
} from './companions';
import { dshTaskRecordSchema } from './dsh-tasks';
import { companionLoopCheckpointSchema, companionWorkSchema } from './companion-loop';
import { companionMemoryStorageCommands, companionMemoryJobSchema } from './companion-memory';
import { companionScheduleStorageCommands, companionScheduleOccurrenceSchema, companionScheduleSchema } from './companion-schedule';
import { companionStateStorageCommands, companionRuntimeStateSchema } from './companion-state';
import { companionRoutineStorageCommands } from './companion-routine';
import { companionWorldStorageCommands, companionWorldSnapshotSchema, companionWorldWorkSchema, companionWorldJobSchema } from './companion-world';
import { companionSocialStorageCommands, companionSocialConversationSchema, companionSocialMessageSchema, companionSocialJobSchema } from './companion-social';
import { playerProfileCommands } from './companion-profile';
import { companionResetCommands } from './companion-reset';

export const appendCompanionMessageSchema = z.strictObject({
  conversationId: companionIdSchema, authorId: companionIdSchema,
  content: z.string().max(65536), clientId: companionIdSchema.optional(),
  kind: z.enum(['text', 'notice', 'action']).default('text'),
  replyToId: companionIdSchema.optional(), actionId: companionIdSchema.optional(),
  attachmentIds: z.array(companionIdSchema).max(10).default([]),
  status: z.enum(['sent', 'failed']).default('sent'),
  replyDirective: z.enum(['auto', 'steer', 'queue', 'parallel', 'chat', 'none']).optional(),
  replyCompletion: z.object({ sourceMessageId: companionIdSchema, companionId: companionIdSchema }).optional(),
  loopStep: z.number().int().nonnegative().optional(),
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
const fileToolAttachmentSchema = storedCompanionAttachmentSchema.refine(value => !value.sourcePath && !value.attachment.path
  && value.attachment.size <= 100 * 1024 * 1024, '文件工具只能登记最多 100 MiB 的受管快照。');

export const createCompanionActionSchema = actionSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type CreateCompanionAction = z.infer<typeof createCompanionActionSchema>;
export const companionTaskCheckpointSchema = z.strictObject({ prompt: z.string().min(1).max(65536),
  waitForActionIds: z.array(companionIdSchema).max(100).default([]),
  execution: dshTaskRecordSchema.optional(), supplements: z.array(z.object({ id: companionIdSchema, content: z.string().max(16000), mode: z.enum(['steer', 'queue']) })).max(100).default([]) });
export type CompanionTaskCheckpoint = z.infer<typeof companionTaskCheckpointSchema>;
export const updateCompanionActionSchema = actionSchema.pick({ status: true, taskId: true, sessionId: true, result: true, error: true, stage: true, events: true, accessMode: true, startedAt: true, finishedAt: true, pid: true }).partial();
export type UpdateCompanionAction = z.infer<typeof updateCompanionActionSchema>;
export const saveCompanionMemorySchema = memorySchema.omit({ id: true, createdAt: true, updatedAt: true, sourceConversationId: true }).extend({ id: companionIdSchema.optional(), conversationId: companionIdSchema.optional(), expectedVersion: z.number().int().positive().optional() });
export type SaveCompanionMemory = z.infer<typeof saveCompanionMemorySchema>;
export const companionProactiveStateSchema = z.strictObject({
  lastAttemptAt: z.string().optional(),
  lastSentAt: z.string().optional(), lastUserMessageId: companionIdSchema.optional(),
  date: z.string().optional(), count: z.number().int().nonnegative(),
});
export type CompanionProactiveState = z.infer<typeof companionProactiveStateSchema>;

export const companionStorageCommandSchema = z.discriminatedUnion('type', [
  ...playerProfileCommands,
  ...companionResetCommands,
  z.strictObject({ type: z.literal('companion.reset.cleanup'), id: companionIdSchema, jobId: companionIdSchema }),
  z.strictObject({ type: z.literal('companion.reset.cleanup-failed'), id: companionIdSchema, jobId: companionIdSchema, error: z.string().max(1000) }),
  z.strictObject({ type: z.literal('companion.task-ids'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('companion.task.track'), id: companionIdSchema, companionId: companionIdSchema, taskId: companionIdSchema }),
  z.strictObject({ type: z.literal('state'), includeHidden: z.boolean().optional() }),
  z.strictObject({ type: z.literal('companion.create'), companion: companionDraftSchema }),
  z.strictObject({ type: z.literal('companion.update'), id: companionIdSchema, companion: companionDraftSchema, expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal('companion.delete'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('companion.restore-builtin'), id: companionIdSchema }),
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
  z.strictObject({ type: z.literal('memory.list'), companionId: companionIdSchema }),
  ...companionMemoryStorageCommands,
  ...companionScheduleStorageCommands,
  ...companionStateStorageCommands,
  ...companionRoutineStorageCommands,
  ...companionWorldStorageCommands,
  ...companionSocialStorageCommands,
  z.strictObject({ type: z.literal('memory.save'), memory: saveCompanionMemorySchema }),
  z.strictObject({ type: z.literal('memory.delete'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('actions'), conversationId: companionIdSchema.optional() }),
  companionActionPageQuerySchema.extend({ type: z.literal('actions.page') }).strict(),
  z.strictObject({ type: z.literal('action.get'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('action.create'), action: createCompanionActionSchema, checkpoint: companionTaskCheckpointSchema.optional() }),
  z.strictObject({ type: z.literal('action.update'), id: companionIdSchema, patch: updateCompanionActionSchema }),
  z.strictObject({ type: z.literal('action.interrupt-pending') }),
  z.strictObject({ type: z.literal('checkpoint.get'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('checkpoint.save'), id: companionIdSchema, checkpoint: companionTaskCheckpointSchema }),
  z.strictObject({ type: z.literal('checkpoint.execution'), id: companionIdSchema, execution: dshTaskRecordSchema }),
  z.strictObject({ type: z.literal('checkpoint.input'), id: companionIdSchema, input: z.strictObject({ id: companionIdSchema, content: z.string().max(16000), mode: z.enum(['steer', 'queue']) }) }),
  z.strictObject({ type: z.literal('action.resume'), id: companionIdSchema }),
  z.strictObject({ type: z.literal('reply.checkpoint.get'), conversationId: companionIdSchema, sourceMessageId: companionIdSchema.optional() }),
  z.strictObject({ type: z.literal('loop.get'), sourceMessageId: companionIdSchema, companionId: companionIdSchema }),
  z.strictObject({ type: z.literal('loop.save'), checkpoint: companionLoopCheckpointSchema }),
  z.strictObject({ type: z.literal('work.enqueue'), work: companionWorkSchema, resume: z.boolean().optional() }),
  z.strictObject({ type: z.literal('work.claim') }),
  z.strictObject({ type: z.literal('work.list'), sourceMessageId: companionIdSchema.optional(), unfinishedOnly: z.boolean().optional() }),
  z.strictObject({ type: z.literal('work.interrupt-running') }),
  z.strictObject({ type: z.literal('work.promote'), sourceMessageId: companionIdSchema }),
  z.strictObject({ type: z.literal('work.status'), id: companionIdSchema, status: companionWorkSchema.shape.status }),
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
export const companionStorageResponseSchema = companionsResponseSchema.extend({
  inserted: z.boolean().optional(),
  storedAttachment: storedCompanionAttachmentSchema.optional(),
  fileToolResult: fileToolResultSchema.optional(),
  resetTaskIds: z.array(z.string().max(200)).optional(),
  companionTaskIds: z.array(z.string().max(200)).optional(),
  action: actionSchema.optional(),
  proactive: companionProactiveStateSchema.optional(),
  checkpoint: companionTaskCheckpointSchema.optional(), replyRecovery: companionReplyRecoverySchema.optional(),
  loop: companionLoopCheckpointSchema.optional(),
  work: companionWorkSchema.optional(), works: z.array(companionWorkSchema).optional(),
  memoryJob: companionMemoryJobSchema.optional(), backfillComplete: z.boolean().optional(),
  rebuiltCount: z.number().int().nonnegative().optional(),
  schedule: companionScheduleSchema.optional(), schedules: z.array(companionScheduleSchema).optional(),
  scheduleOccurrence: companionScheduleOccurrenceSchema.optional(), scheduleOccurrences: z.array(companionScheduleOccurrenceSchema).optional(),
  runtimeState: companionRuntimeStateSchema.optional(),
  world: companionWorldSnapshotSchema.optional(), worldWork: companionWorldWorkSchema.optional(), worldJob: companionWorldJobSchema.optional(),
  socialConversation: companionSocialConversationSchema.optional(), socialMessage: companionSocialMessageSchema.optional(), socialJob: companionSocialJobSchema.optional(),
  socialPending: z.boolean().optional(),
});
export type CompanionStorageResponse = z.infer<typeof companionStorageResponseSchema>;

export const companionStorageRequestSchema = z.strictObject({
  requestId: companionIdSchema, command: companionStorageCommandSchema,
});
export const companionStorageReplySchema = z.strictObject({
  requestId: companionIdSchema, response: companionStorageResponseSchema,
});
