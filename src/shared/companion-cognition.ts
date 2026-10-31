import { z } from 'zod';
import { companionArtifactReferenceSchema } from './companion-artifact';
import { companionJobDispositionSchema } from './companion-job-control';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const companionGrowthGoalDraftSchema = z.strictObject({
  statement: z.string().trim().min(1).max(800), context: z.string().trim().min(1).max(600),
  examples: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
  counterexamples: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
  practice: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
});
export const companionGrowthGoalSchema = companionGrowthGoalDraftSchema.extend({
  id, companionId: id, conversationId: id, revision: z.number().int().positive(),
  status: z.enum(['proposed', 'practicing', 'reconsidering', 'paused', 'retired']),
  authorId: id, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  sources: z.array(z.strictObject({ messageId: id, revision: z.number().int().positive(), contentHash: hash })).min(1).max(16),
});
export type CompanionGrowthGoal = z.infer<typeof companionGrowthGoalSchema>;
export const companionGrowthJobSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u), companionId: id, conversationId: id,
  status: z.enum(['fixed', 'generating', 'generated', 'published', 'no_change', 'deferred', 'stale', 'interrupted', 'failed']),
  reason: z.string().max(2000), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  disposition: companionJobDispositionSchema.optional(),
});
export const companionGrowthStorageCommands = [
  z.strictObject({ type: z.literal('growth.goals.list'), companionId: id, conversationId: id,
    limit: z.number().int().min(1).max(40).default(20) }),
  z.strictObject({ type: z.literal('growth.goal.propose'), companionId: id, conversationId: id, operationId: id,
    goalId: id.optional(), expectedRevision: z.number().int().positive().optional(),
    sourceMessageIds: z.array(id).min(1).max(8), goal: companionGrowthGoalDraftSchema }),
  z.strictObject({ type: z.literal('growth.goal.transition'), companionId: id, conversationId: id, operationId: id,
    goalId: id, expectedRevision: z.number().int().positive(), status: z.enum(['proposed', 'paused', 'retired']), sourceMessageIds: z.array(id).min(1).max(8) }),
] as const;

export const companionStructuredRepairSchema = z.strictObject({
  rootInvocationId: z.string().min(1).max(500), previousInvocationId: z.string().min(1).max(500),
  attempt: z.number().int().min(1).max(2), reason: z.enum(['syntax', 'schema']), originalPurpose: z.string().min(1).max(120),
});
export const companionContextFrameSchema = z.strictObject({
  schema: z.literal('worldlinebox.companion-context-v2'), companionId: id, purpose: z.string().min(1).max(120),
  profileRevision: hash, promptRevision: hash,
  conversationId: id.optional(), taskId: id.optional(), invocationId: z.string().min(1).max(500).optional(),
  revocationEpoch: z.number().int().nonnegative().optional(),
  taskAssets: z.strictObject({ kind: z.literal('task_initial'), capturedAt: z.iso.datetime(), conversationId: id,
    sourceMessageId: id, invocationKey: id.optional(), digest: hash, socialJobId: id.optional() }).optional(),
  structuredRepair: companionStructuredRepairSchema.optional(),
  sourceRefs: z.array(companionArtifactReferenceSchema).max(512).optional(), dependencyRefs: z.array(companionArtifactReferenceSchema).max(512).optional(),
  identity: z.string().max(12000), roleGuidance: z.string().max(512 * 1024),
  processorContract: z.string().max(1024 * 1024),
  input: z.string().max(4 * 1024 * 1024),
});
export type CompanionContextFrame = z.infer<typeof companionContextFrameSchema>;
export const companionContextSnapshotSchema = z.strictObject({
  id, companionId: id, preparedAt: z.iso.datetime(), sentAt: z.iso.datetime().optional(), completedAt: z.iso.datetime().optional(), purpose: z.string(),
  status: z.enum(['prepared', 'dispatched', 'cancelled_before_send', 'response', 'network_error', 'unknown', 'redacted']),
  frame: companionContextFrameSchema, providerFormat: z.string().max(80), model: z.string().max(160),
  providerBody: z.string().max(6 * 1024 * 1024), bodyHash: hash,
  bodyStorage: z.literal('exact'), imageFallback: z.boolean(), httpStatus: z.number().int().min(100).max(599).optional(),
  revocationMode: z.literal('conservative_owner_revocation'),
  visualManifest: z.array(z.strictObject({ pointer: z.string().max(2048), delivery: z.enum(['inline_bytes', 'remote_url']), mime: z.string().max(160).optional(),
    bytes: z.number().int().nonnegative().optional(), sha256: hash.optional(), url: z.string().max(4096).optional() })).max(128),
  toolDeclarations: z.string().max(1024 * 1024),
});
export type CompanionContextSnapshot = z.infer<typeof companionContextSnapshotSchema>;
export const companionContextSnapshotSummarySchema = companionContextSnapshotSchema.omit({ frame: true, providerBody: true, toolDeclarations: true, visualManifest: true }).extend({
  profileRevision: hash, conversationId: id.optional(), taskId: id.optional(), invocationId: z.string().min(1).max(500).optional(),
  visualCount: z.number().int().nonnegative(), toolDeclarationBytes: z.number().int().nonnegative(),
  structuredRepair: companionStructuredRepairSchema.optional(),
});
export const companionCognitionWorkspaceCommands = [
  z.strictObject({ type: z.literal('growth.jobs.read'), companionId: id, limit: z.number().int().min(1).max(20).default(20) }),
  z.strictObject({ type: z.literal('cognition.context.list'), companionId: id, limit: z.number().int().min(1).max(40).default(20) }),
  z.strictObject({ type: z.literal('cognition.context.read'), companionId: id, id }),
  z.strictObject({ type: z.literal('growth.goals.read'), companionId: id, conversationId: id }),
  z.strictObject({ type: z.literal('growth.goals.propose'), companionId: id, conversationId: id, operationId: z.uuid(),
    goalId: id.optional(), expectedRevision: z.number().int().positive().optional(),
    feedback: z.string().trim().min(1).max(2000), goal: companionGrowthGoalDraftSchema }),
  z.strictObject({ type: z.literal('growth.goal.status'), companionId: id, conversationId: id, operationId: z.uuid(),
    goalId: id, expectedRevision: z.number().int().positive(), status: z.enum(['proposed', 'paused', 'retired']), feedback: z.string().trim().min(1).max(2000) }),
] as const;
