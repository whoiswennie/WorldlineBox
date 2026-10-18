import type { FolderBrowseEntry } from "../shared/asset-types";
import type { FolderNavigationCover } from "../shared/library-navigation";

/**
 * WorldlineBox-d0nv: the set of cover-candidate asset ids for the current
 * folder-card row and for sidebar/breadcrumb custom covers. The Worker
 * schedules automatic candidates at the `cover` thumbnail scene and emits
 * `asset.thumbnail.ready` once each is generated. A ready event for any id
 * in this set refreshes folder cards and navigation covers.
 */
export function collectFolderCoverCandidateAssetIds(
  entries: readonly Pick<FolderBrowseEntry, "coverAssetIds" | "customCoverAssetId">[],
  navigationCovers: readonly Pick<FolderNavigationCover, "assetId">[] = [],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const assetId of entry.coverAssetIds) ids.add(assetId);
    if (entry.customCoverAssetId) ids.add(entry.customCoverAssetId);
  }
  for (const cover of navigationCovers) {
    if (cover.assetId) ids.add(cover.assetId);
  }
  return ids;
}
