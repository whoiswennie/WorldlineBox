import { z } from 'zod';

const owner = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), identifier = z.string().min(1).max(255);
export const companionLearningGrantSchema = z.object({
  id: owner, companionId: owner, libraryId: identifier, libraryName: z.string().max(255), libraryPath: z.string().max(4096),
  folderId: z.string().max(4096).optional(), folderName: z.string().max(255).optional(), enabled: z.boolean(), autonomous: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(1440), revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(), nextAt: z.string().optional(), status: z.enum(['idle', 'reading', 'waiting', 'failed']),
  error: z.string().optional(), reads: z.number().int().nonnegative().default(0),
});
export const companionLearningReadSchema = z.object({ id: owner, companionId: owner, grantId: owner, libraryId: identifier,
  assetId: identifier, assetRevisionId: identifier, assetName: z.string().max(512), offset: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(), contentHash: z.string().regex(/^[a-f0-9]{64}$/u), sourceMessageId: owner,
  readAt: z.string(), status: z.enum(['read', 'withdrawn']),
});
export const companionLearningStatusSchema = z.object({ grants: z.array(companionLearningGrantSchema), reads: z.array(companionLearningReadSchema),
  libraries: z.array(z.object({ libraryId: identifier, displayName: z.string(), folders: z.array(z.object({ id: z.string(), name: z.string() })) })).optional(),
});
export const companionLearningWorkspaceCommands = [
  z.strictObject({ type: z.literal('memory.learning.status'), companionId: owner }),
  z.strictObject({ type: z.literal('memory.learning.grant'), companionId: owner, libraryId: identifier, folderId: z.string().max(4096).optional(), autonomous: z.boolean().default(true), intervalMinutes: z.number().int().min(5).max(1440).default(30) }),
  z.strictObject({ type: z.literal('memory.learning.update'), companionId: owner, id: owner, expectedRevision: z.number().int().positive(), autonomous: z.boolean(), intervalMinutes: z.number().int().min(5).max(1440) }),
  z.strictObject({ type: z.literal('memory.learning.revoke'), companionId: owner, id: owner, expectedRevision: z.number().int().positive() }),
  z.strictObject({ type: z.literal('memory.learning.run'), companionId: owner, id: owner, expectedRevision: z.number().int().positive() }),
] as const;
export const companionLearningStorageCommands = [
  z.strictObject({ type: z.literal('learning.status'), companionId: owner }),
  z.strictObject({ type: z.literal('learning.grant'), companionId: owner, libraryId: identifier, libraryName: z.string().max(255), libraryPath: z.string().max(4096), folderId: z.string().max(4096).optional(), folderName: z.string().max(255).optional(), autonomous: z.boolean(), intervalMinutes: z.number().int().min(5).max(1440) }),
  z.strictObject({ type: z.literal('learning.update'), companionId: owner, id: owner, expectedRevision: z.number().int().positive(), autonomous: z.boolean(), intervalMinutes: z.number().int().min(5).max(1440) }),
  z.strictObject({ type: z.literal('learning.revoke'), companionId: owner, id: owner, expectedRevision: z.number().int().positive() }),
  z.strictObject({ type: z.literal('learning.run'), companionId: owner, id: owner, expectedRevision: z.number().int().positive() }),
  z.strictObject({ type: z.literal('learning.claim'), excludedOwners: z.array(owner).max(100).default([]), leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
  z.strictObject({ type: z.literal('learning.commit'), id: owner, leaseToken: owner, assetId: identifier, assetRevisionId: identifier, assetName: z.string().max(512), offset: z.number().int().nonnegative(), content: z.string().min(1).max(48000), nextOffset: z.number().int().positive().optional(), afterAssetId: identifier.optional(), more: z.boolean() }),
  z.strictObject({ type: z.literal('learning.advance'), id: owner, leaseToken: owner, afterAssetId: identifier.optional(), more: z.boolean(), reason: z.string().max(500).optional() }),
  z.strictObject({ type: z.literal('learning.defer'), id: owner, leaseToken: owner, error: z.string().max(500), state: z.enum(['waiting', 'failed']).optional(), retryAfterMs: z.number().int().min(1000).max(3600000).default(30000) }),
] as const;
export const companionLearningJobSchema = z.object({ id: owner, leaseToken: owner, grant: companionLearningGrantSchema,
  afterAssetId: identifier.optional(), assetId: identifier.optional(), assetRevisionId: identifier.optional(), offset: z.number().int().nonnegative().default(0) });
export type CompanionLearningGrant = z.infer<typeof companionLearningGrantSchema>;
export type CompanionLearningRead = z.infer<typeof companionLearningReadSchema>;
export type CompanionLearningJob = z.infer<typeof companionLearningJobSchema>;
export type CompanionLearningStatus = z.infer<typeof companionLearningStatusSchema>;
export type CompanionLearningWorkspaceCommand = z.infer<(typeof companionLearningWorkspaceCommands)[number]>;
