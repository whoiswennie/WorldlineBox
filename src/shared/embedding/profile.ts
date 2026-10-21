/**
 * Embedding profile identity shared by settings and later library indexes.
 * A profile key changes when retrieval would change. Device file paths do not
 * belong in the key: the same weights on another computer are the same profile.
 */

import type { EmbeddingSourceModality } from "./modalities";

export const EMBEDDING_GEMMA2_DIMENSIONS = 768;
export const EMBEDDING_GEMMA2_QUERY_PREFIX = "task: search result | query: ";
export const EMBEDDING_GEMMA2_MODEL_REVISION = "412430755667d84b1ac64fe1fe2693aa6219f1d9";

/** Audio is mono 16 kHz. One request stays inside the 4096-token context (25 tokens per second). */
export const EMBEDDING_AUDIO_SAMPLE_RATE = 16_000;
export const EMBEDDING_AUDIO_WINDOW_SECONDS = 120;
export const EMBEDDING_AUDIO_MAX_WINDOWS = 16;
/** 1 fps video frames plus a 16 kHz mono audio track fit the shared 8192-token context. */
export const EMBEDDING_VIDEO_WINDOW_SECONDS = 16;
export const EMBEDDING_VIDEO_MAX_WINDOWS = 16;

/** Document body sent with the file name. Longer files keep this leading slice. */
export const EMBEDDING_TEXT_MAX_CHARS = 2_500;

export const SEMANTIC_SEARCH_MODEL_IDS = [
  "embeddinggemma-2-compact",
  "embeddinggemma-2-balanced",
  "embeddinggemma-2-quality",
] as const;

export type SemanticSearchModelId = (typeof SEMANTIC_SEARCH_MODEL_IDS)[number];

export const EMBEDDING_INDEX_PHASES = ["unavailable", "starting", "indexing", "ready", "failed"] as const;
export type EmbeddingIndexPhase = (typeof EMBEDDING_INDEX_PHASES)[number];

export type EmbeddingIndexSnapshot = {
  phase: EmbeddingIndexPhase;
  done: number;
  total: number;
  failedCount: number;
  /** Set when a remote text service is waiting for this library's permission. */
  hold?: "grant";
};

export const SEMANTIC_SEARCH_MODELS: readonly {
  readonly id: SemanticSearchModelId;
  readonly tier: EmbeddingGemmaTier;
}[] = [
  { id: "embeddinggemma-2-compact", tier: "Q4_K_XL" },
  { id: "embeddinggemma-2-balanced", tier: "Q8_0" },
  { id: "embeddinggemma-2-quality", tier: "BF16" },
];

/** Settings → Semantic search only offers the compact Unsloth quant. */
export const SETTINGS_LOCAL_SEMANTIC_MODELS = [
  "embeddinggemma-2-compact",
] as const satisfies readonly SemanticSearchModelId[];

/** Approximate on-disk package size for Settings size labels (core + projector + runtime). */
export const SEMANTIC_MODEL_PACKAGE_BYTES: Record<SemanticSearchModelId, number> = {
  "embeddinggemma-2-compact": 176_000_000 + 530_000_000 + 12_000_000,
  "embeddinggemma-2-balanced": 330_000_000 + 530_000_000 + 12_000_000,
  "embeddinggemma-2-quality": 620_000_000 + 1_050_000_000 + 12_000_000,
};

export function isSemanticSearchModelId(value: string): value is SemanticSearchModelId {
  return (SEMANTIC_SEARCH_MODEL_IDS as readonly string[]).includes(value);
}

export const EMBEDDING_GEMMA2_TIERS = ["Q4_K_XL", "Q8_0", "BF16"] as const;
export type EmbeddingGemmaTier = (typeof EMBEDDING_GEMMA2_TIERS)[number];

export type EmbeddingChannel = "text" | "image";

export type EmbeddingModelSummary = {
  id: string;
  name: string;
  tier: EmbeddingGemmaTier;
  profileKey: string;
  modelDirectory: string;
  runtimePath: string;
  declaredChannels: EmbeddingChannel[];
  verifiedChannels: EmbeddingChannel[];
  isDefault: boolean;
};

export const EMBEDDING_GEMMA2_TIER_FILES: Record<
  EmbeddingGemmaTier,
  { readonly coreFile: string; readonly projectorFile: string; readonly label: string }
> = {
  Q4_K_XL: {
    coreFile: "embeddinggemma-2-UD-Q4_K_XL.gguf",
    projectorFile: "mmproj-Q8_0.gguf",
    label: "Q4_K_XL core + Q8_0 projector",
  },
  Q8_0: {
    coreFile: "embeddinggemma-2-Q8_0.gguf",
    projectorFile: "mmproj-Q8_0.gguf",
    label: "Q8_0 core + Q8_0 projector",
  },
  BF16: {
    coreFile: "embeddinggemma-2-BF16.gguf",
    projectorFile: "mmproj-BF16.gguf",
    label: "BF16 core + BF16 projector",
  },
};

const DECLARED_CHANNELS: readonly EmbeddingChannel[] = ["text", "image"];

export function isEmbeddingGemmaTier(value: string): value is EmbeddingGemmaTier {
  return (EMBEDDING_GEMMA2_TIERS as readonly string[]).includes(value);
}

/** Channels the EmbeddingGemma 2 GGUF package claims. A claim is not verification. */
export function declaredChannelsForTier(): readonly EmbeddingChannel[] {
  return DECLARED_CHANNELS;
}

export function embeddingProfileKey(tier: EmbeddingGemmaTier): string {
  return [
    "embeddinggemma-2-gguf",
    EMBEDDING_GEMMA2_MODEL_REVISION,
    tier,
    EMBEDDING_GEMMA2_TIER_FILES[tier].coreFile,
    EMBEDDING_GEMMA2_TIER_FILES[tier].projectorFile,
    String(EMBEDDING_GEMMA2_DIMENSIONS),
    EMBEDDING_GEMMA2_QUERY_PREFIX,
    'context:8192;video:1fps:16s:16windows:audio16k:uniform:mean:v1',
  ].join("\n");
}

export function formatEmbeddingSearchQuery(text: string): string {
  return `${EMBEDDING_GEMMA2_QUERY_PREFIX}${text}`;
}

/** Documents use a title prefix. Media does not. */
export function formatEmbeddingDocument(title: string, content: string): string {
  const cleanTitle = title.replaceAll("|", " ").replace(/[\r\n]+/g, " ").trim() || "none";
  return `title: ${cleanTitle} | text: ${content}`;
}

export function clipEmbeddingDocument(content: string, maxChars = EMBEDDING_TEXT_MAX_CHARS): string {
  const normalized = content.replaceAll("\u0000", "").replace(/\r\n/g, "\n").trim();
  return Array.from(normalized).slice(0, maxChars).join("");
}

export function embeddingAudioRevision(revisionId: string): string {
  return `${revisionId}\naudio:16k-mono:${EMBEDDING_AUDIO_WINDOW_SECONDS}s:mean:${EMBEDDING_AUDIO_MAX_WINDOWS}`;
}

export function embeddingTextRevision(revisionId: string): string {
  return `${revisionId}\ntext:v1:${EMBEDDING_TEXT_MAX_CHARS}`;
}

/** Average already-normalized window vectors, then normalize again. */
export function meanPoolEmbeddings(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) throw new Error("No embeddings to pool.");
  const [first, ...rest] = vectors;
  if (!first || rest.length === 0) return normalizeEmbedding(first ?? [], first?.length);
  const dimensions = first.length;
  const sum = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    const normalized = normalizeEmbedding(vector, dimensions);
    for (let index = 0; index < dimensions; index += 1) {
      sum[index] = (sum[index] ?? 0) + (normalized[index] ?? 0);
    }
  }
  for (let index = 0; index < dimensions; index += 1) {
    sum[index] = (sum[index] ?? 0) / vectors.length;
  }
  return normalizeEmbedding(sum, dimensions);
}

/** A file the library already marked unreadable. Its vector would crowd out real matches. */
export function isDamagedEmbeddingAsset(asset: {
  currentRevisionId: string;
  thumbnailStatus?: string | null;
}): boolean {
  return asset.currentRevisionId.startsWith("corrupt:") || asset.thumbnailStatus === "failed";
}

const DIRECT_EMBED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** JPG, PNG and WebP stills can be encoded from the original file. */
export function embeddingDirectImage(asset: {
  mediaType: string;
  relativeFilePath: string;
  sequence?: unknown;
}): boolean {
  if (asset.sequence) return false;
  if (asset.mediaType !== "image") return false;
  const dot = asset.relativeFilePath.lastIndexOf(".");
  if (dot < 0) return false;
  return DIRECT_EMBED_EXTENSIONS.has(asset.relativeFilePath.slice(dot).toLowerCase());
}

export type EmbeddingVisualPlan = "file" | "thumbnail" | "none";

/**
 * Original stills use the file. Every other readable asset uses its ready
 * thumbnail, which is itself a JPEG or WebP picture.
 */
export function embeddingVisualPlan(asset: {
  mediaType: string;
  relativeFilePath: string;
  sequence?: unknown;
  currentRevisionId: string;
  thumbnailStatus?: string | null;
  thumbnailArtifactId?: string | null;
  deletedAt?: string | null;
  availability?: string;
}): EmbeddingVisualPlan {
  if (asset.deletedAt) return "none";
  if (asset.availability !== undefined && asset.availability !== "available") return "none";
  if (isDamagedEmbeddingAsset(asset)) return "none";
  if (embeddingDirectImage(asset)) return "file";
  if (asset.thumbnailStatus === "ready" && asset.thumbnailArtifactId) return "thumbnail";
  return "none";
}

/** Cache identity changes when a replacement thumbnail should be encoded again. */
export function embeddingThumbnailRevision(revisionId: string, artifactId: string): string {
  return `${revisionId}\nthumb:${artifactId}`;
}

export type EmbeddingSourcePlan = EmbeddingVisualPlan | "audio" | "text";

/**
 * Audio and text use the file itself. Stills use the original when the model
 * can read it, and every other readable asset uses its ready thumbnail.
 * A failed waveform or text preview does not block the file.
 */
export function embeddingSourcePlan(asset: {
  mediaType: string;
  relativeFilePath: string;
  sequence?: unknown;
  currentRevisionId: string;
  thumbnailStatus?: string | null;
  thumbnailArtifactId?: string | null;
  deletedAt?: string | null;
  availability?: string;
}): EmbeddingSourcePlan {
  if (asset.deletedAt) return "none";
  if (asset.availability !== undefined && asset.availability !== "available") return "none";
  if (asset.currentRevisionId.startsWith("corrupt:")) return "none";
  if (asset.mediaType === "audio") return "audio";
  if (asset.mediaType === "text") return "text";
  return embeddingVisualPlan(asset);
}

/**
 * Resolve the source the selected encoder can actually consume. Raw video is
 * preferred whenever supported; otherwise, image-capable encoders may use a
 * ready preview. Other source modalities use their supported original input.
 */
export function embeddingSourceForModalities(asset: {
  mediaType: string;
  relativeFilePath: string;
  sequence?: unknown;
  currentRevisionId: string;
  thumbnailStatus?: string | null;
  thumbnailArtifactId?: string | null;
  deletedAt?: string | null;
  availability?: string;
  displayName?: string;
}, modalities: readonly EmbeddingSourceModality[]): {
  kind: EmbeddingSourceModality;
  revision: string;
} | null {
  if (asset.deletedAt || (asset.availability !== undefined && asset.availability !== "available")
    || asset.currentRevisionId.startsWith("corrupt:")) return null;
  if (asset.mediaType === "video" && modalities.includes("video")) {
    return { kind: "video", revision: `${asset.currentRevisionId}\nvideo:v1:1fps:${EMBEDDING_VIDEO_WINDOW_SECONDS}s:${EMBEDDING_VIDEO_MAX_WINDOWS}:audio16k:uniform:mean` };
  }
  const source = embeddingSourcePlan(asset);
  if (source === "audio" && modalities.includes("audio")) {
    return { kind: "audio", revision: embeddingAudioRevision(asset.currentRevisionId) };
  }
  if (source === "text" && modalities.includes("text")) {
    const title = asset.displayName === undefined ? "" : `\ntitle:${asset.displayName}`;
    return { kind: "text", revision: `${embeddingTextRevision(asset.currentRevisionId)}${title}` };
  }
  if ((source === "file" || source === "thumbnail") && modalities.includes("image")) {
    return {
      kind: "image",
      revision: source === "thumbnail" && asset.thumbnailArtifactId
        ? embeddingThumbnailRevision(asset.currentRevisionId, asset.thumbnailArtifactId)
        : asset.currentRevisionId,
    };
  }
  if (modalities.includes("image")) {
    const visualSource = embeddingVisualPlan(asset);
    if (visualSource === "thumbnail" && asset.thumbnailArtifactId) {
      return {
        kind: "image",
        revision: embeddingThumbnailRevision(asset.currentRevisionId, asset.thumbnailArtifactId),
      };
    }
  }
  return null;
}

export function channelEnabled(
  verified: readonly EmbeddingChannel[],
  channel: EmbeddingChannel,
): boolean {
  return verified.includes(channel);
}

export function normalizeEmbedding(vector: readonly number[], dimensions = EMBEDDING_GEMMA2_DIMENSIONS): number[] {
  if (vector.length !== dimensions) {
    throw new Error(`Embedding length ${vector.length} does not match ${dimensions}.`);
  }
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("Embedding contains a non-finite value.");
    normSquared += value * value;
  }
  if (normSquared === 0) throw new Error("Embedding norm is zero.");
  const norm = Math.sqrt(normSquared);
  return vector.map((value) => value / norm);
}

/** Reciprocal rank fusion. Each channel contributes one rank per asset. */
export function fuseRanks(
  rankings: readonly (readonly string[])[],
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
