import { z } from 'zod';
import { companionRecoveryWorkspaceCommands, companionRecoveryChooseCommand, companionRecoveryResultSchema } from './companion-recovery';
import { companionJobCommands, companionJobDispositionSchema, companionJobPageSchema } from './companion-job-control';
import { companionLearningWorkspaceCommands, companionLearningStatusSchema } from './companion-learning';
import { companionLearningGoalWorkspaceCommands, companionLearningGoalSchema, companionLearningGoalPageSchema, companionLearningGoalRoundPageSchema } from './companion-learning-goals';
import { companionMemoryDocumentCommands, companionMemoryDocumentReadSchema, companionMemoryDocumentsPageSchema } from './companion-memory-documents';
import { companionInstanceSchema } from './companion-instance';
import { companionArtifactIdSchema } from './companion-artifact';
import { companionCognitionWorkspaceCommands, companionGrowthGoalSchema, companionGrowthJobSchema, companionContextSnapshotSchema, companionContextSnapshotSummarySchema } from './companion-cognition';

export const COMPANION_WORKSPACE_CHANNEL = 'worldlinebox:companion-workspace';
export const companionGrowthReleaseSchema = z.strictObject({ id: companionArtifactIdSchema, revision: z.number().int().positive(), content: z.string() });
const growthReleaseContinuationSchema = z.strictObject({ hasMore: z.boolean(), nextId: companionArtifactIdSchema.optional(), revocationEpoch: z.number().int().nonnegative().safe() });
export const companionGrowthReleasePageSchema = growthReleaseContinuationSchema.extend({ companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
  items: z.array(companionGrowthReleaseSchema).max(20) }).refine(page => !page.hasMore || !!page.items.length && page.nextId === page.items.at(-1)?.id, '成长记录分页凭据不完整。');
export const companionWorkspaceRequestSchema = z.discriminatedUnion('type', [
  ...companionRecoveryWorkspaceCommands,
  companionRecoveryChooseCommand,
  ...companionJobCommands,
  ...companionCognitionWorkspaceCommands,
  ...companionLearningWorkspaceCommands,
  ...companionLearningGoalWorkspaceCommands,
  z.strictObject({ type: z.literal('status') }),
  z.strictObject({ type: z.literal('choose') }),
  z.strictObject({ type: z.literal('select'), libraryId: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('reveal') }),
  z.strictObject({ type: z.literal('companion.assets.read'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u) }),
  z.strictObject({ type: z.literal('growth.releases.read'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), afterId: companionArtifactIdSchema.optional(), expectedRevocationEpoch: z.number().int().nonnegative().safe() }),
  z.strictObject({ type: z.literal('companion.assets.location'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u) }),
  ...companionMemoryDocumentCommands,
]);
export const companionWorkspaceLibrarySchema = z.object({ libraryId: z.string(), displayName: z.string(), libraryPath: z.string() });
export const companionWorkspaceResponseSchema = z.object({ ok: z.boolean(), error: z.string().optional(), cancelled: z.boolean().optional(),
  recovery: companionRecoveryResultSchema.optional(),
  recoveryPath:z.string().max(4096).optional(),
  jobDisposition: companionJobDispositionSchema.optional(),
  jobPage: companionJobPageSchema.optional(),
  growthJobs: z.array(companionGrowthJobSchema).max(20).optional(),
  growthReleasePage: companionGrowthReleasePageSchema.optional(),
  growthGoals: z.array(companionGrowthGoalSchema).max(40).optional(), growthGoal: companionGrowthGoalSchema.optional(),
  contextSnapshots: z.array(companionContextSnapshotSummarySchema).max(40).optional(), contextSnapshot: companionContextSnapshotSchema.optional(),
  contextSnapshotRetention: z.object({ limit: z.number().int().positive(), truncated: z.boolean(), policy: z.literal('recent_attempts_per_owner'), bodyLimitBytes: z.number().int().positive() }).optional(),
  selected: companionWorkspaceLibrarySchema.extend({ dataRoot: z.string(), memoryRoot: z.string() }).optional(),
  libraries: z.array(companionWorkspaceLibrarySchema).optional(),
  documents: companionMemoryDocumentsPageSchema.optional(), document: companionMemoryDocumentReadSchema.optional(),
  companionAssets: z.object({ companionId: z.string(), profileRevision: z.string(), promptRevision: z.string(),
    origin: z.object({ revision: z.string(), content: z.string() }).optional(),
    growthReleases: z.array(companionGrowthReleaseSchema).max(20).optional(),
    growthReleaseContinuation: growthReleaseContinuationSchema.optional(),
    root: z.string().optional(), instance: companionInstanceSchema.optional(),
    profile: z.object({ name: z.string(), description: z.string(), persona: z.string() }).optional(),
    memoryPolicyError: z.string().optional(),
    prompts: z.array(z.object({ path: z.string(), revision: z.string(), content: z.string(), purposes: z.array(z.string()) })).max(256) }).optional(),
  assetLocation: z.object({ libraryId: z.string(), libraryPath: z.string(), linkedFolderId: z.string(), relativePath: z.string() }).optional(),
  learning: companionLearningStatusSchema.optional(),
  learningGoal: companionLearningGoalSchema.optional(), learningGoals: companionLearningGoalPageSchema.optional(), learningRounds: companionLearningGoalRoundPageSchema.optional(),
  deletedPath: z.string().optional(), createdDirectory: z.string().optional() });
export type CompanionWorkspaceRequest = z.infer<typeof companionWorkspaceRequestSchema>;
export type CompanionWorkspaceResponse = z.infer<typeof companionWorkspaceResponseSchema>;
export type CompanionWorkspaceLibrary = z.infer<typeof companionWorkspaceLibrarySchema>;
