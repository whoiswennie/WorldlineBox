/**
 * Modalities an embedding model claims it can encode.
 * A claim is not proof the current adapter can use that channel.
 */

export const EMBEDDING_MODALITIES = ["image", "video", "audio", "text"] as const;
export type EmbeddingModality = (typeof EMBEDDING_MODALITIES)[number];

/** Input forms the local EmbeddingGemma runtime can send to the fixed llama-server. */
export const LOCAL_GEMMA_INPUT_MODALITIES = ["image", "video", "audio", "text"] as const;

/** Model card capabilities exposed by the fixed local runtime. */
export const LOCAL_GEMMA_MODALITIES: readonly EmbeddingModality[] = ["image", "video", "audio", "text"];

export type EmbeddingSourceModality = (typeof LOCAL_GEMMA_INPUT_MODALITIES)[number];

/**
 * What this release actually prepares for local semantic indexing.
 * Video assets use the cover image. Multi-frame / `input_video` sampling
 * may return later; it is not a product path here.
 * A video with no cover yet is not a target until a thumbnail-ready event.
 */
export const LOCAL_SEMANTIC_ENCODE_MODALITIES = ["image", "audio", "text"] as const satisfies readonly EmbeddingSourceModality[];

export function isEmbeddingModality(value: string): value is EmbeddingModality {
  return (EMBEDDING_MODALITIES as readonly string[]).includes(value);
}

/** Older custom services only sent text. Missing flags keep that behavior. */
export function normalizeEmbeddingModalities(value: unknown): EmbeddingModality[] {
  return collectEmbeddingModalities(value) ?? ["text"];
}

/** A saved form must check at least one known modality. An empty list is invalid. */
export function explicitEmbeddingModalities(value: readonly string[]): EmbeddingModality[] | null {
  return collectEmbeddingModalities(value);
}

/**
 * Modalities supported by the selected HTTP adapter's request shape today.
 * Saved declarations for audio/video do not make those inputs usable unless
 * the adapter can actually send them.
 */
export function embeddingInputModalitiesForAdapter(
  adapter: "openai-embeddings-v1" | "llamacpp-multimodal-v1" | "dashscope-multimodal-v1",
  declared: readonly EmbeddingModality[],
): EmbeddingSourceModality[] {
  const supported: EmbeddingSourceModality[] = [];
  if (declared.includes("text")) supported.push("text");
  if (adapter !== "openai-embeddings-v1" && declared.includes("image")) supported.push("image");
  return supported;
}

function collectEmbeddingModalities(value: unknown): EmbeddingModality[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<EmbeddingModality>();
  for (const entry of value) {
    if (typeof entry === "string" && isEmbeddingModality(entry)) seen.add(entry);
  }
  return seen.size > 0 ? EMBEDDING_MODALITIES.filter((modality) => seen.has(modality)) : null;
}

/** Custom HTTP services that only declare text use text-oriented index copy. */
export function embeddingServiceTextOnly(modalities: readonly EmbeddingModality[] | null | undefined): boolean {
  if (!modalities || modalities.length === 0) return true;
  return !modalities.includes("image");
}
