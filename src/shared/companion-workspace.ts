import { z } from 'zod';
import { companionLearningWorkspaceCommands, companionLearningStatusSchema } from './companion-learning';
import { companionLearningGoalWorkspaceCommands, companionLearningGoalSchema, companionLearningGoalPageSchema, companionLearningGoalRoundPageSchema } from './companion-learning-goals';
import { companionMemoryDocumentCommands, companionMemoryDocumentReadSchema, companionMemoryDocumentsPageSchema } from './companion-memory-documents';

export const COMPANION_WORKSPACE_CHANNEL = 'worldlinebox:companion-workspace';
export const companionWorkspaceRequestSchema = z.discriminatedUnion('type', [
  ...companionLearningWorkspaceCommands,
  ...companionLearningGoalWorkspaceCommands,
  z.strictObject({ type: z.literal('status') }),
  z.strictObject({ type: z.literal('choose') }),
  z.strictObject({ type: z.literal('select'), libraryId: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('reveal') }),
  ...companionMemoryDocumentCommands,
]);
export const companionWorkspaceLibrarySchema = z.object({ libraryId: z.string(), displayName: z.string(), libraryPath: z.string() });
export const companionWorkspaceResponseSchema = z.object({ ok: z.boolean(), error: z.string().optional(), cancelled: z.boolean().optional(),
  selected: companionWorkspaceLibrarySchema.extend({ dataRoot: z.string(), memoryRoot: z.string() }).optional(),
  libraries: z.array(companionWorkspaceLibrarySchema).optional(),
  documents: companionMemoryDocumentsPageSchema.optional(), document: companionMemoryDocumentReadSchema.optional(),
  learning: companionLearningStatusSchema.optional(),
  learningGoal: companionLearningGoalSchema.optional(), learningGoals: companionLearningGoalPageSchema.optional(), learningRounds: companionLearningGoalRoundPageSchema.optional(),
  deletedPath: z.string().optional(), createdDirectory: z.string().optional() });
export type CompanionWorkspaceRequest = z.infer<typeof companionWorkspaceRequestSchema>;
export type CompanionWorkspaceResponse = z.infer<typeof companionWorkspaceResponseSchema>;
export type CompanionWorkspaceLibrary = z.infer<typeof companionWorkspaceLibrarySchema>;
