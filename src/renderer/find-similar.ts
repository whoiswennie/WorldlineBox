import { embeddingSourceForModalities } from "../shared/embedding/profile";
import {
  LOCAL_SEMANTIC_ENCODE_MODALITIES,
  type EmbeddingSourceModality,
} from "../shared/embedding/modalities";

export type FindSimilarStatus = "ready" | "preparing" | "failed" | "unsupported" | "unavailable";

export type FindSimilarPage = {
  status: FindSimilarStatus;
  assetIds: readonly string[];
};

export type FindSimilarSource = {
  libraryId: string;
  workspaceTabId: string | null;
  assetId: string;
  displayName: string;
  coverUrl: string | null;
};

/** Whether the selected encoder can use this asset directly or through its image preview. */
export function canFindSimilarForAsset(asset: {
  mediaType: string;
  relativeFilePath: string;
  sequence?: unknown;
  currentRevisionId?: string;
  thumbnailStatus?: string | null;
  thumbnailArtifactId?: string | null;
  deletedAt?: string | null;
  availability?: string;
  displayName?: string;
}, modalities: readonly EmbeddingSourceModality[] = LOCAL_SEMANTIC_ENCODE_MODALITIES): boolean {
  return embeddingSourceForModalities({
    ...asset,
    currentRevisionId: asset.currentRevisionId ?? "revision",
  }, modalities) !== null;
}

/**
 * Ask until the source image has a vector or the index can no longer produce one.
 * Preparing does not replace the current canvas.
 */
export async function resolveFindSimilar(input: {
  query: () => Promise<FindSimilarPage>;
  shouldContinue: () => boolean;
  delay: (milliseconds: number) => Promise<void>;
  onPreparing?: () => void;
  intervalMs?: number;
}): Promise<FindSimilarPage | null> {
  let announced = false;
  for (;;) {
    if (!input.shouldContinue()) return null;
    const page = await input.query();
    if (!input.shouldContinue()) return null;
    if (page.status !== "preparing") return page;
    if (!announced) {
      announced = true;
      input.onPreparing?.();
    }
    await input.delay(input.intervalMs ?? 1_500);
  }
}
