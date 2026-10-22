import { z } from 'zod';
import { companionMemoryDocumentDateFieldSchema, companionMemoryDocumentDateSchema, companionMemoryDocumentSchema, companionMemoryDocumentSortSchema } from './companion-memory-documents';

const owner = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const entry = z.object({ document: companionMemoryDocumentSchema, text: z.string().max(2_000_000), stamp: z.string().max(200) });
export const companionDocumentCatalogCommands = [
  z.strictObject({ type: z.literal('document.catalog.touch'), companionId: owner, path: z.string().max(1024), stamp: z.string().max(200), generation: z.string().max(100) }),
  z.strictObject({ type: z.literal('document.catalog.put'), companionId: owner, entries: z.array(entry).max(256), generation: z.string().max(100), folders: z.array(z.string().max(1024)).max(256).optional() }),
  z.strictObject({ type: z.literal('document.catalog.drop'), companionId: owner, paths: z.array(z.string().max(1024)).max(256) }),
  z.strictObject({ type: z.literal('document.catalog.finish'), companionId: owner, generation: z.string().max(100) }),
  z.strictObject({ type: z.literal('document.catalog.query'), companionId: owner, directory: z.string().max(1024).default(''), query: z.string().max(1000).default(''), tags: z.array(z.string().max(100)).max(20).default([]), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(256).default(64), noteIds: z.array(owner).max(256).optional(),
    sort: companionMemoryDocumentSortSchema.optional(), dateField: companionMemoryDocumentDateFieldSchema.optional(), from: companionMemoryDocumentDateSchema.optional(), to: companionMemoryDocumentDateSchema.optional() }),
] as const;
export const companionDocumentCatalogPageSchema = z.object({
  paths: z.array(z.string()), total: z.number().int().nonnegative(), hasMore: z.boolean(), nextCursor: z.string().optional(),
  pendingImport: z.number().int().nonnegative().optional(),
  folders: z.array(z.object({ path: z.string(), name: z.string(), count: z.number().int().nonnegative() })),
});
export type CompanionDocumentCatalogCommand = z.infer<(typeof companionDocumentCatalogCommands)[number]>;
