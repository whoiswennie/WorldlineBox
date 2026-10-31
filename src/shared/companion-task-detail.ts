import { z } from 'zod';
import { companionTaskStopCommand, companionTaskItemSchema } from './companion-task-overview';
import { companionMemoryProcessingJobSchema } from './companion-memory-processing';
import { companionJobFailureKindSchema } from './companion-job-control';

export const companionTaskSectionSchema = z.enum(['input', 'process', 'output']);
export type CompanionTaskSection = z.infer<typeof companionTaskSectionSchema>;
export const companionTaskInspectCommand = companionTaskStopCommand.extend({ type: z.literal('task.inspect'),
  section: companionTaskSectionSchema.default('input'), offset: z.number().int().min(0).max(10000000).default(0),
  limit: z.number().int().min(1).max(20).default(12) }).strict();
export const companionTaskContentCommand = companionTaskStopCommand.extend({ type: z.literal('task.content'),
  recordId: z.string().min(1).max(4096), offset: z.number().int().min(0).max(100000000).default(0),
  limit: z.number().int().min(1).max(6000).default(6000) }).strict();
export const companionTaskRecordSchema = z.strictObject({ id: z.string().max(4096), title: z.string().max(300),
  text: z.string().max(12000), totalCharacters: z.number().int().nonnegative(), at: z.string().optional(),
  provenance: z.enum(['source', 'host', 'model_proposal', 'model_output', 'legacy']), state: z.string().max(60).optional() });
export type CompanionTaskRecord = z.infer<typeof companionTaskRecordSchema>;
export const companionTaskDetailSchema = z.strictObject({ task: companionTaskItemSchema, purpose: z.string().max(1000),
  companionName: z.string().max(100), conversationTitle: z.string().max(100).optional(),
  section: companionTaskSectionSchema, items: z.array(companionTaskRecordSchema).max(20),
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), hasMore: z.boolean(),
  nativeRecordId: z.uuid().optional(),
  observedAt: z.string(), notice: z.string().max(1000).optional() });
export type CompanionTaskDetail = z.infer<typeof companionTaskDetailSchema>;
export const companionTaskContentSchema = companionTaskRecordSchema.extend({ offset: z.number().int().nonnegative(), hasMore: z.boolean() }).strict();
export const companionTaskTimelineRecordCommand = z.strictObject({ type: z.literal('tasks.timeline.record'),
  companionId: companionTaskStopCommand.shape.companionId, job: companionMemoryProcessingJobSchema,
  expectedDispositionRevision: z.number().int().nonnegative().safe().optional(), failureKind: companionJobFailureKindSchema.optional(),
  input: z.string().max(1000000).optional(), output: z.string().max(2000000).optional() });
