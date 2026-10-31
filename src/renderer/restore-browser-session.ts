/**
 * Apply a saved browser session after library open (WorldlineBox-uye extract).
 * App owns bootstrapping listOpen / default "all" load; this module owns the
 * session-scope branch + selected-asset recovery loops.
 */

import type {
  AssetSummary,
  FilterClause,
  SearchScope,
} from "../shared/asset-types";
import type { LibraryApiResult } from "../shared/library-api";
import type { RendererLibrarySummary } from "../shared/protocol/responses";
import type { StoredBrowserSession } from "./browser-session";
import { BROWSE_SCOPE_SEARCH } from "./browse-scope-search";
import { LibraryOperationError } from "./error-utils";
import type { BeginBrowsePage } from "./use-browse-pagination";
import {
  BROWSE_PAGE_SIZE,
  registerBrowseSearchPage,
  registerBrowseSmartCollectionPage,
} from "./use-browse-pagination";
import type { WorkspaceNavLocation } from "./workspace-nav-history";

export type SessionAssetPage = {
  items: AssetSummary[];
  total: number;
  offset: number;
};

export type RestoreBrowserSessionApi = {
  searchAssets(input: {
    libraryId: string;
    query?: {
      clauses: {
        field: string | null;
        values: string[];
        exclude: boolean;
      }[];
    } | null;
    filters?: FilterClause[];
    scope?: SearchScope;
    scopeMode?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<LibraryApiResult<SessionAssetPage>>;
  executeSmartCollection(input: {
    libraryId: string;
    collectionId: string;
    scopeMode?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<LibraryApiResult<SessionAssetPage>>;
};

export type LoadContentForRestore = (
  activeLibrary: RendererLibrarySummary,
  scope: "all" | "root" | string,
  opts?: {
    trashMode?: boolean;
    blockingLibraryLoad?: boolean;
    folderRecursive?: boolean;
    searchScope?: SearchScope;
    discovery?: { filters?: FilterClause[] };
  },
) => Promise<AssetSummary[] | undefined>;

export type RestoreBrowserSessionDeps = {
  api: RestoreBrowserSessionApi;
  library: RendererLibrarySummary;
  session: StoredBrowserSession;
  /** Items from the initial all-scope load before session apply. */
  initialItems: AssetSummary[];
  /** The first real browse session already loaded this saved scope. */
  initialScopeLoaded?: boolean;
  collectionRecursive: boolean;
  isFolderRecursiveEnabled: (libraryId: string, folderId: string) => boolean;
  loadContent: LoadContentForRestore;
  setShowTrash: (value: boolean) => void;
  setAssetScope: (scope: "all" | "root" | string) => void;
  setFolderRecursive: (enabled: boolean) => void;
  folderRecursiveRef: { current: boolean };
  setActiveTagId: (id: string | null) => void;
  setTagFilter: (name: string) => void;
  setActiveCollectionId: (id: string | null) => void;
  setActiveSmartCollectionId: (id: string | null) => void;
  setAssets: (
    update: AssetSummary[] | ((current: AssetSummary[]) => AssetSummary[]),
  ) => void;
  setTrashedAssets: (
    update: AssetSummary[] | ((current: AssetSummary[]) => AssetSummary[]),
  ) => void;
  setSearchTotal: (total: number | null) => void;
  /**
   * WorldlineBox-ws4k: register the restored scope with the pagination controller
   * so the scroll sentinel appends the next page with the same query/scope.
   */
  beginBrowsePage: BeginBrowsePage;
};

export type RestoreBrowserSessionResult = {
  restoredLocation: WorkspaceNavLocation;
  restoredAsset: AssetSummary | null;
};

/** Select the actual saved page before opening a browse snapshot. */
export function browserSessionInitialLoad(input: {
  session: StoredBrowserSession | null;
  collectionRecursive: boolean;
  folderRecursive(folderId: string): boolean;
}): {
  scope: "all" | "root" | string;
  options: NonNullable<Parameters<LoadContentForRestore>[2]>;
} {
  const scope = input.session?.scope;
  if (scope?.kind === "trash")
    return { scope: "all", options: { trashMode: true } };
  if (scope?.kind === "root") return { scope: "root", options: {} };
  if (scope?.kind === "folder")
    return {
      scope: scope.id,
      options: { folderRecursive: input.folderRecursive(scope.id) },
    };
  if (scope?.kind === "tag" && scope.name)
    return {
      scope: "all",
      options: {
        discovery: {
          filters: [{ field: "tag", values: [scope.name], exclude: false }],
        },
      },
    };
  if (scope?.kind === "collection")
    return {
      scope: "all",
      options: {
        searchScope: {
          kind: "collection",
          collectionId: scope.id,
          recursive: input.collectionRecursive,
        },
      },
    };
  if (scope?.kind === "smart")
    return {
      scope: "all",
      options: {
        searchScope: { kind: "smart_collection", collectionId: scope.id },
      },
    };
  return { scope: "all", options: {} };
}

/**
 * Recover the saved selection from the restored scope rows, or one extra
 * scope query / filename search when the asset is missing (WorldlineBox-6w7n).
 */
export async function findSessionSelectedAsset(args: {
  api: RestoreBrowserSessionApi;
  libraryId: string;
  session: StoredBrowserSession;
  restoredItems: readonly AssetSummary[];
  searchScope?: SearchScope;
  searchFilters?: FilterClause[];
}): Promise<AssetSummary | undefined> {
  const { api, libraryId, session, restoredItems, searchScope, searchFilters } =
    args;

  const restoredAsset = restoredItems.find(
    (asset) => asset.assetId === session.selectedAssetId,
  );
  if (restoredAsset) return restoredAsset;

  const result = await api.searchAssets({
    libraryId,
    query: {
      clauses: [
        {
          field: "filename",
          values: [session.selectedAssetName],
          exclude: false,
        },
      ],
    },
    filters: searchFilters,
    scope:
      session.scope.kind === "smart"
        ? { kind: "smart_collection", collectionId: session.scope.id }
        : searchScope,
    ...BROWSE_SCOPE_SEARCH,
  });
  if (!result.ok || result.value.items.length === 0) return undefined;
  return result.value.items.find(
    (asset) => asset.assetId === session.selectedAssetId,
  );
}

/**
 * Load the saved scope, then recover the selected asset into the grid.
 * On scope-load failure the caller should fall back to all-assets (App does).
 */
export async function applyStoredBrowserSession(
  deps: RestoreBrowserSessionDeps,
): Promise<RestoreBrowserSessionResult> {
  const {
    api,
    library,
    session,
    collectionRecursive,
    isFolderRecursiveEnabled,
    loadContent,
    setShowTrash,
    setAssetScope,
    setFolderRecursive,
    folderRecursiveRef,
    setActiveTagId,
    setTagFilter,
    setActiveCollectionId,
    setActiveSmartCollectionId,
    setAssets,
    setTrashedAssets,
    setSearchTotal,
    beginBrowsePage,
  } = deps;

  let restoredItems = deps.initialItems;
  let restoredLocation: WorkspaceNavLocation = { kind: "all" };
  let searchScope: SearchScope | undefined;
  let searchFilters: FilterClause[] | undefined;
  const preloaded = deps.initialScopeLoaded === true;

  if (session.scope.kind === "trash") {
    setShowTrash(true);
    setAssetScope("all");
    if (!preloaded)
      restoredItems =
        (await loadContent(library, "all", { trashMode: true })) ?? [];
    searchScope = { kind: "trash" };
    restoredLocation = { kind: "trash", tombstoneId: null };
  } else if (session.scope.kind === "root") {
    setAssetScope("root");
    if (!preloaded) restoredItems = (await loadContent(library, "root")) ?? [];
    searchScope = {
      kind: "folder",
      folderId: null,
      recursive: false,
    };
    restoredLocation = { kind: "root" };
  } else if (session.scope.kind === "folder") {
    setAssetScope(session.scope.id);
    const enabled = isFolderRecursiveEnabled(
      library.libraryId,
      session.scope.id,
    );
    folderRecursiveRef.current = enabled;
    setFolderRecursive(enabled);
    if (!preloaded)
      restoredItems = (await loadContent(library, session.scope.id)) ?? [];
    searchScope = {
      kind: "folder",
      folderId: session.scope.id,
      recursive: enabled,
    };
    restoredLocation = {
      kind: "folder",
      folderId: session.scope.id,
    };
  } else if (session.scope.kind === "tag" && session.scope.name) {
    searchFilters = [
      { field: "tag", values: [session.scope.name], exclude: false },
    ];
    if (!preloaded) {
      const result = await api.searchAssets({
        libraryId: library.libraryId,
        query: null,
        filters: searchFilters,
        // WorldlineBox-87pd: first window only; scrollbar jumps fetch other offsets.
        limit: BROWSE_PAGE_SIZE,
        offset: 0,
      });
      if (!result.ok) throw new LibraryOperationError(result.error);
      setSearchTotal(result.value.total);
      registerBrowseSearchPage(beginBrowsePage, {
        libraryId: library.libraryId,
        query: null,
        filters: searchFilters,
        scope: null,
        sort: null,
        showIgnored: false,
        target: "assets",
        items: result.value.items,
        total: result.value.total,
        offset: result.value.offset,
      });
      restoredItems = result.value.items;
    }
    setActiveTagId(session.scope.id);
    setTagFilter(session.scope.name);
    restoredLocation = { kind: "tag", tagId: session.scope.id };
  } else if (session.scope.kind === "collection") {
    searchScope = {
      kind: "collection",
      collectionId: session.scope.id,
      recursive: collectionRecursive,
    };
    if (!preloaded) {
      const result = await api.searchAssets({
        libraryId: library.libraryId,
        query: null,
        scope: searchScope,
        // WorldlineBox-87pd: first window only; scrollbar jumps fetch other offsets.
        limit: BROWSE_PAGE_SIZE,
        offset: 0,
      });
      if (!result.ok) throw new LibraryOperationError(result.error);
      setSearchTotal(result.value.total);
      registerBrowseSearchPage(beginBrowsePage, {
        libraryId: library.libraryId,
        query: null,
        filters: null,
        scope: searchScope,
        sort: null,
        showIgnored: false,
        target: "assets",
        items: result.value.items,
        total: result.value.total,
        offset: result.value.offset,
      });
      restoredItems = result.value.items;
    }
    setActiveCollectionId(session.scope.id);
    restoredLocation = {
      kind: "collection",
      collectionId: session.scope.id,
      recursive: collectionRecursive,
    };
  } else if (session.scope.kind === "smart") {
    if (!preloaded) {
      const result = await api.executeSmartCollection({
        libraryId: library.libraryId,
        collectionId: session.scope.id,
        // WorldlineBox-87pd: first window only; scrollbar jumps fetch other offsets.
        limit: BROWSE_PAGE_SIZE,
        offset: 0,
      });
      if (!result.ok) throw new LibraryOperationError(result.error);
      setSearchTotal(result.value.total);
      registerBrowseSmartCollectionPage(beginBrowsePage, {
        libraryId: library.libraryId,
        collectionId: session.scope.id,
        items: result.value.items,
        total: result.value.total,
        offset: result.value.offset,
      });
      restoredItems = result.value.items;
    }
    setActiveSmartCollectionId(session.scope.id);
    restoredLocation = {
      kind: "smart-collection",
      collectionId: session.scope.id,
    };
  }

  const restoredAsset =
    (await findSessionSelectedAsset({
      api,
      libraryId: library.libraryId,
      session,
      restoredItems,
      searchScope,
      searchFilters,
    })) ?? null;

  if (restoredAsset) {
    if (session.scope.kind === "trash") {
      setTrashedAssets((current) =>
        current.some((asset) => asset.assetId === restoredAsset.assetId)
          ? current
          : [...current, restoredAsset],
      );
    } else {
      setAssets((current) =>
        current.some((asset) => asset.assetId === restoredAsset.assetId)
          ? current
          : [...current, restoredAsset],
      );
    }
  }

  return { restoredLocation, restoredAsset };
}
