import { z } from 'zod';
import { companionMemoryFileReceiptsSchema } from './companion-memory-files';
import { companionWorldQuerySchema } from './companion-knowledge';
import { companionStateProposalSchema } from './companion-state';
import { companionMemoryProcessingCommand } from './companion-memory-processing';
import { companionCharacterDevelopmentCommand, companionCharacterDevelopmentDraftSchema } from './companion-character-development';
import { companionMemoryRetrievalOptionsSchema } from './companion-memory-modes';
import { companionMemoryProcedureProposalSchema, companionMemoryProcedureSchema, companionMemoryProcedureObservationCommand } from './companion-procedure';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
/** Ordered VCP tags; the host has no tag inference or retrieval algorithm. */
export const companionMemoryTagSchema = z.string().trim().min(1).max(100);
export const companionMemorySourceSchema = z.object({
    sourceType: z.enum(['message', 'world_observation', 'manual_input', 'asset_read']).optional(), messageId: id, conversationId: id,
    sequence: z.number().int().positive(), authorId: id, revision: z.number().int().positive(), checksum: z.string().max(128),
    createdAt: z.string(), worldCreatedAt: z.string().optional(), publishedAfterSequence: z.number().int().nonnegative().optional(),
});
/** Journal proposal, not a structured fact or another knowledge representation. */
export const companionMemoryCandidateSchema = z.strictObject({
    content: z.string().trim().min(1).max(65536), tags: z.array(companionMemoryTagSchema).max(50).default([]),
    occurredAt: z.string().max(100).optional(), diaryName: z.string().trim().min(1).max(160).optional(),
    sourceMessageIds: z.array(id).min(1).max(100), sourceChecksums: z.record(id, z.string().max(128)).optional(),
    evidence: z.array(z.object({ sourceMessageId: id, quote: z.string().min(1).max(16000) })).min(1).max(100),
    relatedMemoryIds: z.array(id).max(50).default([]), metadata: z.record(z.string(), z.unknown()).optional(),
    encoding: z.strictObject({ action: z.enum(['create', 'append', 'correct']), targetId: id.optional(), expectedVersion: z.number().int().positive().optional() })
      .refine(value => value.action === 'create' ? !value.targetId && value.expectedVersion === undefined : !!value.targetId && value.expectedVersion !== undefined,
        '延续或纠正必须固定已读目标版本。').optional(),
    selfDevelopment: companionCharacterDevelopmentDraftSchema.optional(),
    procedure: companionMemoryProcedureProposalSchema.optional().describe('可选的方法提案：applicability适用条件、steps步骤、limitations限制、verification.kind=artifact_delivery与artifactRequirements客观产物规则。只能提议，不能填写validation或自称已熟练；宿主按后续真实任务的客观交付核验。'),
    learnedEntranceSourceId: id.optional(),
});
export type CompanionMemoryCandidate = z.input<typeof companionMemoryCandidateSchema>;
export const companionMemoryConsolidateSchema = z.strictObject({ inputs: z.array(z.strictObject({ id, version: z.number().int().positive() })).min(2).max(50)
    .refine(inputs => new Set(inputs.map(input => input.id)).size === inputs.length, '整合来源不能重复。'), candidate: companionMemoryCandidateSchema });
export type CompanionMemoryConsolidation = z.output<typeof companionMemoryConsolidateSchema>;
export const companionMemorySchema = z.object({
    id, companionId: id, scopeId: id, content: z.string().trim().min(1).max(65536),
    tags: z.array(companionMemoryTagSchema), occurredAt: z.string().optional(), diaryName: z.string().optional(),
    sourceFile: z.string().max(4096).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
    sourceMessageId: id.optional(), sourceConversationId: id, sources: z.array(companionMemorySourceSchema),
    sourceSequence: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
    origin: z.enum(['user', 'companion']), status: z.enum(['queued', 'indexed', 'forgotten', 'invalid']),
    version: z.number().int().positive(), captureMethod: z.enum(['automatic', 'manual']),
    contentRevision: z.number().int().positive().optional(), annotationRevision: z.number().int().positive().optional(), semanticRevision: z.number().int().positive().optional(),
    procedure: companionMemoryProcedureSchema.optional(),
    archivedAt: z.string().optional(), supersededBy: id.optional(),
});
export const companionMemoryScopeSchema = z.object({ companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().optional() });
export const companionMemorySearchSchema = companionMemoryScopeSchema.extend({
    query: z.string().trim().max(16000).default(''), tags: z.array(companionMemoryTagSchema).max(50).default([]),
    diaryName: z.string().max(160).optional(), from: z.string().max(100).optional(), to: z.string().max(100).optional(),
    retrievalOptions: companionMemoryRetrievalOptionsSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20), cursor: z.number().int().nonnegative().optional(),
});
export type CompanionMemorySearch = z.input<typeof companionMemorySearchSchema>;
/** VCP's actual returned fields. Missing components remain absent, never zero-filled. */
export const companionMemoryScoreDetailsSchema = z.object({
    engine: z.enum(['river', 'knn']), rank: z.number().int().positive(), nativeRank: z.number().int().positive().optional(),
    finalScore: z.number().finite().optional(), originalScore: z.number().finite().optional(), vectorScore: z.number().finite().optional(),
    baseScore: z.number().finite().optional(), topologyBonus: z.number().finite().optional(), anchorBonus: z.number().finite().optional(), omega: z.number().finite().optional(),
    role: z.string().max(100).optional(), riverRegime: z.string().max(100).optional(),
    matchedTags: z.array(z.string().max(1024)).max(50).optional(), coreTagsMatched: z.array(z.string().max(1024)).max(50).optional(),
    candidateSources: z.array(z.string().max(100)).max(32).optional(), algorithmVersion: z.string().max(100).optional(), queryMode: z.string().max(100).optional(),
});
export type CompanionMemoryScoreDetails = z.infer<typeof companionMemoryScoreDetailsSchema>;
export const companionMemoryHitSchema = z.object({ memory: companionMemorySchema, score: z.number().optional(), scoreDetails: companionMemoryScoreDetailsSchema.optional(), reasons: z.array(z.string()), path: z.array(id) });
export const companionMemoryPageSchema = z.object({ items: z.array(companionMemoryHitSchema), hasMore: z.boolean(), nextCursor: z.number().int().nonnegative().optional() });
export type CompanionMemoryPage = z.infer<typeof companionMemoryPageSchema>;
export const companionMemoryJobSchema = z.object({
    id, companionId: id, conversationId: id, sourceMessageIds: z.array(id), throughSequence: z.number().int().positive(),
    episodeId: id.optional(),
    leaseToken: id, attempts: z.number().int().positive(), sourceChecksums: z.record(id, z.string()), sourceRevisions: z.record(id, z.number().int().positive()),
});
export type CompanionMemoryJob = z.infer<typeof companionMemoryJobSchema>;
export const companionMemoryLifecycleStateSchema = z.object({ companionId: id, ledgerSequence: z.number().int().nonnegative(),
    revocationEpoch: z.number().int().nonnegative(), nextCaptureAt: z.string().optional() });
export const companionMemoryLifecycleChangeSchema = z.object({ sequence: z.number().int().positive(), companionId: id,
    kind: z.enum(['create', 'content', 'annotation', 'archive', 'revoke']), noteId: id.optional(),
    contentRevision: z.number().int().positive().optional(), annotationRevision: z.number().int().positive().optional(), semanticRevision: z.number().int().positive().optional(),
    sourceMessageIds: z.array(id), at: z.string() });
export const companionMemoryLifecycleChangesSchema = z.object({ changes: z.array(companionMemoryLifecycleChangeSchema),
    nextSequence: z.number().int().nonnegative(), hasMore: z.boolean() });
export type CompanionMemoryLifecycleState = z.infer<typeof companionMemoryLifecycleStateSchema>;
export type CompanionMemoryLifecycleChange = z.infer<typeof companionMemoryLifecycleChangeSchema>;
export const companionMemoryDomainSchema = z.object({ scopeId: id, companionId: id, conversationId: id,
    revision: z.number().int().positive(), state: z.enum(['dirty', 'ready']), updatedAt: z.string() });
export const companionMemoryOutboxSchema = z.object({
    id, companionId: id, scopeId: id, noteId: id, noteVersion: z.number().int().positive(), operation: z.enum(['remember', 'forget']),
    note: companionMemorySchema, leaseToken: id, attempts: z.number().int().positive(),
    maintenanceOnly: z.literal(true).optional(), contentAvailable: z.literal(false).optional(),
});
export type CompanionMemoryOutbox = z.infer<typeof companionMemoryOutboxSchema>;
export const companionMemorySourceOutboxSchema = z.object({ id, companionId: id, sourceId: id, sourceRevision: z.number().int().positive(),
    sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u), operation: z.enum(['publish', 'retract']), leaseToken: id, attempts: z.number().int().positive(),
    source: companionMemorySourceSchema.extend({ content: z.string().max(65536) }).optional() });
export type CompanionMemorySourceOutbox = z.infer<typeof companionMemorySourceOutboxSchema>;
export const companionMemorySnapshotSchema = z.object({ scopeId: id, revision: z.string(), semanticRevision: z.string().optional(), fileReceipts: companionMemoryFileReceiptsSchema.optional(),
    revocationEpoch: z.number().int().nonnegative().optional(), notes: z.array(companionMemorySchema) });
export const companionMemoryLibraryIndexStateSchema = z.object({ resetRevision: z.number().int().nonnegative(), throughOrdinal: z.number().int().nonnegative(), total: z.number().int().nonnegative() });
export const companionMemoryLibraryIndexPageSchema = z.object({ notes: z.array(companionMemorySchema), hasMore: z.boolean(), nextId: id.optional() });
export const companionMemoryLibraryChangesSchema = z.object({ changes: z.array(z.object({ ordinal: z.number().int().positive(), noteId: id, version: z.number().int().positive(), operation: z.enum(['remember', 'forget']), note: companionMemorySchema.optional() })),
    nextOrdinal: z.number().int().nonnegative(), hasMore: z.boolean() });
/** Internal policy input for semantic capture checks, never a memory/tool result. */
export const companionMemoryProhibitionSchema = z.object({
    id, tags: z.array(companionMemoryTagSchema).min(1), conversationId: z.union([id, z.literal('*')]),
    persistent: z.boolean(), throughSequence: z.number().int().nonnegative(),
});
export const companionMemoryPolicySchema = z.object({
    id, companionId: id, conversationId: z.string(), requestMessageId: id.optional(), requestSnippet: z.string(),
    reason: z.literal('persistent-topic'), tags: z.array(companionMemoryTagSchema).optional(),
    blocked: z.boolean(), createdAt: z.string(), releasedAt: z.string().optional(),
});
export const companionMemoryStatusSchema = z.object({
    pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(), memories: z.number().int().nonnegative(), forgotten: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(), pendingIndex: z.number().int().nonnegative(),
    messageWatermark: z.number().int().nonnegative(), captureWatermark: z.number().int().nonnegative(),
    lastError: z.string().optional(),
});
export const companionMemoryForgetSchema = companionMemoryScopeSchema.extend({
    id: id.optional(), sourceMessageIds: z.array(id).max(100).default([]), tag: companionMemoryTagSchema.optional(),
    persistent: z.boolean().default(false), requestMessageId: id.optional(),
});
export const companionMemoryPublicCommands = [
    companionCharacterDevelopmentCommand,
    companionMemoryProcessingCommand,
    companionMemoryScopeSchema.merge(companionWorldQuerySchema).extend({ type: z.literal('memory.world_query') }).strict(),
    companionMemorySearchSchema.extend({ type: z.literal('memory.search') }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.retrieval_modes') }).strict(),
    companionMemorySearchSchema.extend({ type: z.literal('memory.browse') }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.sources.filter'), ids: z.array(id).max(100) }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.records.filter'), ids: z.array(id).max(100) }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.read'), id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.inspect'), id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }).strict(),
    z.strictObject({ type: z.literal('memory.status'), companionId: id, conversationId: id.optional() }),
    z.strictObject({ type: z.literal('memory.jobs.retry'), companionId: id.optional() }),
    z.strictObject({ type: z.literal('memory.index.rebuild'), companionId: id.optional() }),
    z.strictObject({ type: z.literal('memory.policy.list'), companionId: id }),
    z.strictObject({ type: z.literal('memory.policy.release'), companionId: id, id }),
    companionMemoryForgetSchema.extend({ type: z.literal('memory.forget') }).strict(),
] as const;
export const companionMemoryStorageCommands = [
    z.strictObject({ type: z.literal('memory.sources.outbox.owners'), limit: z.number().int().min(1).max(128).default(4), excludedOwners: z.array(id).max(128).default([]) }),
    z.strictObject({ type: z.literal('memory.sources.outbox.claim'), companionId: id.optional(), leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
    z.strictObject({ type: z.literal('memory.sources.outbox.complete'), id, leaseToken: id }),
    z.strictObject({ type: z.literal('memory.sources.outbox.fail'), id, leaseToken: id, error: z.string().max(1000), retryAfterMs: z.number().int().min(1000).max(3600000).default(30000) }),
    companionMemoryProcedureObservationCommand,
    ...companionMemoryPublicCommands,
    z.strictObject({ type: z.literal('memory.lifecycle.state'), companionId: id }),
    z.strictObject({ type: z.literal('memory.lifecycle.changes'), companionId: id, afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(256).default(64) }),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.revision.read'), id, contentRevision: z.number().int().positive() }).strict(),
    z.strictObject({ type: z.literal('memory.library.page'), companionId: id, cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(256).default(64) }),
    z.strictObject({ type: z.literal('memory.library.scope'), companionId: id }),
    z.strictObject({ type: z.literal('memory.library.index-state'), companionId: id }),
    z.strictObject({ type: z.literal('memory.library.index-page'), companionId: id, resetRevision: z.number().int().nonnegative(), throughOrdinal: z.number().int().nonnegative(), afterId: id.optional(), limit: z.number().int().min(1).max(256).default(64) }),
    z.strictObject({ type: z.literal('memory.library.changes'), companionId: id, resetRevision: z.number().int().nonnegative(), throughOrdinal: z.number().int().nonnegative(), afterOrdinal: z.number().int().nonnegative(), limit: z.number().int().min(1).max(256).default(64) }),
    z.strictObject({ type: z.literal('memory.library.read'), companionId: id, id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }),
    z.strictObject({ type: z.literal('memory.library.delete'), companionId: id, id, expectedVersion: z.number().int().positive() }),
    z.strictObject({ type: z.literal('memory.library.organize'), companionId: id, id, expectedVersion: z.number().int().positive(), tags: z.array(companionMemoryTagSchema).max(50), diaryName: z.string().trim().min(1).max(160), autoTags: z.boolean().optional(), expectedProhibitionRevision: z.string().min(1).max(128).optional() }),
    z.strictObject({ type: z.literal('memory.operation.inspect'), companionId: id, operationId: id }),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.domains') }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.snapshot') }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.prohibitions'), sourceMessageIds: z.array(id).min(1).max(100).optional(), noteId: id.optional(), worldJobId: id.optional() }).strict(),
    z.strictObject({ type: z.literal('memory.jobs.claim'), companionId: id.optional(), leaseMs: z.number().int().min(1000).max(600000).default(120000), force: z.boolean().default(false) }),
    z.strictObject({ type: z.literal('memory.jobs.complete'), id, leaseToken: id, notes: z.array(companionMemoryCandidateSchema).max(100), stateProposal: companionStateProposalSchema.optional(), expectedStateRevision: z.number().int().positive().optional(), expectedProhibitionRevision: z.string().min(1).max(128).optional() }),
    z.strictObject({ type: z.literal('memory.jobs.fail'), id, leaseToken: id, error: z.string().max(1000), retryAfterMs: z.number().int().min(0).max(86400000).default(30000) }),
    z.strictObject({ type: z.literal('memory.outbox.claim'), companionId: id.optional(), leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
    z.strictObject({ type: z.literal('memory.outbox.complete'), id, leaseToken: id, sourceFile: z.string().max(4096).optional(), indexed: z.boolean() }),
    z.strictObject({ type: z.literal('memory.outbox.fail'), id, leaseToken: id, error: z.string().max(1000), retryAfterMs: z.number().int().min(0).max(86400000).default(30000) }),
    z.strictObject({ type: z.literal('memory.outbox.defer'), id, leaseToken: id, retryAfterMs: z.number().int().min(100).max(30000).default(1000) }),
    z.strictObject({ type: z.literal('memory.outbox.retry'), companionId: id.optional() }),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.record'), candidate: companionMemoryCandidateSchema, operationId: id.optional(), expectedProhibitionRevision: z.string().min(1).max(128).optional() }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.revise'), id, expectedVersion: z.number().int().positive(), candidate: companionMemoryCandidateSchema, operationId: id.optional(), expectedProhibitionRevision: z.string().min(1).max(128).optional() }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.organize'), ids: z.array(id).min(1).max(100), tags: z.array(companionMemoryTagSchema).max(50).default([]), operationId: id.optional(), expectedProhibitionRevision: z.string().min(1).max(128).optional() }).strict(),
    companionMemoryScopeSchema.extend({ type: z.literal('memory.consolidate'), ...companionMemoryConsolidateSchema.shape,
      operationId: id.optional(), expectedProhibitionRevision: z.string().min(1).max(128).optional() }).strict(),
] as const;
