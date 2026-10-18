/**
 * Semantic image input limits.
 * Covers count as images. Video frames are not a semantic input in this release.
 *
 * Local EmbeddingGemma runs llama-server with `--ctx-size 4096 --batch-size 4096
 * --ubatch-size 4096` and an mmproj. A raw 1080p frame can fill that batch.
 * 768px stays under a typical Gemma vision canvas, and library posters are
 * already width 640, so a cover usually passes through unchanged.
 * 1.5 MiB is the JPEG payload cap after that fit.
 */

export const GEMMA_SEMANTIC_IMAGE_MAX_EDGE_PX = 768;
export const GEMMA_SEMANTIC_IMAGE_MAX_BYTES = 1_572_864;

/** Filled in when a saved custom service has no image limits yet. */
export const CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX = 2048;
export const CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES = 10 * 1024 * 1024;

export const SEMANTIC_IMAGE_EDGE_MIN = 256;
export const SEMANTIC_IMAGE_EDGE_MAX = 4096;
export const SEMANTIC_IMAGE_BYTES_MIN = 1 * 1024 * 1024;
export const SEMANTIC_IMAGE_BYTES_MAX = 20 * 1024 * 1024;

/** Worker read ceiling. The model limit is applied after this, by downscaling. */
export const SEMANTIC_IMAGE_DECODE_MAX_BYTES = 64 * 1024 * 1024;

export function normalizeSemanticImageEdgePx(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < SEMANTIC_IMAGE_EDGE_MIN || value > SEMANTIC_IMAGE_EDGE_MAX) return null;
  return value;
}

export function normalizeSemanticImageBytes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < SEMANTIC_IMAGE_BYTES_MIN || value > SEMANTIC_IMAGE_BYTES_MAX) return null;
  return value;
}
