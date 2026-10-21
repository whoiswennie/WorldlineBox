import { z } from 'zod';
import { companionMemorySchema, companionMemoryTagSchema } from './companion-memory';
import { messageSchema } from './companions';
import { companionMemoryTagStatusSchema } from './companion-memory-tags';

const owner = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const relativePath = z.string().trim().min(1).max(1024);
const revision = z.string().min(1).max(160);
export const companionMemoryDocumentSchema = z.object({
  path: relativePath, name: z.string(), title: z.string(), directory: z.string(),
  kind: z.enum(['note', 'timeline', 'profile', 'document']),
  category: z.enum(['diary', 'material', 'self', 'world', 'timeline', 'profile', 'other']),
  updatedAt: z.string(), bytes: z.number().int().nonnegative(), revision,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  readOnly: z.boolean(), tags: z.array(companionMemoryTagSchema),
  autoTagsEnabled: z.boolean().optional(),
  syncState: z.enum(['indexed', 'pending', 'conflict', 'untracked', 'generated']),
  noteId: owner.optional(), version: z.number().int().positive().optional(),
  sourceConversationId: owner.optional(), sourceCount: z.number().int().nonnegative().optional(),
  captureMethod: z.enum(['automatic', 'manual']).optional(), excerpt: z.string().max(600).optional(),
});
export const companionMemoryDocumentsPageSchema = z.object({
  companionId: owner, directory: z.string(),
  folders: z.array(z.object({ path: z.string(), name: z.string(), count: z.number().int().nonnegative() })),
  items: z.array(companionMemoryDocumentSchema), hasMore: z.boolean(), nextCursor: z.string().optional(),
  total: z.number().int().nonnegative().optional(),
  index: z.object({ state: z.enum(['building', 'ready', 'error']), indexed: z.number().int().nonnegative(), total: z.number().int().nonnegative().optional(), error: z.string().optional() }).optional(),
});
export const companionMemoryDocumentReadSchema = z.object({
  document: companionMemoryDocumentSchema, content: z.string().max(2_000_000),
  memory: companionMemorySchema.optional(), sources: z.array(messageSchema).default([]),
  tagStatus: companionMemoryTagStatusSchema.optional(),
  hasMoreSources: z.boolean().default(false), nextSourceCursor: z.number().int().nonnegative().optional(),
});
/** Main-window human file management; never part of companion or execution-agent tools. */
export const companionMemoryDocumentCommands = [
  z.strictObject({ type: z.literal('memory.documents.tags.status'), companionId: owner, path: relativePath }),
  z.strictObject({ type: z.literal('memory.documents.tags.retry'), companionId: owner, path: relativePath, expectedRevision: revision }),
  z.strictObject({ type: z.literal('memory.documents.tags.cancel'), companionId: owner, path: relativePath, expectedRevision: revision }),
  z.strictObject({ type: z.literal('memory.documents.list'), companionId: owner,
    directory: z.string().max(1024).default(''), cursor: z.string().max(1024).optional(),
    query: z.string().trim().max(1000).optional(), tags: z.array(companionMemoryTagSchema).max(20).optional(), mode: z.enum(['keyword', 'semantic']).optional(),
    limit: z.number().int().min(1).max(256).default(64) }),
  z.strictObject({ type: z.literal('memory.documents.read'), companionId: owner, path: relativePath,
    sourceCursor: z.number().int().nonnegative().optional(), sourceLimit: z.number().int().min(1).max(100).default(30) }),
  z.strictObject({ type: z.literal('memory.documents.create'), companionId: owner, path: relativePath,
    autoTags: z.boolean().optional(),
    content: z.string().trim().min(1).max(65536), tags: z.array(companionMemoryTagSchema).max(50).default([]), diaryName: z.string().trim().min(1).max(160).optional(), sourceMessageId: owner.optional() }),
  z.strictObject({ type: z.literal('memory.documents.save'), companionId: owner, path: relativePath,
    autoTags: z.boolean().optional(),
    expectedRevision: revision, content: z.string().trim().min(1).max(65536),
    tags: z.array(companionMemoryTagSchema).max(50).optional(), diaryName: z.string().trim().min(1).max(160).optional() }),
  z.strictObject({ type: z.literal('memory.documents.move'), companionId: owner, path: relativePath, targetPath: relativePath, expectedRevision: revision }),
  z.strictObject({ type: z.literal('memory.documents.delete'), companionId: owner, path: relativePath, expectedRevision: revision }),
  z.strictObject({ type: z.literal('memory.documents.mkdir'), companionId: owner, path: relativePath }),
] as const;
export type CompanionMemoryDocument = z.infer<typeof companionMemoryDocumentSchema>;
export type CompanionMemoryDocumentsPage = z.infer<typeof companionMemoryDocumentsPageSchema>;
export type CompanionMemoryDocumentRead = z.infer<typeof companionMemoryDocumentReadSchema>;
export type CompanionMemoryDocumentCommand = z.infer<(typeof companionMemoryDocumentCommands)[number]>;
