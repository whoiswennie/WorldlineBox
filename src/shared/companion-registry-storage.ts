import { z } from 'zod';
import { companionArtifactConsumerSchema, companionArtifactHashSchema, companionArtifactIdSchema, companionArtifactKindSchema,
  companionArtifactPathSchema, companionArtifactReferenceSchema, companionArtifactSchema } from './companion-artifact';

const ownerId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
/** Transport capability, never a body field or stable publication hash input. */
export const companionFilePublicationGuardSchema = z.strictObject({ kind: z.enum(['source_files', 'history_files']), id: ownerId,
  leaseToken: ownerId, retryCycle: z.number().int().nonnegative().safe() });
export type CompanionFilePublicationGuard = z.infer<typeof companionFilePublicationGuardSchema>;
export const companionRegistryPublicationItemSchema = z.strictObject({ next: companionArtifactSchema, previous: companionArtifactSchema.optional(),
  stage: companionArtifactPathSchema, previousStage: companionArtifactPathSchema.optional(), expectedDiskHash: companionArtifactHashSchema.optional(), expectedAbsent: z.literal(true).optional() });
export const companionRegistryPublicationStateSchema = z.enum(['prepared', 'validated', 'file_published', 'committed', 'conflict', 'revoked', 'cancelled']);
export const companionRegistryPublicationSchema = z.strictObject({ operationId: companionArtifactIdSchema, ownerId,
  state: companionRegistryPublicationStateSchema, authorization: z.enum(['creation', 'system', 'retraction', 'memory_revalidation']),
  requestHash: companionArtifactHashSchema, items: z.array(companionRegistryPublicationItemSchema).min(1).max(128),
  reason: z.string().max(2000), createdAt: z.iso.datetime(), completedAt: z.iso.datetime().optional(), stagesCleanedAt: z.iso.datetime().optional() });
export type CompanionRegistryPublication = z.infer<typeof companionRegistryPublicationSchema>;
export const companionPublicationBusySchema = z.strictObject({ ownerId, operationId: companionArtifactIdSchema,
  blockingOperationId: companionArtifactIdSchema, reason: z.enum(['creation', 'artifact', 'path']) });
export type CompanionPublicationBusy = z.infer<typeof companionPublicationBusySchema>;
const publicationTarget = z.strictObject({ artifactId: companionArtifactIdSchema, relativePath: companionArtifactPathSchema,
  sourceRefs: z.array(companionArtifactReferenceSchema).max(512), dependencyRefs: z.array(companionArtifactReferenceSchema).max(512) });
export const companionRegistryStorageCommands = [
  z.strictObject({ type: z.literal('cognition.registry.read'), ownerId, artifactId: companionArtifactIdSchema.optional(),
    artifactIds: z.array(companionArtifactIdSchema).min(1).max(256).optional(), relativePath: companionArtifactPathSchema.optional(),
    relativePaths: z.array(companionArtifactPathSchema).min(1).max(256).optional(),
    includeRevoked: z.boolean().optional() }).refine(value => [value.artifactId, value.relativePath, value.artifactIds, value.relativePaths].filter(item => item !== undefined).length === 1, 'Choose one exact identity, identity batch, path, or path batch.'),
  z.strictObject({ type: z.literal('cognition.registry.page'), ownerId, consumer: companionArtifactConsumerSchema.optional(), kind: companionArtifactKindSchema.optional(),
    prefix: z.string().max(160).optional(), producerId: companionArtifactIdSchema.optional(), newestFirst: z.boolean().optional(),
    publicationState: z.enum(['committed', 'revoked']).optional(), bodyCleanupRequired: z.boolean().optional(),
    includeRevoked: z.boolean().optional(), afterId: companionArtifactIdSchema.optional(), limit: z.number().int().min(1).max(256).optional() }),
  z.strictObject({ type: z.literal('cognition.registry.body-removed'), ownerId, artifactId: companionArtifactIdSchema,
    contentRevision: z.number().int().positive(), contentHash: companionArtifactHashSchema }),
  z.strictObject({ type: z.literal('cognition.registry.publication.prepare'), ownerId, publication: companionRegistryPublicationSchema, fileJobGuard: companionFilePublicationGuardSchema.optional() }),
  z.strictObject({ type: z.literal('cognition.registry.publication.check'), ownerId, operationId: companionArtifactIdSchema,
    creation: z.boolean(), targets: z.array(publicationTarget).min(1).max(128) }),
  z.strictObject({ type: z.literal('cognition.registry.publication.read'), ownerId, operationId: companionArtifactIdSchema }),
  z.strictObject({ type: z.literal('cognition.registry.publication.pending'), ownerId, artifactId: companionArtifactIdSchema.optional(),
    baseRevision: z.number().int().positive().optional(), previousTarget: z.boolean().optional(),
    producerId: companionArtifactIdSchema.optional(), operationPrefix: z.string().max(160).optional(), afterOperationId: companionArtifactIdSchema.optional(),
    includeRevoked: z.boolean().optional(), uncleanedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(16).optional() }),
  z.strictObject({ type: z.literal('cognition.registry.publication.stages-cleaned'), ownerId, operationId: companionArtifactIdSchema }),
  z.strictObject({ type: z.literal('cognition.registry.publication.transition'), ownerId, operationId: companionArtifactIdSchema,
    expectedState: companionRegistryPublicationStateSchema, nextState: z.enum(['validated', 'file_published', 'conflict', 'revoked', 'cancelled']), fileJobGuard: companionFilePublicationGuardSchema.optional() }),
  z.strictObject({ type: z.literal('cognition.registry.publication.commit'), ownerId, operationId: companionArtifactIdSchema, fileJobGuard: companionFilePublicationGuardSchema.optional() }),
  z.strictObject({ type: z.literal('cognition.registry.refs.validate'), ownerId, references: z.array(companionArtifactReferenceSchema).max(512) }),
  z.strictObject({ type: z.literal('cognition.registry.revoke'), ownerId, artifactId: companionArtifactIdSchema }),
] as const;
export type CompanionRegistryStorageCommand = z.input<(typeof companionRegistryStorageCommands)[number]>;
export const companionRegistryStorageResponseShape = {
  registryArtifact: companionArtifactSchema.optional(),
  registryArtifacts: z.array(companionArtifactSchema).max(256).optional(),
  registryPage: z.strictObject({ items: z.array(companionArtifactSchema).max(256), hasMore: z.boolean(), nextId: companionArtifactIdSchema.optional() }).optional(),
  registryPublication: companionRegistryPublicationSchema.optional(),
  registryPublicationBusy: companionPublicationBusySchema.optional(),
  registryPending: z.array(companionRegistryPublicationSchema).max(16).optional(), registryReferencesValid: z.boolean().optional(),
  registryBodyRemoved: z.boolean().optional(),
  registryRevocation: z.strictObject({ artifactIds: z.array(companionArtifactIdSchema).max(256), affectedCount: z.number().int().nonnegative(),
    personaRepairRequired: z.boolean() }).optional(),
};
