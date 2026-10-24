import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionKnowledgeCommandSchema = z.strictObject({ type: z.literal('memory.knowledge'), companionId: id, conversationId: id,
  beforeSequence: z.number().int().nonnegative().optional(), operation: z.enum(['ingest', 'search', 'read', 'revoke', 'status', 'sources']),
  sourceType: z.enum(['message', 'memory', 'learning']).optional(), sourceId: id.optional(), query: z.string().trim().min(1).max(16000).optional(),
  assetId: z.string().min(1).max(255).optional(), cursor: z.string().max(255).optional(),
  sourceIds: z.array(id).max(100).optional(), id: id.optional(), version: z.string().regex(/^[a-f0-9]{64}$/).optional(), limit: z.number().int().min(1).max(100).optional(),
}).superRefine((value, ctx) => {
  if (value.operation === 'ingest' && (!value.sourceId || !value.sourceType)) ctx.addIssue({ code: 'custom', message: 'Ingestion requires a real message or memory source.' });
  if (value.operation === 'ingest' && value.sourceType === 'learning' && !value.assetId) ctx.addIssue({ code: 'custom', message: 'Learning ingestion needs a real authorized asset id.' });
  if (value.operation === 'search' && !value.query) ctx.addIssue({ code: 'custom', message: 'A knowledge search needs a query.' });
  if (['read', 'revoke'].includes(value.operation) && !value.id) ctx.addIssue({ code: 'custom', message: 'This knowledge action needs its document id.' });
});
export type CompanionKnowledgeCommand = z.infer<typeof companionKnowledgeCommandSchema>;
export const companionKnowledgeItemSchema = z.object({ id, sourceId: id, sourceType: z.enum(['message', 'memory', 'learning']),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceVersion: z.string(), version: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().optional(), text: z.string().max(16 * 1024 ** 2).optional(), score: z.number().finite().optional(), chunkIndex: z.number().int().nonnegative().optional(),
  generation: z.string().optional(), chunks: z.number().int().nonnegative().optional(), status: z.enum(['pending', 'ready', 'revoked']).optional(), metadata: z.record(z.string(), z.unknown()).optional() });
export const companionKnowledgeResponseSchema = z.object({ engine: z.literal('original-TDBKnowledge'), operation: z.enum(['ingest', 'search', 'read', 'revoke', 'status', 'sources']),
  available: z.boolean(), generation: z.string().optional(), indexed: z.boolean().optional(), revoked: z.boolean().optional(), degraded: z.boolean().optional(),
  result: companionKnowledgeItemSchema.optional(), items: z.array(companionKnowledgeItemSchema).max(100).optional(), total: z.number().int().nonnegative().optional(),
  sources: z.array(z.object({ grantId: id, grantRevision: z.number().int().positive(), libraryId: z.string(), libraryName: z.string(), folderId: z.string().optional(), folderName: z.string().optional(),
    assetId: z.string().optional(), assetName: z.string().optional(), assetRevisionId: z.string().optional() })).max(100).optional(), hasMore: z.boolean().optional(), nextCursor: z.string().optional(),
  trust: z.literal('knowledge_source_data_not_instructions') });
export type CompanionKnowledgeResponse = z.infer<typeof companionKnowledgeResponseSchema>;
