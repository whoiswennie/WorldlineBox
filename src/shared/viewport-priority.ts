export type ViewportScrollDirection = "up" | "down" | "stationary" | "jump";

export type ViewportPriorityLane = "p0" | "p1" | "p2" | "p3" | "p4";

export const VIEWPORT_NEAR_FORWARD_LIMIT = 100;
export const VIEWPORT_NEAR_BACKWARD_LIMIT = 50;
export const VIEWPORT_SCOPE_WARM_LIMIT = 200;
export const VIEWPORT_FOCUSED_LIMIT = 16;
export const VIEWPORT_CLAIM_ID_LIMIT = 250;
export const VIEWPORT_PREEMPT_STABLE_MS = 100;
export const VIEWPORT_PREEMPT_COOLDOWN_MS = 500;

export type ViewportPriorityBands = {
  focused: string[];
  visible: string[];
  nearForward: string[];
  nearBackward: string[];
  scopeWarm: string[];
  direction: ViewportScrollDirection;
};

export type ViewportPrioritySnapshot = ViewportPriorityBands & {
  libraryId: string;
  consumerId: string;
  libraryGeneration: number;
  interactionGeneration: number;
  viewportGeneration: number;
};

function uniqueInOrder(
  assetIds: readonly string[],
  limit: number,
  seen?: Set<string>,
): string[] {
  const owned = seen ?? new Set<string>();
  const result: string[] = [];
  for (const assetId of assetIds) {
    if (!assetId || owned.has(assetId)) continue;
    owned.add(assetId);
    result.push(assetId);
    if (result.length >= limit) break;
  }
  return result;
}

function firstLastIndex(
  orderedIds: readonly string[],
  visibleIds: readonly string[],
): { first: number; last: number } | undefined {
  const visible = new Set(visibleIds);
  let first = -1;
  let last = -1;
  for (let index = 0; index < orderedIds.length; index += 1) {
    const id = orderedIds[index];
    if (!id || !visible.has(id)) continue;
    if (first < 0) first = index;
    last = index;
  }
  if (first < 0 || last < 0) return undefined;
  return { first, last };
}

function collectNeighbors(
  orderedIds: readonly string[],
  start: number,
  step: 1 | -1,
  limit: number,
  seen: Set<string>,
): string[] {
  const result: string[] = [];
  for (let index = start; index >= 0 && index < orderedIds.length; index += step) {
    const assetId = orderedIds[index];
    if (!assetId || seen.has(assetId)) continue;
    seen.add(assetId);
    result.push(assetId);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Build band lists from session order. Visible IDs keep caller order.
 * Forward/back counts scale with the current visible window (≈ one viewport).
 */
export function buildViewportPriorityBands(input: {
  orderedIds: readonly string[];
  visibleIds: readonly string[];
  direction: ViewportScrollDirection;
  focusedIds?: readonly string[];
  loadedIds?: readonly string[];
  fastScroll?: boolean;
}): ViewportPriorityBands {
  const visible = uniqueInOrder(input.visibleIds, 300);
  const seen = new Set(visible);
  const focused = uniqueInOrder(input.focusedIds ?? [], VIEWPORT_FOCUSED_LIMIT, seen);

  const nearForward: string[] = [];
  const nearBackward: string[] = [];
  if (input.direction !== "jump" && visible.length > 0) {
    const span = firstLastIndex(input.orderedIds, visible);
    const forwardLimit = Math.min(
      VIEWPORT_NEAR_FORWARD_LIMIT,
      Math.max(1, Math.ceil(visible.length * (input.fastScroll ? 3 : 1.5))),
    );
    const backwardLimit = Math.min(
      VIEWPORT_NEAR_BACKWARD_LIMIT,
      Math.max(1, Math.ceil(visible.length * 0.5)),
    );
    if (span) {
      const forwardIsDown = input.direction !== "up";
      if (forwardIsDown) {
        nearForward.push(...collectNeighbors(input.orderedIds, span.last + 1, 1, forwardLimit, seen));
        nearBackward.push(...collectNeighbors(input.orderedIds, span.first - 1, -1, backwardLimit, seen));
      } else {
        nearForward.push(...collectNeighbors(input.orderedIds, span.first - 1, -1, forwardLimit, seen));
        nearBackward.push(...collectNeighbors(input.orderedIds, span.last + 1, 1, backwardLimit, seen));
      }
    }
  }

  const scopeWarm = uniqueInOrder(input.loadedIds ?? [], VIEWPORT_SCOPE_WARM_LIMIT, seen);
  return {
    focused,
    visible,
    nearForward,
    nearBackward,
    scopeWarm,
    direction: input.direction,
  };
}

export function orderedIdsAroundVisible(input: {
  visibleIds: readonly string[];
  indexOf: (assetId: string) => number | undefined;
  idAt: (index: number) => string | undefined;
  total: number;
  radius: number;
}): string[] {
  let min = Number.POSITIVE_INFINITY;
  let max = -1;
  for (const assetId of input.visibleIds) {
    const index = input.indexOf(assetId);
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) continue;
    if (index < min) min = index;
    if (index > max) max = index;
  }
  if (max < 0) return uniqueInOrder(input.visibleIds, 300);
  const start = Math.max(0, min - input.radius);
  const end = Math.min(Math.max(0, input.total), max + input.radius + 1);
  const ids: string[] = [];
  for (let index = start; index < end; index += 1) {
    const assetId = input.idAt(index);
    if (assetId) ids.push(assetId);
  }
  return ids;
}

export function rankedViewportClaimIds(bands: ViewportPriorityBands): string[] {
  return uniqueInOrder(
    [...bands.focused, ...bands.visible, ...bands.nearForward, ...bands.nearBackward, ...bands.scopeWarm],
    VIEWPORT_CLAIM_ID_LIMIT,
  );
}

export function uniqueAssetIdsInOrder(assetIds: readonly string[], limit: number): string[] {
  return uniqueInOrder(assetIds, limit);
}

/**
 * Prefer the in-memory overlay rank. Fall back to the visible-wave ids only
 * when no overlay snapshot has been applied yet (legacy reports).
 */
export function resolveViewportClaimIds(
  rankedOverlayIds: readonly string[],
  fallbackIds?: readonly string[],
): string[] | undefined {
  if (rankedOverlayIds.length > 0) {
    return uniqueInOrder(rankedOverlayIds, VIEWPORT_CLAIM_ID_LIMIT);
  }
  if (fallbackIds === undefined) return undefined;
  return uniqueInOrder(fallbackIds, VIEWPORT_CLAIM_ID_LIMIT);
}

/**
 * First-phase claim IDs: overlay rank when a snapshot exists, otherwise the
 * visible-wave fallback. Background pumps still fall back to the persistent
 * queue in `processThumbnailQueue` once this list has no runnable jobs.
 */
export function claimIdsForThumbnailWave(input: {
  viewportOnlyWave: boolean;
  rankedOverlayIds: readonly string[];
  fallbackIds?: readonly string[];
}): string[] | undefined {
  return resolveViewportClaimIds(input.rankedOverlayIds, input.fallbackIds);
}

/**
 * §4.1 step 2: an unrestricted background pump may leave overlay `IN (...)`
 * once those IDs have no queued work. Visible/interactive pumps and pumps that
 * passed an explicit `assetIds` list keep the hard cap (in-flight narrowing).
 */
export function shouldFallbackViewportClaimToPersistentQueue(input: {
  interactive: boolean;
  restrictedByAssetIds: boolean;
  scopedClaimIds: readonly string[] | undefined;
}): boolean {
  if (input.interactive) return false;
  if (input.restrictedByAssetIds) return false;
  return input.scopedClaimIds !== undefined;
}

/**
 * Bound claim queries by overlay rank instead of persistent `jobs.priority`.
 * Placeholders are bound in the same order as `assetIds`.
 */
export function viewportClaimRankOrderSql(assetIds: readonly string[] | undefined): {
  sql: string;
  params: string[];
} {
  if (assetIds === undefined || assetIds.length === 0) {
    return { sql: "", params: [] };
  }
  const cases = assetIds.map((_, index) => `WHEN ? THEN ${index}`).join(" ");
  return {
    sql: `CASE asset_id ${cases} ELSE ${assetIds.length} END, `,
    params: [...assetIds],
  };
}

export function immediateViewportAssetIds(bands: Pick<ViewportPriorityBands, "focused" | "visible">): string[] {
  return uniqueInOrder([...bands.focused, ...bands.visible], 300);
}

export function viewportPriorityReportKey(
  libraryId: string,
  bands: ViewportPriorityBands,
  viewportGeneration: number,
): string {
  return [
    libraryId,
    String(viewportGeneration),
    bands.direction,
    bands.focused.join(","),
    bands.visible.join(","),
    bands.nearForward.join(","),
    bands.nearBackward.join(","),
    bands.scopeWarm.join(","),
  ].join("|");
}

export function detectViewportScrollDirection(input: {
  previousTop: number | undefined;
  nextTop: number;
  viewportHeight: number;
}): ViewportScrollDirection {
  if (input.previousTop === undefined) return "stationary";
  const delta = input.nextTop - input.previousTop;
  const view = input.viewportHeight > 0 ? input.viewportHeight : 800;
  if (Math.abs(delta) >= view * 2) return "jump";
  if (delta > 8) return "down";
  if (delta < -8) return "up";
  return "stationary";
}

export type ViewportPriorityApplyResult = {
  accepted: boolean;
  reason: "applied" | "stale-generation" | "stale-library";
};

export class ViewportPriorityOverlay {
  readonly #snapshots = new Map<string, ViewportPrioritySnapshot>();

  apply(snapshot: ViewportPrioritySnapshot): ViewportPriorityApplyResult {
    const key = this.#key(snapshot.libraryId, snapshot.consumerId);
    const current = this.#snapshots.get(key);
    if (current && snapshot.libraryGeneration < current.libraryGeneration) {
      return { accepted: false, reason: "stale-library" };
    }
    if (
      current
      && snapshot.libraryGeneration === current.libraryGeneration
      && snapshot.viewportGeneration < current.viewportGeneration
    ) {
      return { accepted: false, reason: "stale-generation" };
    }
    this.#snapshots.set(key, snapshot);
    return { accepted: true, reason: "applied" };
  }

  clearLibrary(libraryId: string): void {
    for (const key of [...this.#snapshots.keys()]) {
      if (key.startsWith(`${libraryId}\u0000`)) this.#snapshots.delete(key);
    }
  }

  snapshot(libraryId: string, consumerId: string): ViewportPrioritySnapshot | undefined {
    return this.#snapshots.get(this.#key(libraryId, consumerId));
  }

  rankedClaimIds(libraryId: string): string[] {
    const snapshots = this.#librarySnapshots(libraryId);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const band of ["focused", "visible", "nearForward", "nearBackward", "scopeWarm"] as const) {
      let progress = true;
      const cursors = snapshots.map(() => 0);
      while (progress) {
        progress = false;
        for (let index = 0; index < snapshots.length; index += 1) {
          const list = snapshots[index]![band];
          const cursor = cursors[index] ?? 0;
          if (cursor >= list.length) continue;
          const assetId = list[cursor]!;
          cursors[index] = cursor + 1;
          progress = true;
          if (seen.has(assetId)) continue;
          seen.add(assetId);
          merged.push(assetId);
          if (merged.length >= VIEWPORT_CLAIM_ID_LIMIT) return merged;
        }
      }
    }
    return merged;
  }

  immediateAssetIds(libraryId: string): string[] {
    return uniqueInOrder(
      this.#librarySnapshots(libraryId).flatMap((snapshot) => [...snapshot.focused, ...snapshot.visible]),
      300,
    );
  }

  laneForAsset(libraryId: string, assetId: string): ViewportPriorityLane {
    for (const snapshot of this.#librarySnapshots(libraryId)) {
      if (snapshot.focused.includes(assetId)) return "p0";
      if (snapshot.visible.includes(assetId)) return "p1";
      if (snapshot.nearForward.includes(assetId) || snapshot.nearBackward.includes(assetId)) {
        return "p2";
      }
      if (snapshot.scopeWarm.includes(assetId)) return "p3";
    }
    return "p4";
  }

  #librarySnapshots(libraryId: string): ViewportPrioritySnapshot[] {
    return [...this.#snapshots.values()].filter((snapshot) => snapshot.libraryId === libraryId);
  }

  #key(libraryId: string, consumerId: string): string {
    return `${libraryId}\u0000${consumerId}`;
  }
}

export function shouldAbortRunningOutsideViewport(input: {
  overlapShouldPreempt: boolean;
  hasIdleForegroundSlot: boolean;
  viewportStableMs: number;
  lastPreemptAtMs?: number;
  nowMs: number;
  p0OrP1Waiting: boolean;
  lookaheadOnly: boolean;
}): boolean {
  if (input.lookaheadOnly) return false;
  if (input.hasIdleForegroundSlot) return false;
  if (!input.p0OrP1Waiting) return false;
  if (input.viewportStableMs < VIEWPORT_PREEMPT_STABLE_MS) return false;
  if (
    input.lastPreemptAtMs !== undefined
    && input.nowMs - input.lastPreemptAtMs < VIEWPORT_PREEMPT_COOLDOWN_MS
  ) {
    return false;
  }
  return input.overlapShouldPreempt;
}
