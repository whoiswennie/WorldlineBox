import { z } from 'zod';
import { dshRepositorySchema } from './dsh-marketplace';
import { dshNodePackRuntimeLockSchema, dshPackRuntimeV1Schema } from './dsh-pack-runtime';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const distributionShape = {
  name: z.string().trim().min(1).max(100), version: z.string().trim().min(1).max(100), createdAt: z.string(),
  archive: z.strictObject({ fileName: z.string().min(1).max(200), byteLength: z.number().int().min(1).max(8 * 1024 ** 3),
    sha256, url: z.string().max(4096).optional() }),
  lock: z.strictObject({ contentSha256: sha256, fileCount: z.number().int().min(0).max(150_000), byteLength: z.number().int().min(0).max(8 * 1024 ** 3),
    files: z.array(z.strictObject({ path: z.string().max(2000), sha256, size: z.number().int().min(0).max(1024 ** 3) })).max(150_000) }),
};
export const dshPackDistributionSchema = z.discriminatedUnion('format', [
  z.strictObject({ ...distributionShape, format: z.literal('worldlinebox-dshpack-distribution-v1'), runtime: dshPackRuntimeV1Schema }),
  z.strictObject({ ...distributionShape, format: z.literal('worldlinebox-dshpack-distribution-v2'), runtime: dshNodePackRuntimeLockSchema }),
]);
export type DshPackDistribution = z.infer<typeof dshPackDistributionSchema>;
export const dshPackPublicationSchema = z.object({ repository: dshRepositorySchema, tag: z.string().min(1).max(100),
  releaseUrl: z.string().max(4096), manifestUrl: z.string().max(4096), archiveUrl: z.string().max(4096), draft: z.boolean() });
export type DshPackPublication = z.infer<typeof dshPackPublicationSchema>;
