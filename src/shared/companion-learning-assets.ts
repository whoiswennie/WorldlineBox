import { z } from 'zod';
import { assetSummarySchema } from './asset-types';
export const companionLearningAssetPageSchema = z.object({ assets: z.array(assetSummarySchema), hasMore: z.boolean(), nextCursor: z.string().optional() });
export const companionLearningAssetPageCommandSchema = z.strictObject({ type: z.literal('asset.learning.page'), libraryId: z.string().min(1).max(255),
  folderId: z.string().max(4096).optional(), assetId: z.string().max(255).optional(), afterId: z.string().max(255).optional(), limit: z.number().int().min(1).max(128).default(32) });
