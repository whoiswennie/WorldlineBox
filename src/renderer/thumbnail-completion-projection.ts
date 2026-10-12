import type { ThumbnailEvent } from "../shared/protocol/responses";
import type { AssetThumbnailPatch } from "./asset-thumbnail-patches";

export type ThumbnailProjectionSubscriptions = {
  loadedAssetIds: ReadonlySet<string>;
  visibleAssetIds: ReadonlySet<string>;
  selectedAssetId: string | null;
  viewerAssetId: string | null;
  folderCoverAssetIds: ReadonlySet<string>;
};

/**
 * Card state only receives current browse summaries, the live viewport,
 * Inspector/viewer, and folder-card covers. Completions outside that set stay
 * in the database until the next browse page.
 */
export function shouldProjectThumbnailCompletion(
  assetId: string,
  subscriptions: ThumbnailProjectionSubscriptions,
): boolean {
  return (
    subscriptions.visibleAssetIds.has(assetId)
    || subscriptions.loadedAssetIds.has(assetId)
    || subscriptions.folderCoverAssetIds.has(assetId)
    || subscriptions.selectedAssetId === assetId
    || subscriptions.viewerAssetId === assetId
  );
}

export function thumbnailEventConcernsAsset(
  event: ThumbnailEvent,
  assetId: string,
): boolean {
  if (event.type === "asset.thumbnail.batch-ready") {
    return (
      event.ready.some((item) => item.assetId === assetId)
      || event.failed.some((item) => item.assetId === assetId)
    );
  }
  return event.assetId === assetId;
}

export function expandThumbnailCardEvents(
  event: ThumbnailEvent,
): Array<
  Extract<ThumbnailEvent, { type: "asset.thumbnail.ready" | "asset.thumbnail.failed" }>
> {
  if (event.type === "asset.thumbnail.ready" || event.type === "asset.thumbnail.failed") {
    return [event];
  }
  if (event.type !== "asset.thumbnail.batch-ready") return [];
  return [
    ...event.ready.map((item) => ({
      type: "asset.thumbnail.ready" as const,
      libraryId: event.libraryId,
      assetId: item.assetId,
      artifactId: item.artifactId,
      ...(item.width === undefined ? {} : { width: item.width }),
      ...(item.height === undefined ? {} : { height: item.height }),
      ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
    })),
    ...event.failed.map((item) => ({
      type: "asset.thumbnail.failed" as const,
      libraryId: event.libraryId,
      assetId: item.assetId,
      errorCode: item.errorCode,
      reason: item.reason,
      ...(item.width === undefined ? {} : { width: item.width }),
      ...(item.height === undefined ? {} : { height: item.height }),
    })),
  ];
}

export type ProjectedThumbnailActions = {
  noteActivity: boolean;
  folderCoverHit: boolean;
  patches: Map<string, AssetThumbnailPatch>;
  layoutArtifacts: Map<string, string | null>;
};

export function projectThumbnailEvent(
  event: ThumbnailEvent,
  subscriptions: ThumbnailProjectionSubscriptions,
): ProjectedThumbnailActions {
  const actions: ProjectedThumbnailActions = {
    noteActivity: false,
    folderCoverHit: false,
    patches: new Map(),
    layoutArtifacts: new Map(),
  };

  if (event.type === "asset.dimensions.ready" || event.type === "asset.derived.ready") {
    return actions;
  }

  if (event.type === "asset.thumbnail.ready") {
    actions.noteActivity = true;
    applyReadyItem(actions, event.assetId, {
      artifactId: event.artifactId,
      width: event.width,
      height: event.height,
      durationMs: event.durationMs,
    }, subscriptions);
    return actions;
  }

  if (event.type === "asset.thumbnail.failed") {
    actions.noteActivity = true;
    applyFailedItem(actions, event, subscriptions);
    return actions;
  }

  actions.noteActivity = event.completedCount > 0 || event.ready.length > 0 || event.failed.length > 0;
  for (const item of event.ready) {
    applyReadyItem(actions, item.assetId, item, subscriptions);
  }
  for (const item of event.failed) {
    applyFailedItem(actions, item, subscriptions);
  }
  return actions;
}

function applyReadyItem(
  actions: ProjectedThumbnailActions,
  assetId: string,
  item: {
    artifactId: string;
    width?: number;
    height?: number;
    durationMs?: number;
  },
  subscriptions: ThumbnailProjectionSubscriptions,
): void {
  if (subscriptions.folderCoverAssetIds.has(assetId)) {
    actions.folderCoverHit = true;
  }
  if (!shouldProjectThumbnailCompletion(assetId, subscriptions)) return;
  actions.layoutArtifacts.set(assetId, item.artifactId);
  actions.patches.set(assetId, {
    thumbnailStatus: "ready",
    thumbnailArtifactId: item.artifactId,
    ...(item.width === undefined ? {} : { width: item.width }),
    ...(item.height === undefined ? {} : { height: item.height }),
    ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
    sequenceFrameArtifactId: item.artifactId,
  });
}

function applyFailedItem(
  actions: ProjectedThumbnailActions,
  item: {
    assetId: string;
    errorCode?: string;
    width?: number;
    height?: number;
  },
  subscriptions: ThumbnailProjectionSubscriptions,
): void {
  if (!shouldProjectThumbnailCompletion(item.assetId, subscriptions)) return;
  actions.layoutArtifacts.set(item.assetId, null);
  actions.patches.set(item.assetId, {
    thumbnailStatus: "failed",
    thumbnailArtifactId: null,
    ...(item.width === undefined ? {} : { width: item.width }),
    ...(item.height === undefined ? {} : { height: item.height }),
  });
}
