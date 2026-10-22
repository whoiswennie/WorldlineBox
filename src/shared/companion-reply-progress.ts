import { z } from 'zod';

/** Host execution milestones, never model reasoning text. Each revision belongs
 * to one durable loop/message, including its queued and terminal states. */
export const companionReplyProgressSchema = z.strictObject({
  workId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(), sourceMessageId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  revision: z.number().int().positive(),
  phase: z.enum(['queued', 'waiting', 'context', 'memory', 'thinking', 'tools', 'streaming', 'completed', 'failed', 'cancelled', 'interrupted']),
  detail: z.string().max(500), updatedAt: z.string(), startedAt: z.string(),
  memory: z.strictObject({ status: z.enum(['running', 'completed', 'unavailable']), count: z.number().int().nonnegative().optional(), injected: z.boolean().optional(), pending: z.boolean().optional() }).optional(),
});
export type CompanionReplyProgress = z.infer<typeof companionReplyProgressSchema>;
export const terminalReplyPhases = new Set<CompanionReplyProgress['phase']>(['completed', 'failed', 'cancelled', 'interrupted']);
