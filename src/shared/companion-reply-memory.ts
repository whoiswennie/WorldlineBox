import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
/** Human inspection of one persisted reply. Large text is loaded only on demand. */
export const companionReplyMemoryCommand = z.strictObject({
  type: z.literal('reply.memory.inspect'), companionId: id, conversationId: id, messageId: id,
  contextOffset: z.number().int().min(0).max(1024 * 1024).default(0),
  contextLimit: z.number().int().min(1).max(16384).default(8192),
});
export const companionReplyMemorySchema = z.strictObject({
  state: z.enum(['ready', 'unavailable', 'withdrawn']), companionId: id, conversationId: id, messageId: id,
  observedAt: z.string(), query: z.string().max(16000).optional(),
  contextText: z.string().max(16384).optional(), contextCharacters: z.number().int().nonnegative(),
  contextOffset: z.number().int().nonnegative(), nextContextOffset: z.number().int().nonnegative().optional(),
  contextTruncated: z.boolean(), pending: z.boolean(), degraded: z.boolean(),
  candidates: z.array(z.strictObject({
    id, version: z.number().int().positive(), title: z.string().max(160), content: z.string().max(2000),
    contentTruncated: z.boolean(), tags: z.array(z.string().max(100)).max(50), createdAt: z.string(),
    sourceCount: z.number().int().nonnegative(), sources: z.array(z.strictObject({
      messageId: id, conversationId: id, authorId: id, createdAt: z.string(), excerpt: z.string().max(600),
    })).max(3),
  })).max(12), explanation: z.string().max(1000),
});
export type CompanionReplyMemory = z.infer<typeof companionReplyMemorySchema>;
