/**
 * REQ-MENU-004 / WorldlineBox-guq: classify a multi-asset context-menu selection
 * into process vs skip counts with stable reason codes, and format a concise
 * menu footer (e.g. "将处理 3 / 跳过 2（回收站）").
 *
 * WorldlineBox-koy / WorldlineBox-vgp: folder cards in a mixed selection participate in
 * trash / disk-delete and move (reparent). Asset-only actions (tags, …) still
 * skip folders with reason "folder".
 *
 * Eligibility mirrors drag-drop / file-op gates: move needs managed + available
 * + not trashed; trash needs managed or linked + not trashed. Unavailable,
 * unresolved, and trashed assets become skip buckets rather than silent gaps.
 * Linked assets skip move (they are not library-owned bytes) but Delete sends
 * them to the OS recycle bin the same as managed trash.
 */

import {
  DEFAULT_LOCALE,
  translateForLocale,
  type AppLocale,
} from "./i18n";

export type MenuSkipReasonCode =
  | "linked"
  | "unavailable"
  | "unresolved"
  | "trashed"
  | "folder";

export type MenuSkipAssetSnapshot = {
  readonly assetId: string;
  readonly locationKind: "managed" | "linked";
  readonly availability: "available" | "missing";
  readonly deletedAt: string | null;
};

export type MenuActionKind = "move" | "trash";

export type MenuSkipBucket = {
  readonly reason: MenuSkipReasonCode;
  readonly count: number;
};

export type MenuActionSkipScope = {
  readonly action: MenuActionKind;
  readonly processCount: number;
  readonly skipCount: number;
  readonly skips: readonly MenuSkipBucket[];
  readonly processAssetIds: readonly string[];
  readonly processFolderIds: readonly string[];
};

export type MultiAssetMenuSkipReport = {
  readonly selectionCount: number;
  readonly allTrashed: boolean;
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
  readonly linkedCount: number;
  readonly unavailableManagedCount: number;
  readonly trashedCount: number;
  readonly folderCount: number;
  readonly move: MenuActionSkipScope;
  readonly trash: MenuActionSkipScope;
};

function pushSkip(
  buckets: Map<MenuSkipReasonCode, number>,
  reason: MenuSkipReasonCode,
  count = 1,
): void {
  if (count <= 0) return;
  buckets.set(reason, (buckets.get(reason) ?? 0) + count);
}

function bucketsToList(
  buckets: Map<MenuSkipReasonCode, number>,
): MenuSkipBucket[] {
  const order: MenuSkipReasonCode[] = [
    "linked",
    "unavailable",
    "trashed",
    "unresolved",
    "folder",
  ];
  return order
    .filter((reason) => (buckets.get(reason) ?? 0) > 0)
    .map((reason) => ({ reason, count: buckets.get(reason)! }));
}

function buildScope(
  action: MenuActionKind,
  processAssetIds: readonly string[],
  processFolderIds: readonly string[],
  skips: Map<MenuSkipReasonCode, number>,
): MenuActionSkipScope {
  const skipList = bucketsToList(skips);
  return {
    action,
    processCount: processAssetIds.length + processFolderIds.length,
    skipCount: skipList.reduce((sum, item) => sum + item.count, 0),
    skips: skipList,
    processAssetIds,
    processFolderIds,
  };
}

export type MenuSkipScopeOptions = {
  /**
   * Asset IDs that belong to the current browse scope even when their
   * summary has not been paged into `assets` yet (virtual layout index).
   */
  readonly inScopeAssetIds?: ReadonlySet<string> | readonly string[];
  /**
   * When the compact index is incomplete, a selected ID without a snapshot
   * is still in this folder (Ctrl+A / first-page summaries). It is not
   * "out of scope".
   */
  readonly assumeMissingAreInScope?: boolean;
};

function toInScopeSet(
  ids: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> {
  if (!ids) return new Set();
  return ids instanceof Set ? ids : new Set(ids);
}

function inScopePlaceholder(assetId: string): MenuSkipAssetSnapshot {
  return {
    assetId,
    locationKind: "managed",
    availability: "available",
    deletedAt: null,
  };
}

export function browseScopeFromVirtualLayout(layout: {
  readonly assetIdsByIndex: ReadonlyMap<number, string>;
  readonly total: number;
} | null | undefined): MenuSkipScopeOptions {
  if (!layout) return { assumeMissingAreInScope: true };
  const inScopeAssetIds = new Set<string>();
  for (const assetId of layout.assetIdsByIndex.values()) {
    inScopeAssetIds.add(assetId);
  }
  const complete =
    layout.total > 0 && inScopeAssetIds.size >= layout.total;
  return {
    inScopeAssetIds,
    assumeMissingAreInScope: !complete,
  };
}

/**
 * Classify the multi-select snapshot into move/trash process sets and skip
 * reason buckets. `assets` is the currently loaded summary page. IDs that
 * belong to the current browse scope but are not yet paged in stay in the
 * process set; only IDs outside that scope count as unresolved.
 * Canvas folder cards are managed folders and join trash/disk-delete and
 * move (reparent). Mixed selections still skip folders for asset-only ops.
 */
export function buildMultiAssetMenuSkipReport(
  selectedAssetIds: readonly string[],
  assets: readonly MenuSkipAssetSnapshot[],
  selectedFolderIds: readonly string[] = [],
  scope: MenuSkipScopeOptions = {},
): MultiAssetMenuSkipReport {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const inScope = toInScopeSet(scope.inScopeAssetIds);
  const assumeMissing = scope.assumeMissingAreInScope === true;
  const resolved: MenuSkipAssetSnapshot[] = [];
  let unresolvedCount = 0;
  for (const assetId of selectedAssetIds) {
    const asset = byId.get(assetId);
    if (asset) {
      resolved.push(asset);
      continue;
    }
    if (assumeMissing || inScope.has(assetId)) {
      resolved.push(inScopePlaceholder(assetId));
      continue;
    }
    unresolvedCount += 1;
  }

  const folderIds = [...selectedFolderIds];
  const folderCount = folderIds.length;

  const linkedCount = resolved.filter(
    (asset) => asset.locationKind === "linked",
  ).length;
  const unavailableManagedCount = resolved.filter(
    (asset) =>
      asset.locationKind === "managed" &&
      asset.availability !== "available" &&
      !asset.deletedAt,
  ).length;
  const trashedCount = resolved.filter((asset) =>
    Boolean(asset.deletedAt),
  ).length;
  // Folders on the browse canvas are never "trashed cards"; mixed folder
  // selection always leaves the restore/permanent-delete branch.
  const allTrashed =
    folderCount === 0 &&
    resolved.length > 0 &&
    unresolvedCount === 0 &&
    resolved.every((asset) => Boolean(asset.deletedAt));

  const moveIds: string[] = [];
  const moveSkips = new Map<MenuSkipReasonCode, number>();
  const trashIds: string[] = [];
  const trashSkips = new Map<MenuSkipReasonCode, number>();

  pushSkip(moveSkips, "unresolved", unresolvedCount);
  pushSkip(trashSkips, "unresolved", unresolvedCount);

  for (const asset of resolved) {
    if (asset.locationKind === "linked") {
      pushSkip(moveSkips, "linked");
      if (asset.deletedAt) {
        pushSkip(trashSkips, "trashed");
      } else {
        trashIds.push(asset.assetId);
      }
      continue;
    }
    // managed
    if (asset.deletedAt) {
      pushSkip(moveSkips, "trashed");
      pushSkip(trashSkips, "trashed");
      continue;
    }
    if (asset.availability !== "available") {
      pushSkip(moveSkips, "unavailable");
      trashIds.push(asset.assetId);
      continue;
    }
    moveIds.push(asset.assetId);
    trashIds.push(asset.assetId);
  }

  return {
    selectionCount: selectedAssetIds.length + folderCount,
    allTrashed,
    resolvedCount: resolved.length,
    unresolvedCount,
    linkedCount,
    unavailableManagedCount,
    trashedCount,
    folderCount,
    move: buildScope("move", moveIds, folderIds, moveSkips),
    trash: buildScope("trash", trashIds, folderIds, trashSkips),
  };
}

function reasonPhrase(
  reason: MenuSkipReasonCode,
  locale: AppLocale,
): string {
  switch (reason) {
    case "linked":
      return translateForLocale(locale, "menu.skipReasonLinked");
    case "unavailable":
      return translateForLocale(locale, "menu.skipReasonUnavailable");
    case "unresolved":
      return translateForLocale(locale, "menu.skipReasonUnresolved");
    case "trashed":
      return translateForLocale(locale, "menu.skipReasonTrashed");
    case "folder":
      return translateForLocale(locale, "menu.skipReasonFolder");
  }
}

function formatReasons(
  skips: readonly MenuSkipBucket[],
  locale: AppLocale,
): string {
  const join = translateForLocale(locale, "menu.skipReasonJoin");
  return skips
    .map((bucket) => reasonPhrase(bucket.reason, locale))
    .join(join);
}

/**
 * One action line when that action would skip anything; null when fully
 * eligible (no footer noise for uniform managed selections).
 */
export function formatMenuActionSkipLine(
  scope: MenuActionSkipScope,
  locale: AppLocale = DEFAULT_LOCALE,
): string | null {
  if (scope.skipCount === 0) return null;
  const action =
    scope.action === "move"
      ? translateForLocale(locale, "menu.skipReportActionMove")
      : translateForLocale(locale, "menu.skipReportActionTrash");
  return translateForLocale(locale, "menu.skipReportLine", {
    action,
    process: scope.processCount,
    skip: scope.skipCount,
    reasons: formatReasons(scope.skips, locale),
  });
}

/**
 * When folders are mixed in, asset-only ops (tags / collections / AI) skip
 * them — surface a concise note so the skip is not silent.
 */
export function formatMixedSelectionAssetOnlyNote(
  folderCount: number,
  locale: AppLocale = DEFAULT_LOCALE,
): string | null {
  if (folderCount <= 0) return null;
  return translateForLocale(locale, "menu.skipReportAssetOnlyFolders", {
    count: folderCount,
  });
}

/**
 * Concise multi-asset menu footer. Null when every file-op is fully eligible
 * or the menu is on the all-trashed restore/delete branch.
 */
export function formatMultiAssetMenuSkipFooter(
  report: MultiAssetMenuSkipReport,
  locale: AppLocale = DEFAULT_LOCALE,
): string | null {
  if (report.allTrashed) return null;
  // Folder-only multi menus hide move; don't emit a move skip line there.
  const scopes =
    report.selectionCount > report.folderCount
      ? [report.move, report.trash]
      : [report.trash];
  const lines = scopes
    .map((scope) => formatMenuActionSkipLine(scope, locale))
    .filter((line): line is string => line !== null);
  const assetOnly = formatMixedSelectionAssetOnlyNote(
    report.folderCount > 0 &&
      report.selectionCount > report.folderCount
      ? report.folderCount
      : 0,
    locale,
  );
  if (assetOnly) lines.push(assetOnly);
  if (lines.length === 0) return null;
  const join = translateForLocale(locale, "menu.skipReportJoin");
  return lines.join(join);
}
