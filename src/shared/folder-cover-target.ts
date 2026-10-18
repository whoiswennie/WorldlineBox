import { encodeLinkedVirtualFolderId, linkedAssetDirectory } from "./linked-folder-tree";

/**
 * Folder that should receive 「设为所在文件夹封面」.
 * Library root, non-images, and deleted assets have no target.
 */
export function assetParentFolderCoverTarget(asset: {
  locationKind: "managed" | "linked";
  managedFolderId: string | null;
  linkedFolderId?: string | null;
  relativeFilePath: string;
  mediaType: string;
  deletedAt?: string | null;
}): string | null {
  if (asset.deletedAt) return null;
  if (asset.mediaType !== "image") return null;
  if (asset.locationKind === "linked") {
    if (!asset.linkedFolderId) return null;
    return encodeLinkedVirtualFolderId(
      asset.linkedFolderId,
      linkedAssetDirectory(asset.relativeFilePath),
    );
  }
  return asset.managedFolderId;
}
