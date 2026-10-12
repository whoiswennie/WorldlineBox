import {
  VIEWPORT_NEAR_FORWARD_LIMIT,
  buildViewportPriorityBands,
  detectViewportScrollDirection,
  orderedIdsAroundVisible,
  type ViewportPriorityBands,
} from "../shared/viewport-priority";
import { preserveVisibleWindowAssetIds } from "./visible-window";

export type ViewportPriorityCanvas = {
  getBoundingClientRect(): Pick<DOMRect, "top" | "bottom">;
  querySelectorAll(selectors: string): Iterable<HTMLElement>;
};

export type ViewportPriorityVirtualLayout = {
  indexOf: (assetId: string) => number | undefined;
  idAt: (index: number) => string | undefined;
  total: number;
};

/**
 * Cards that actually intersect the canvas viewport, in DOM encounter order.
 * Overscan mounts are skipped so they do not share the visible-wave budget.
 */
export function collectIntersectingCanvasAssetIds(
  canvas: ViewportPriorityCanvas,
  isPlaceholder: (assetId: string) => boolean,
): string[] {
  const canvasRect = canvas.getBoundingClientRect();
  const ids: string[] = [];
  const seenIds = new Set<string>();
  for (const slot of canvas.querySelectorAll(
    ".asset-card[data-asset-id], [data-layout-asset-id]",
  )) {
    const rect = slot.getBoundingClientRect();
    if (rect.bottom <= canvasRect.top || rect.top >= canvasRect.bottom) {
      continue;
    }
    const assetId = slot.dataset.assetId ?? slot.dataset.layoutAssetId;
    if (assetId && !isPlaceholder(assetId) && !seenIds.has(assetId)) {
      seenIds.add(assetId);
      ids.push(assetId);
    }
  }
  return ids;
}

export function orderedIdsForViewportPriorityReport(input: {
  visibleIds: readonly string[];
  virtualLayout?: ViewportPriorityVirtualLayout;
  fallbackOrderedIds: readonly string[];
}): string[] {
  const visibleIds = preserveVisibleWindowAssetIds(input.visibleIds);
  if (input.virtualLayout) {
    return orderedIdsAroundVisible({
      visibleIds,
      indexOf: input.virtualLayout.indexOf,
      idAt: input.virtualLayout.idAt,
      total: input.virtualLayout.total,
      radius: VIEWPORT_NEAR_FORWARD_LIMIT,
    });
  }
  return preserveVisibleWindowAssetIds(input.fallbackOrderedIds);
}

export function composeBrowseViewportPriorityBands(input: {
  intersectingIds: readonly string[];
  focusedIds: readonly (string | undefined)[];
  orderedIds: readonly string[];
  loadedIds: readonly string[];
  scrollTop: number;
  previousScrollTop: number | undefined;
  viewportHeight: number;
}): ViewportPriorityBands | undefined {
  const visibleIds = preserveVisibleWindowAssetIds(input.intersectingIds);
  if (visibleIds.length === 0) return undefined;
  const focusedIds = input.focusedIds.filter((assetId): assetId is string => Boolean(assetId));
  const direction = detectViewportScrollDirection({
    previousTop: input.previousScrollTop,
    nextTop: input.scrollTop,
    viewportHeight: input.viewportHeight,
  });
  const previousTop = input.previousScrollTop;
  const fastScroll = previousTop !== undefined
    && Math.abs(input.scrollTop - previousTop) >= input.viewportHeight * 1.5;
  return buildViewportPriorityBands({
    orderedIds: input.orderedIds,
    visibleIds,
    direction,
    focusedIds,
    loadedIds: input.loadedIds,
    fastScroll,
  });
}
