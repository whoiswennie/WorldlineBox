import { z } from 'zod';
import { companionArtifactSchema, companionArtifactPathSchema } from './companion-artifact';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const companionRecoverySnapshotSchema = z.strictObject({ id: z.uuid(), libraryId: z.string().min(1).max(100), lineageId: z.uuid(), generation: z.number().int().nonnegative().safe(),
  ledgerHash: hash, ledgerSize: z.number().int().positive().safe(), catalogHash: hash, catalogSize: z.number().int().nonnegative().safe(),
  owners: z.number().int().nonnegative().max(100000), entries: z.number().int().nonnegative().max(1000000) });
export type CompanionRecoverySnapshot = z.infer<typeof companionRecoverySnapshotSchema>;
export const companionRecoveryCatalogEntrySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('artifact'), artifact: companionArtifactSchema }),
  z.strictObject({ type: z.literal('owner'), id, avatar: z.string().max(100), avatarAttachmentId: id.optional(), appearanceAttachmentId: id.optional() }),
  z.strictObject({ type: z.literal('attachment'), id, relativePath: z.string().regex(/^attachments\/[a-zA-Z0-9_-]{1,100}(?:\.[a-zA-Z0-9]{1,16})?$/u) }),
  z.strictObject({ type: z.literal('external_attachment'), id }),
]);
export type CompanionRecoveryCatalogEntry = z.infer<typeof companionRecoveryCatalogEntrySchema>;
export const companionRecoveryFileSchema = z.strictObject({ area: z.enum(['owner', 'attachment']), ownerId: id.optional(), relativePath: companionArtifactPathSchema,
  hash, size: z.number().int().nonnegative().safe(), artifactId: z.string().max(160).optional(), artifactRevision: z.number().int().positive().optional() });
export type CompanionRecoveryFile = z.infer<typeof companionRecoveryFileSchema>;
export const companionRecoveryManifestSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-backup-v1'), snapshot: companionRecoverySnapshotSchema,
  operationPayloadHash:hash,
  createdAt: z.iso.datetime(), filesHash: hash, filesSize: z.number().int().nonnegative().safe(), files: z.number().int().nonnegative().max(1000000),
  contentBytes: z.number().int().nonnegative().safe(), externalAttachments: z.number().int().nonnegative() });
export type CompanionRecoveryManifest = z.infer<typeof companionRecoveryManifestSchema>;
export const companionRecoveryResultSchema = z.strictObject({ operationId: z.uuid(), packagePath: z.string().max(4096), manifestHash: hash,
  libraryId: z.string().max(100), lineageId: z.uuid(), generation: z.number().int().nonnegative().safe(), files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
  mode: z.enum(['backup', 'database', 'current_files']), restoredFiles: z.number().int().nonnegative().optional(), heldOwners: z.number().int().nonnegative().optional(),
  requiresReview: z.boolean().optional(), historicalReplay:z.boolean().optional(), databaseRestoreAvailable:z.boolean().optional(), unavailableReason:z.string().max(1000).optional(), externalAttachments:z.number().int().nonnegative().optional() });
export type CompanionRecoveryResult = z.infer<typeof companionRecoveryResultSchema>;
export const companionRecoveryWorkspaceCommands = [
  z.strictObject({ type: z.literal('recovery.backup.create'), libraryId:z.string().min(1).max(100), operationId: z.uuid(), destinationParent: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('recovery.package.inspect'), packagePath: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('recovery.restore'), libraryId:z.string().min(1).max(100), operationId: z.uuid(), packagePath: z.string().min(1).max(4096), expectedManifestHash: hash, mode: z.enum(['database', 'current_files']) }),
] as const;
export const companionRecoveryReviewCommand = z.strictObject({type:z.literal('recovery.review.complete'),companionId:id});
export const companionRecoveryReviewPageCommand = z.strictObject({type:z.literal('recovery.review.page'),afterId:id.optional(),limit:z.number().int().positive().max(50).default(30)});
export const companionRecoveryChooseCommand=z.strictObject({type:z.literal('recovery.choose'),kind:z.enum(['backup_destination','package'])});
export const companionRecoveryCommandSchema=z.discriminatedUnion('type',companionRecoveryWorkspaceCommands);
export type CompanionRecoveryCommand=z.infer<typeof companionRecoveryCommandSchema>;
