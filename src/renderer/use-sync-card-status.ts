import { useEffect, useMemo, useState } from "react";

import type { WorldlineBoxLibraryApi } from "../shared/library-api";
import {
  overlaySyncCardStatus,
  type SyncCardPersistedStatus,
  type SyncCardStatus,
} from "../shared/sync-card-status";

const STATUS_REQUEST_CAP = 300;

/** Stable empty result so an inactive hook always returns the same identity. */
const EMPTY_STATUSES: ReadonlyMap<string, SyncCardPersistedStatus> = new Map();

export function useSyncCardStatuses(input: {
  api: WorldlineBoxLibraryApi | null | undefined;
  libraryId: string | undefined;
  bound: boolean;
  showBadges: boolean;
  assetIds: readonly string[];
  syncing: boolean;
}): ReadonlyMap<string, SyncCardStatus> {
  const assetIdKey = useMemo(
    () => input.assetIds.slice(0, STATUS_REQUEST_CAP).join("\n"),
    [input.assetIds],
  );
  /**
   * The key the stored statuses belong to. When the hook is inactive (no
   * library, unbound, badges hidden) or there is nothing to ask about, this is
   * empty and the stale map is simply not used — writing an empty map from the
   * effect body instead would be a synchronous setState during render commit
   * (cascading re-render), which is what the lint rule forbids.
   */
  const activeKey = !input.api || !input.libraryId || !input.bound || !input.showBadges
    ? ""
    : assetIdKey;
  const [persistedState, setPersistedState] = useState<{
    key: string;
    statuses: ReadonlyMap<string, SyncCardPersistedStatus>;
  }>(() => ({ key: "", statuses: EMPTY_STATUSES }));

  useEffect(() => {
    const api = input.api;
    const libraryId = input.libraryId;
    if (!api || !libraryId || activeKey.length === 0) return;
    const assetIds = activeKey.split("\n");
    if (assetIds.length === 0) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = () => {
      if (typeof api.syncListCardStatuses !== "function") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void api.syncListCardStatuses({
          libraryId,
          assetIds,
        }).then((result) => {
          if (cancelled || !result.ok) return;
          setPersistedState({
            key: activeKey,
            statuses: new Map(
              result.value.map((entry) => [entry.assetId, entry.status] as const),
            ),
          });
        }).catch(() => undefined);
      }, 80);
    };
    load();
    const unsubscribe = api.onAssetsChanged((event) => {
      if (event.libraryId !== libraryId) return;
      load();
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [
    input.api,
    input.libraryId,
    input.bound,
    input.showBadges,
    input.syncing,
    activeKey,
  ]);

  const persisted = persistedState.key === activeKey
    ? persistedState.statuses
    : EMPTY_STATUSES;

  return useMemo(() => {
    const next = new Map<string, SyncCardStatus>();
    for (const [assetId, status] of persisted) {
      const visible = overlaySyncCardStatus(status, input.syncing);
      if (visible) next.set(assetId, visible);
    }
    return next;
  }, [persisted, input.syncing]);
}
