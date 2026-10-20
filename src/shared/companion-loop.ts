import { z } from 'zod';
import { companionToolImageReferenceSchema } from './companion-file-tool';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionLoopCallSchema = z.object({ id: z.string().min(1).max(200), name: z.string().max(100), arguments: z.string().max(65536),
  // Opaque provider protocol metadata, never thought text or a memory source.
  thoughtSignature: z.string().min(1).max(65536).optional() });
export const companionLoopTurnSchema = z.object({ text: z.string().max(65536), rawText: z.string().max(65536), calls: z.array(companionLoopCallSchema).max(16), messageId: id.optional(), results: z.array(z.object({ callId: z.string().max(200), content: z.string(), images: z.array(companionToolImageReferenceSchema).max(4).optional(), attachmentIds: z.array(id).max(10).optional() })).max(16).optional() });
// Message-count windows and paginated retrieval limit work. Checkpoints preserve
// the actual request instead of imposing a hidden global character quota.
const companionLoopContextSchema = z.object({ system: z.string(), user: z.string() });
export const companionLoopDraftSchema = z.strictObject({ step: z.number().int().min(0).max(63), attemptId: id, text: z.string().max(65536) });
export const companionLoopCheckpointSchema = z.object({ conversationId: id, sourceMessageId: id, companionId: id, messageId: id.optional(),
  proactiveWorkId: id.optional(), contextThroughSequence: z.number().int().positive().optional(),
  status: z.enum(['running', 'done']), context: companionLoopContextSchema.optional(), turns: z.array(companionLoopTurnSchema).max(64),
  draft: companionLoopDraftSchema.optional(), supplements: z.array(z.object({ id, content: z.string().max(16000) })).max(100).default([]) })
  .superRefine((checkpoint, context) => {
    if (checkpoint.draft && (checkpoint.status !== 'running' || checkpoint.draft.step !== checkpoint.turns.length)) context.addIssue({ code: 'custom', path: ['draft'], message: '流式草稿必须属于当前尚未完成的循环步骤。' });
  });
export type CompanionLoopCall = z.infer<typeof companionLoopCallSchema>;
export type CompanionLoopTurn = z.infer<typeof companionLoopTurnSchema>;
export type CompanionLoopCheckpoint = z.infer<typeof companionLoopCheckpointSchema>;
export const companionWorkSchema = z.object({ id, conversationId: id, sourceMessageId: id, companionId: id,
  status: z.enum(['queued', 'running', 'interrupted', 'done', 'cancelled']), ordinal: z.number().int().positive().optional(), proactive: z.boolean().default(false),
  createdAt: z.string(), updatedAt: z.string() });
export type CompanionWork = z.infer<typeof companionWorkSchema>;
