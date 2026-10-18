import type { EmbeddingIndexSnapshot } from "../shared/embedding/profile";
import type { AssetSummary } from "../shared/asset-types";

export type EmbeddingIndexCopyOptions = {
  /** Custom HTTP services encode library text, not still pictures. */
  textOnly?: boolean;
};

export function embeddingIndexCopyKey(
  snapshot: EmbeddingIndexSnapshot,
  options?: EmbeddingIndexCopyOptions,
): string {
  const textOnly = options?.textOnly === true;
  if (snapshot.hold === "grant") return "dialog.mediaJobs.embeddingGrant";
  switch (snapshot.phase) {
    case "starting":
      return textOnly
        ? "dialog.mediaJobs.embeddingStartingText"
        : "dialog.mediaJobs.embeddingStarting";
    case "indexing":
      return textOnly
        ? "dialog.mediaJobs.embeddingProgressText"
        : "dialog.mediaJobs.embeddingProgress";
    case "ready":
      if (snapshot.total === 0) {
        return textOnly
          ? "dialog.mediaJobs.embeddingReadyEmptyText"
          : "dialog.mediaJobs.embeddingReadyEmpty";
      }
      return snapshot.failedCount > 0
        ? (textOnly
          ? "dialog.mediaJobs.embeddingReadyPartialText"
          : "dialog.mediaJobs.embeddingReadyPartial")
        : "dialog.mediaJobs.embeddingReady";
    case "failed":
      return "dialog.mediaJobs.embeddingFailed";
    default:
      return "dialog.mediaJobs.embeddingUnavailable";
  }
}

/** Keep completed semantic work visible when the index contains failed assets. */
export function embeddingIndexJobsVisible(snapshot: EmbeddingIndexSnapshot): boolean {
  return snapshot.phase === "starting" || snapshot.phase === "indexing" || snapshot.failedCount > 0;
}

export function semanticSearchNotice(input: {
  phase: EmbeddingIndexSnapshot["phase"];
  done: number;
  total: number;
  matched: number;
  hold?: "grant";
  textOnly?: boolean;
}): { key: string; params: Record<string, number> } {
  if (input.hold === "grant") {
    return { key: "toast.semanticSearchGrant", params: {} };
  }
  if (input.matched > 0 && input.phase !== "ready") {
    return {
      key: input.textOnly ? "toast.semanticSearchPartialText" : "toast.semanticSearchPartial",
      params: { total: input.matched, done: input.done, libraryTotal: input.total },
    };
  }
  if (input.matched > 0) {
    return { key: "toast.semanticSearchDone", params: { total: input.matched } };
  }
  if (input.phase === "starting" || input.done === 0) {
    return {
      key: input.textOnly ? "toast.semanticSearchWaitingText" : "toast.semanticSearchWaiting",
      params: {},
    };
  }
  return {
    key: input.textOnly ? "toast.semanticSearchEmptyText" : "toast.semanticSearchEmpty",
    params: { done: input.done, total: input.total },
  };
}

export function orderAssetsById(assets: readonly AssetSummary[], assetIds: readonly string[]): AssetSummary[] {
  const order = new Map(assetIds.map((assetId, index) => [assetId, index]));
  return [...assets].sort((left, right) =>
    (order.get(left.assetId) ?? assetIds.length) - (order.get(right.assetId) ?? assetIds.length));
}
