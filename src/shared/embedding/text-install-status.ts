import { z } from 'zod';
import { LOCAL_TEXT_EMBEDDING_MODEL_ID } from './global-profile';
export const localTextEmbeddingInstallStatusSchema = z.strictObject({
  modelId: z.literal(LOCAL_TEXT_EMBEDDING_MODEL_ID), phase: z.enum(['missing', 'downloading', 'verifying', 'ready', 'failed']),
  installed: z.boolean(), runtimeInstalled: z.boolean(), revision: z.string(), installedRevision: z.string().nullable(),
  updateAvailable: z.boolean(), bytesDownloaded: z.number().nonnegative(), totalBytes: z.number().nonnegative(), error: z.string().nullable(),
});
