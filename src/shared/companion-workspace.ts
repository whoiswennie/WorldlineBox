import { z } from 'zod';
import { companionLearningWorkspaceCommands, companionLearningStatusSchema } from './companion-learning';
import { companionLearningGoalWorkspaceCommands, companionLearningGoalSchema, companionLearningGoalPageSchema, companionLearningGoalRoundPageSchema } from './companion-learning-goals';
import { companionMemoryDocumentCommands, companionMemoryDocumentReadSchema, companionMemoryDocumentsPageSchema } from './companion-memory-documents';
import { companionModelResourceUsageSchema } from './companion-model-resources';
import { companionInstanceSchema } from './companion-instance';

export const COMPANION_WORKSPACE_CHANNEL = 'worldlinebox:companion-workspace';
export const companionWorkspaceRequestSchema = z.discriminatedUnion('type', [
  ...companionLearningWorkspaceCommands,
  ...companionLearningGoalWorkspaceCommands,
  z.strictObject({ type: z.literal('status') }),
  z.strictObject({ type: z.literal('choose') }),
  z.strictObject({ type: z.literal('select'), libraryId: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('reveal') }),
  z.strictObject({ type: z.literal('model.resources.read'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u) }),
  z.strictObject({ type: z.literal('model.resources.save'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u), content: z.string().min(1).max(65536) }),
  z.strictObject({ type: z.literal('companion.assets.read'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u) }),
  z.strictObject({ type: z.literal('companion.assets.location'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u) }),
  z.strictObject({ type: z.literal('companion.assets.profile.save'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u), profile: z.strictObject({ name: z.string().trim().min(1).max(60), description: z.string().max(500), persona: z.string().min(1).max(12000) }) }),
  z.strictObject({ type: z.literal('companion.assets.prompt.save'), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
    path: z.string().min(1).max(768), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u), content: z.string().min(1).max(128 * 1024).refine(value => !!value.trim()) }),
  ...companionMemoryDocumentCommands,
]);
export const companionWorkspaceLibrarySchema = z.object({ libraryId: z.string(), displayName: z.string(), libraryPath: z.string() });
export const companionWorkspaceResponseSchema = z.object({ ok: z.boolean(), error: z.string().optional(), cancelled: z.boolean().optional(),
  selected: companionWorkspaceLibrarySchema.extend({ dataRoot: z.string(), memoryRoot: z.string() }).optional(),
  libraries: z.array(companionWorkspaceLibrarySchema).optional(),
  documents: companionMemoryDocumentsPageSchema.optional(), document: companionMemoryDocumentReadSchema.optional(),
  modelResources: z.object({ companionId: z.string(), path: z.string(), revision: z.string(), content: z.string(), usage: companionModelResourceUsageSchema }).optional(),
  companionAssets: z.object({ companionId: z.string(), profileRevision: z.string(), promptRevision: z.string(),
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
