import { z } from 'zod';
import { companionReplyProgressSchema } from './companion-reply-progress';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionSocialRecallSchema = z.strictObject({
  reasons: z.array(z.strictObject({ id, version: z.number().int().positive().optional(),
    reasons: z.array(z.string().max(500)).max(20), path: z.array(id).max(50) })).max(12),
  pending: z.boolean(), degraded: z.boolean(),
  context: z.strictObject({ text: z.string().max(1024 * 1024), revision: z.string().max(160), profileKey: z.string().max(4096),
    evidence: z.strictObject({ capturedAt: z.string(), corpusHash: z.string(), beforeSequence: z.number().int().nonnegative().optional() }).optional(),
  }).optional(),
});
export const companionSocialReplyProgressEntrySchema = z.strictObject({
  jobId: id, companionId: id, conversationId: id, sourceMessageId: id, messageId: id.optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']), progress: companionReplyProgressSchema,
});
export const companionSocialReplyProgressCommand = z.strictObject({ type: z.literal('social.reply.progress'),
  conversationId: id, companionId: id.optional(), limit: z.number().int().min(1).max(50).default(20),
});
export const companionSocialReplyMemoryCommand = z.strictObject({ type: z.literal('social.reply.memory.inspect'),
  jobId: id, companionId: id, conversationId: id,
  contextOffset: z.number().int().min(0).max(1024 * 1024).default(0), contextLimit: z.number().int().min(1).max(16384).default(8192),
});
/** Saved facts only; the social model's hidden reasoning is never retained. */
export const companionSocialReplyReceiptSchema = z.strictObject({
  companionId: id, conversationId: id, messageId: id, sourceMessageId: id, contextThroughSequence: z.number().int().positive(),
  sourceChecksum: z.string(), leaseToken: id.optional(), context: z.strictObject({ user: z.string().max(2 * 1024 * 1024) }), progress: companionReplyProgressSchema,
});
export type CompanionSocialRecall = z.infer<typeof companionSocialRecallSchema>;
export type CompanionSocialReplyProgressEntry = z.infer<typeof companionSocialReplyProgressEntrySchema>;
export type CompanionSocialReplyReceipt = z.infer<typeof companionSocialReplyReceiptSchema>;
export type CompanionSocialReplyMemoryRequest = z.infer<typeof companionSocialReplyMemoryCommand>;
