import type { FilterClause, SearchQuery } from "../shared/asset-types";
import { IMAGE_EXTENSIONS } from "../shared/media-formats";

/** Page size for the folder-cover grid. Larger than one browse page. */
export const FOLDER_COVER_PICKER_PAGE_SIZE = 80;

/** Image formats the cover grid may offer. */
export function folderCoverPickerImageFilter(): FilterClause {
  return {
    field: "format",
    values: IMAGE_EXTENSIONS.map((extension) => extension.slice(1)),
    exclude: false,
  };
}

/**
 * Library search for the cover grid: filename or folder path.
 * A blank query searches nothing extra and the image filter stands alone.
 */
export function folderCoverPickerSearchQuery(raw: string): SearchQuery | null {
  const value = raw.normalize("NFKC").trim();
  if (!value) return null;
  return {
    clauses: [],
    groups: [
      [{ field: "filename", values: [value], exclude: false }],
      [{ field: "folder_path", values: [value], exclude: false }],
    ],
  };
}

/** Case-insensitive substring match on the display name or relative path. */
export function folderCoverPickerAssetMatches(
  asset: { displayName: string; relativeFilePath: string },
  rawQuery: string,
): boolean {
  const query = rawQuery.normalize("NFKC").trim().toLowerCase();
  if (!query) return true;
  const name = asset.displayName.normalize("NFKC").toLowerCase();
  const filePath = asset.relativeFilePath.normalize("NFKC").toLowerCase();
  return name.includes(query) || filePath.includes(query);
}
