import type { FolderBrowseEntry } from "../shared/asset-types";
import { coverSrc, sourceSrc } from "./asset-card-hover-preview";

/** Cover image stored with the library, addressed without a filesystem path. */
export function folderCustomCoverSrc(
  libraryId: string,
  folderId: string,
  token: string,
): string {
  const url = new URL(`worldlinebox://folder-cover/${encodeURIComponent(libraryId)}`);
  url.searchParams.set("folder", folderId);
  url.searchParams.set("v", token);
  return url.toString();
}

/** Custom cover when one is stored; otherwise the first automatic cover. */
export function folderCoverImageSrc(
  libraryId: string,
  entry: Pick<FolderBrowseEntry, "folderId" | "coverArtifactIds" | "coverSourcePreviews" | "hasCustomCover" | "customCoverToken">,
): string | null {
  if (entry.hasCustomCover && entry.customCoverToken) {
    return folderCustomCoverSrc(libraryId, entry.folderId, entry.customCoverToken);
  }
  const artifactId = entry.coverArtifactIds[0];
  if (artifactId) return coverSrc(libraryId, artifactId);
  const source = entry.coverSourcePreviews?.[0];
  if (!source) return null;
  return sourceSrc(libraryId, source.assetId, source.revisionId);
}
