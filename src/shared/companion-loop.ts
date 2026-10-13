import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionLoopCallSchema = z.object({ id: z.string().min(1).max(200), name: z.string().max(100), arguments: z.string().max(65536) });
export const companionLoopTurnSchema = z.object({ text: z.string().max(65536), rawText: z.string().max(65536), calls: z.array(companionLoopCallSchema).max(16), messageId: id.optional(), results: z.array(z.object({ callId: z.string().max(200), content: z.string().max(16000) })).max(16).optional() });
export const companionLoopCheckpointSchema = z.object({ conversationId: id, sourceMessageId: id, companionId: id, messageId: id.optional(), status: z.enum(['running', 'done']), turns: z.array(companionLoopTurnSchema).max(64), supplements: z.array(z.object({ id, content: z.string().max(16000) })).max(100).default([]) });
export type CompanionLoopCall = z.infer<typeof companionLoopCallSchema>;
export type CompanionLoopTurn = z.infer<typeof companionLoopTurnSchema>;
export type CompanionLoopCheckpoint = z.infer<typeof companionLoopCheckpointSchema>;
export const companionWorkSchema = z.object({ id, conversationId: id, sourceMessageId: id, companionId: id,
  status: z.enum(['queued', 'running', 'interrupted', 'done', 'cancelled']), ordinal: z.number().int().positive().optional(), proactive: z.boolean().default(false),
  createdAt: z.string(), updatedAt: z.string() });
export type CompanionWork = z.infer<typeof companionWorkSchema>;
