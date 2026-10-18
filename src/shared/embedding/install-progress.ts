import { z } from "zod";

import { SEMANTIC_SEARCH_MODEL_IDS } from "./profile";

export const embeddingInstallProgressSchema = z.strictObject({
  modelId: z.enum(SEMANTIC_SEARCH_MODEL_IDS),
  phase: z.enum(["downloading-model", "downloading-runtime", "extracting", "ready", "failed"]),
  bytesDownloaded: z.number().nonnegative(),
  totalBytes: z.number().positive().optional(),
  fileName: z.string().min(1).max(260).optional(),
  message: z.string().min(1).max(2_000).optional(),
});

export type EmbeddingInstallProgress = z.infer<typeof embeddingInstallProgressSchema>;
