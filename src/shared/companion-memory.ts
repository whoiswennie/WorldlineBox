import { z } from 'zod';
import { companionStateProposalSchema } from './companion-state';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionMemoryKindSchema = z.enum(['fact', 'preference', 'agreement', 'event', 'task', 'reflection', 'knowledge', 'overview', 'hypothesis']);
export const companionMemoryTagSchema = z.object({
  id: id.optional(), name: z.string().trim().min(1).max(100),
  type: z.enum(['person', 'project', 'place', 'organization', 'event', 'topic', 'condition']).default('topic'),
  aliases: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});
export const companionMemorySourceSchema = z.object({
  messageId: id, conversationId: id, sequence: z.number().int().positive(), authorId: id,
  revision: z.number().int().positive(), checksum: z.string().max(128), createdAt: z.string(),
  publishedAfterSequence: z.number().int().nonnegative().optional(),
});
export const companionMemoryCandidateSchema = z.strictObject({
  content: z.string().trim().min(1).max(4000), kind: companionMemoryKindSchema,
  sourceMessageIds: z.array(id).min(1).max(50),
  sourceChecksums: z.record(id, z.string().max(128)).optional(),
  evidence: z.array(z.object({ sourceMessageId: id, quote: z.string().min(1).max(4000) })).max(50).default([]),
  subject: z.string().trim().max(160).optional(), factKey: z.string().trim().max(160).optional(),
  value: z.string().max(2000).optional(), qualifier: z.string().max(500).optional(),
  polarity: z.enum(['positive', 'negative']).default('positive'),
  epistemicStatus: z.enum(['asserted', 'confirmed', 'subjective', 'hypothesis', 'conflict']).default('asserted'),
  eventId: id.optional(), eventStatus: z.enum(['planned', 'ongoing', 'completed', 'cancelled', 'reconsidering']).optional(),
  validFrom: z.string().max(100).optional(), validTo: z.string().max(100).optional(),
  tags: z.array(companionMemoryTagSchema).max(30).default([]),
  relatedMemoryIds: z.array(id).max(20).default([]),
  relationType: z.enum(['related', 'continues', 'part_of', 'participates', 'causes']).default('related'),
  correction: z.boolean().default(false),
});
export type CompanionMemoryCandidate = z.input<typeof companionMemoryCandidateSchema>;
export const companionMemorySchema = z.object({
  id, companionId: id, content: z.string().trim().min(1).max(4000),
  sourceMessageId: id.optional(), sourceConversationId: id.optional(),
  createdAt: z.string(), updatedAt: z.string(), origin: z.enum(['user', 'companion']),
  kind: companionMemoryKindSchema.optional(), subject: z.string().optional(), factKey: z.string().optional(),
  value: z.string().optional(), qualifier: z.string().optional(), polarity: z.enum(['positive', 'negative']).optional(),
  epistemicStatus: z.enum(['asserted', 'confirmed', 'subjective', 'hypothesis', 'conflict', 'unverified']).optional(),
  status: z.enum(['active', 'superseded', 'forgotten', 'invalid', 'conflict']).optional(),
  version: z.number().int().positive().optional(), sourceSequence: z.number().int().nonnegative().optional(),
  sources: z.array(companionMemorySourceSchema).optional(), tags: z.array(companionMemoryTagSchema).optional(),
  eventId: id.optional(), eventStatus: z.enum(['planned', 'ongoing', 'completed', 'cancelled', 'reconsidering']).optional(),
  validFrom: z.string().optional(), validTo: z.string().optional(), supersedesId: id.optional(),
  captureMethod: z.enum(['automatic', 'manual']).optional(),
});
export const companionMemoryScopeSchema = z.object({ companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().optional() });
export const companionMemorySearchSchema = companionMemoryScopeSchema.extend({
  query: z.string().trim().max(1000).default(''), terms: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
  subject: z.string().max(160).optional(), factKey: z.string().max(160).optional(), eventId: id.optional(),
  tags: z.array(z.string().max(100)).max(30).default([]), includeHistory: z.boolean().default(false),
  kind: companionMemoryKindSchema.optional(), status: z.enum(['active', 'superseded', 'forgotten', 'invalid', 'conflict']).optional(),
  from: z.string().max(100).optional(), to: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).default(20), cursor: z.number().int().nonnegative().optional(),
  sourceCursor: z.number().int().nonnegative().optional(),
});
export type CompanionMemorySearch = z.input<typeof companionMemorySearchSchema>;
export const companionMemoryHitSchema = z.object({ memory: companionMemorySchema, reasons: z.array(z.string()), path: z.array(id) });
export const companionMemoryPageSchema = z.object({ items: z.array(companionMemoryHitSchema), hasMore: z.boolean(), nextCursor: z.number().int().nonnegative().optional() });
export type CompanionMemoryPage = z.infer<typeof companionMemoryPageSchema>;
export const companionMemoryJobSchema = z.object({
  id, companionId: id, conversationId: id, sourceMessageIds: z.array(id), throughSequence: z.number().int().positive(),
  leaseToken: id, attempts: z.number().int().positive(),
  sourceChecksums: z.record(id, z.string()).optional(),
  sourceRevisions: z.record(id, z.number().int().positive()).optional(),
});
export type CompanionMemoryJob = z.infer<typeof companionMemoryJobSchema>;
export const companionMemoryStatusSchema = z.object({
  pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(), memories: z.number().int().nonnegative(), forgotten: z.number().int().nonnegative(),
  messageWatermark: z.number().int().nonnegative(), extractionWatermark: z.number().int().nonnegative(),
  backfillThrough: z.number().int().nonnegative(), backfillTarget: z.number().int().nonnegative(),
  lastError: z.string().optional(),
});
export const companionMemoryForgetSchema = companionMemoryScopeSchema.extend({
  id: id.optional(), sourceMessageIds: z.array(id).max(100).default([]),
  subject: z.string().max(160).optional(), factKey: z.string().max(160).optional(), tag: z.string().max(100).optional(),
  persistent: z.boolean().default(false), requestMessageId: id.optional(),
});
export const companionMemoryPublicCommands = [
  companionMemorySearchSchema.extend({ type: z.literal('memory.search') }).strict(),
  companionMemorySearchSchema.extend({ type: z.literal('memory.browse') }).strict(),
  companionMemorySearchSchema.extend({ type: z.literal('memory.sources.search') }).strict(),
  companionMemoryScopeSchema.extend({ type: z.literal('memory.sources.filter'), ids: z.array(id).max(100) }).strict(),
  companionMemoryScopeSchema.extend({ type: z.literal('memory.records.filter'), ids: z.array(id).max(100), includeHistory: z.boolean().default(false) }).strict(),
  companionMemoryScopeSchema.extend({ type: z.literal('memory.read'), id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }).strict(),
  companionMemoryScopeSchema.extend({ type: z.literal('memory.inspect'), id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }).strict(),
  z.strictObject({ type: z.literal('memory.status'), companionId: id, conversationId: id.optional() }),
  z.strictObject({ type: z.literal('memory.jobs.retry'), companionId: id.optional() }),
  companionMemoryForgetSchema.extend({ type: z.literal('memory.forget') }).strict(),
] as const;
export const companionMemoryStorageCommands = [
  ...companionMemoryPublicCommands,
  z.strictObject({ type: z.literal('memory.jobs.claim'), companionId: id.optional(), leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
  z.strictObject({ type: z.literal('memory.jobs.complete'), id, leaseToken: id, candidates: z.array(companionMemoryCandidateSchema).max(100), stateProposal: companionStateProposalSchema.optional() }),
  z.strictObject({ type: z.literal('memory.jobs.fail'), id, leaseToken: id, error: z.string().max(1000), retryAfterMs: z.number().int().min(0).max(86400000).default(30000) }),
  z.strictObject({ type: z.literal('memory.jobs.backfill'), limit: z.number().int().min(1).max(500).default(200) }),
  z.strictObject({ type: z.literal('memory.index.rebuild') }),
  companionMemoryScopeSchema.extend({ type: z.literal('memory.record'), candidate: companionMemoryCandidateSchema }).strict(),
  companionMemoryScopeSchema.extend({ type: z.literal('memory.revise'), id, expectedVersion: z.number().int().positive(), candidate: companionMemoryCandidateSchema }).strict(),
  companionMemoryScopeSchema.extend({ type: z.literal('memory.organize'), ids: z.array(id).min(1).max(100), tags: z.array(companionMemoryTagSchema).max(30).default([]), eventId: id.optional() }).strict(),
] as const;
