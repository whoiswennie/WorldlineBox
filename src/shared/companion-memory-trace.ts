import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionMemoryTraceAssetSchema = z.object({ libraryId: z.string().max(255), assetId: z.string().max(255), assetRevisionId: z.string().max(255),
  offset: z.number().int().nonnegative(), characters: z.number().int().nonnegative(), contentHash: z.string().max(128) });
export const companionMemoryTraceKindSchema = z.enum(['learning', 'journal', 'sleep', 'dream']);
export const companionMemoryTraceStageSchema = z.enum(['reading', 'capture', 'memory', 'index', 'tags', 'sleep', 'dream']);
export const companionMemoryTraceListCommand = z.strictObject({ type: z.literal('memory.trace.list'), companionId: id,
  kind: z.enum(['all', 'learning', 'journal', 'sleep', 'dream']).default('all'), query: z.string().trim().max(500).default(''),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(40).default(20) });
export const companionMemoryTraceInspectCommand = z.strictObject({ type: z.literal('memory.trace.inspect'), companionId: id,
  kind: companionMemoryTraceKindSchema, id, limit: z.number().int().min(1).max(20).default(10), stage: companionMemoryTraceStageSchema.optional(), cursor: z.string().max(4096).optional() });
export const companionMemoryTraceEntrySchema = z.object({ kind: companionMemoryTraceKindSchema, id, title: z.string().max(160), status: z.string().max(40),
  at: z.string().optional(), redacted: z.boolean(), version: z.number().int().positive().optional(),
  noteId: id.optional(), sourceMessageId: id.optional(), conversationId: id.optional(), asset: companionMemoryTraceAssetSchema.optional() });
export const companionMemoryTraceRecordSchema = z.object({ id: z.string().max(180), kind: z.enum(['learning', 'journal', 'sleep', 'dream', 'source', 'capture', 'index', 'tags', 'review']),
  title: z.string().max(160), status: z.string().max(40), at: z.string().optional(), noteId: id.optional(), version: z.number().int().positive().optional(),
  sourceMessageId: id.optional(), conversationId: id.optional(), relation: z.enum(['exact_source', 'shared_source', 'batch_output', 'dependency', 'reviewed_version', 'bound_version', 'delivery', 'root']),
  confidence: z.enum(['exact', 'shared_source']), detail: z.string().max(500), asset: companionMemoryTraceAssetSchema.optional(), worldJobId: id.optional(), sleepEpisodeId: id.optional(),
  captureBatchId: id.optional(), outputCount: z.number().int().min(0).max(100).optional(), outputs: z.array(z.object({ noteId: id, version: z.number().int().positive() })).max(100).optional() });
export const companionMemoryTracePageSchema = z.object({ companionId: id, entries: z.array(companionMemoryTraceEntrySchema).max(40), hasMore: z.boolean(), nextCursor: z.string().max(4096).optional(),
  index: z.object({ state: z.enum(['ready', 'indexing']), scope: z.literal('metadata'), indexed: z.number().int().nonnegative() }) });
export const companionMemoryTraceSchema = z.object({ companionId: id, root: companionMemoryTraceEntrySchema,
  stages: z.array(z.object({ kind: companionMemoryTraceStageSchema, label: z.string(), records: z.array(companionMemoryTraceRecordSchema).max(20), hasMore: z.boolean(), nextCursor: z.string().max(4096).optional() })).max(7), hasMore: z.boolean(), limitations: z.array(z.string().max(500)).max(10) });
export type CompanionMemoryTraceEntry = z.infer<typeof companionMemoryTraceEntrySchema>;
export type CompanionMemoryTraceRecord = z.infer<typeof companionMemoryTraceRecordSchema>;
export type CompanionMemoryTracePage = z.infer<typeof companionMemoryTracePageSchema>;
export type CompanionMemoryTrace = z.infer<typeof companionMemoryTraceSchema>;
