import { z } from 'zod';
import { isEmbeddingSelectionId } from './http-service';

/** One device-wide selection for memory and libraries that inherit the default. */
export const globalEmbeddingSettingsSchema = z.strictObject({
  version: z.literal(1),
  selectionId: z.string().refine(isEmbeddingSelectionId).nullable(),
});
export type GlobalEmbeddingSettings = z.output<typeof globalEmbeddingSettingsSchema>;
export const DEFAULT_GLOBAL_EMBEDDING_SETTINGS: GlobalEmbeddingSettings = { version: 1, selectionId: 'embeddinggemma-2-compact' };
