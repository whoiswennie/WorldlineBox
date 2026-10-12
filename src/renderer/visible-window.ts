export const MAX_VISIBLE_WINDOW_ASSETS = 300;

/**
 * Make viewport reports independent from DOM traversal order. Masonry and
 * virtualized layouts can mount the same window in different orders while a
 * scroll/reflow is settling; only a changed asset set needs a Worker wave.
 */
export function normalizeVisibleWindowAssetIds(
  assetIds: readonly string[],
): string[] {
  return [...new Set(assetIds)]
    .toSorted()
    .slice(0, MAX_VISIBLE_WINDOW_ASSETS);
}

export function preserveVisibleWindowAssetIds(
  assetIds: readonly string[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const assetId of assetIds) {
    if (!assetId || seen.has(assetId)) continue;
    seen.add(assetId);
    ids.push(assetId);
    if (ids.length >= MAX_VISIBLE_WINDOW_ASSETS) break;
  }
  return ids;
}

export function visibleWindowReportKey(
  libraryId: string,
  assetIds: readonly string[],
): string {
  return `${libraryId}:${normalizeVisibleWindowAssetIds(assetIds).join(',')}`;
}
