import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  addWorkspaceTab,
  closeWorkspaceTab,
  closeWorkspaceTabsExcept,
  createWorkspaceTabs,
  getWorkspaceTab,
  moveWorkspaceTab,
  selectWorkspaceTab,
  setWorkspaceTabLocation,
  setWorkspaceTabViewport,
  updateWorkspaceTabBrowseState,
  updateWorkspaceTabContext,
  type WorkspaceTabBrowseState,
  type WorkspaceTabSession,
  type WorkspaceTabsState,
} from "./workspace-tabs";
import {
  createWorkspaceTabsFromSession,
  type StoredWorkspaceTabsSession,
} from "./workspace-tabs-session";
import {
  createWorkspaceNavHistory,
  seedRestoreLeafLocation,
  workspaceNavLocationsEqual,
  type WorkspaceNavHistory,
  type WorkspaceNavLocation,
  type WorkspaceNavViewport,
} from "./workspace-nav-history";
import {
  createWorkspaceNavigationCoordinator,
  type WorkspaceNavigationHistoryMode,
  type WorkspaceNavigationToken,
} from "./workspace-navigation-coordinator";
import {
  createWorkspaceRenderSnapshotCache,
  type WorkspaceRenderSnapshot,
} from "./workspace-render-snapshot-cache";

export interface WorkspaceTabCapturedContext {
  viewport: WorkspaceTabSession["viewport"];
  selectedAssetIds: readonly string[];
  selectedAssetId: string | null;
  browseState: WorkspaceTabBrowseState;
  cachedTitle: string;
  renderSnapshot: WorkspaceRenderSnapshot | null;
}

export interface UseWorkspaceTabsControllerOptions {
  captureContext: () => WorkspaceTabCapturedContext | null;
  restoreTab: (
    tab: WorkspaceTabSession,
    isCurrent: () => boolean,
  ) => Promise<void>;
  restoreAll: (isCurrent: () => boolean) => Promise<void>;
  beginTransition: () => () => boolean;
  getDefaultBrowseState: () => WorkspaceTabBrowseState;
  onHistoryChanged: (history: WorkspaceNavHistory) => void;
  /**
   * Persists the strip after a user tab action. Locations come straight off the
   * live tabs, so this stays accurate without a separate save step, and tearing
   * the strip down for a library change never writes a session.
   */
  persistTabs: (state: WorkspaceTabsState) => void;
}

export interface SelectWorkspaceTabOptions {
  /**
   * Replay a specific location on the target tab (shared Back/Forward crossing
   * tab boundaries). When set, the switch is NOT recorded as a new history
   * step; the tab's cached location is replaced with it instead.
   */
  location?: WorkspaceNavLocation;
  /** Viewport to restore alongside a replayed location. */
  viewport?: WorkspaceNavViewport;
}

/**
 * Owns tab lifetimes. There is a single shared Back/Forward timeline
 * (`historyRef`): every tab keeps only its current location, and switching tabs
 * records a step so Back/Forward can cross tab switches (WorldlineBox-b8a853).
 */
export function useWorkspaceTabsController(options: UseWorkspaceTabsControllerOptions) {
  const [state, setState] = useState(createWorkspaceTabs);
  const stateRef = useRef(state);
  const historyRef = useRef(
    createWorkspaceNavHistory(state.tabs[0]!.location, state.tabs[0]!.id),
  );
  const callbacksRef = useRef(options);
  const transitionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const transitionEpochRef = useRef(0);
  const [navigation] = useState(() =>
    createWorkspaceNavigationCoordinator(state.activeTabId),
  );
  const [renderSnapshotCache] = useState(createWorkspaceRenderSnapshotCache);
  useLayoutEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  const commit = useCallback((next: WorkspaceTabsState, persist = true) => {
    stateRef.current = next;
    const activeTab = getWorkspaceTab(next, next.activeTabId);
    if (activeTab) historyRef.current.setActiveTab(activeTab.id);
    setState(next);
    if (activeTab) callbacksRef.current.onHistoryChanged(historyRef.current);
    if (persist) callbacksRef.current.persistTabs(next);
  }, []);

  const saveActiveContext = useCallback(() => {
    const current = stateRef.current;
    const active = getWorkspaceTab(current, current.activeTabId);
    if (!active) return current;
    // Keep the active tab's cached location at the shared cursor, so a later
    // switch/replay restores where that tab really was (the per-tab location
    // is no longer a history stack; the shared timeline owns the steps).
    let next = setWorkspaceTabLocation(
      current,
      active.id,
      historyRef.current.current,
    );
    const captured = callbacksRef.current.captureContext();
    if (captured) {
      // Persist the outgoing entry's scroll position so Back can restore it.
      historyRef.current.saveCurrentViewport(captured.viewport);
      next = setWorkspaceTabViewport(next, active.id, captured.viewport);
      if (captured.renderSnapshot) {
        renderSnapshotCache.set(active.id, captured.renderSnapshot);
      } else {
        renderSnapshotCache.delete(active.id);
      }
      next = updateWorkspaceTabContext(next, active.id, captured);
      next = updateWorkspaceTabBrowseState(next, active.id, captured.browseState);
    }
    stateRef.current = next;
    return next;
  }, [renderSnapshotCache]);

  const enqueueTransition = useCallback(
    (operation: (epoch: number, isRequestCurrent: () => boolean) => Promise<void>) => {
      const isRequestCurrent = callbacksRef.current.beginTransition();
      const requestedEpoch = transitionEpochRef.current;
      const pending = transitionQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (
            requestedEpoch !== transitionEpochRef.current ||
            !isRequestCurrent()
          ) return;
          await operation(requestedEpoch, isRequestCurrent);
        });
      transitionQueueRef.current = pending.catch(() => undefined);
      return pending;
    },
    [],
  );

  const restoreActive = useCallback(async (
    next: WorkspaceTabsState,
    epoch: number,
    isRequestCurrent: () => boolean,
    navigationToken?: WorkspaceNavigationToken,
  ) => {
    const tab = getWorkspaceTab(next, next.activeTabId);
    if (!tab) return;
    historyRef.current.setActiveTab(tab.id);
    callbacksRef.current.onHistoryChanged(historyRef.current);
    await callbacksRef.current.restoreTab(
      tab,
      () =>
        epoch === transitionEpochRef.current &&
        stateRef.current.activeTabId === tab.id &&
        isRequestCurrent() &&
        (navigationToken === undefined ||
          navigation.isCurrent(navigationToken)),
    );
  }, [navigation]);

  const selectTab = useCallback(
    (tabId: string, options?: SelectWorkspaceTabOptions) =>
      enqueueTransition(async (epoch, isRequestCurrent) => {
        const current = stateRef.current;
        if (!getWorkspaceTab(current, tabId)) return;
        const replayLocation = options?.location;
        if (current.activeTabId === tabId && replayLocation === undefined) return;
        // On a replay switch the caller already synced the outgoing tab's
        // location to the pre-replay cursor; capturing again here would read
        // the already-moved cursor and corrupt it.
        const saved = replayLocation !== undefined
          ? stateRef.current
          : saveActiveContext();
        let next = selectWorkspaceTab(saved, tabId);
        if (replayLocation !== undefined) {
          next = setWorkspaceTabLocation(next, tabId, replayLocation);
          if (options?.viewport) {
            next = setWorkspaceTabViewport(next, tabId, options.viewport);
          }
        }
        const targetTab = getWorkspaceTab(next, tabId)!;
        navigation.activateTab(tabId);
        const navigationToken = navigation.begin(tabId, "none");
        historyRef.current.setActiveTab(tabId);
        // A user tab switch is a history step (its view changed). Replaying a
        // history entry across tabs must not record a new step.
        if (replayLocation === undefined) {
          historyRef.current.push(targetTab.location);
        }
        commit(next);
        await restoreActive(next, epoch, isRequestCurrent, navigationToken);
      }),
    [commit, enqueueTransition, navigation, restoreActive, saveActiveContext],
  );

  const addTab = useCallback(
    () => enqueueTransition(async (epoch, isRequestCurrent) => {
      const saved = saveActiveContext();
      let next = addWorkspaceTab(saved);
      next = updateWorkspaceTabBrowseState(
        next,
        next.activeTabId,
        callbacksRef.current.getDefaultBrowseState(),
      );
      const tab = getWorkspaceTab(next, next.activeTabId)!;
      navigation.activateTab(tab.id);
      const navigationToken = navigation.begin(tab.id, "none");
      // Activating the new tab shows its (root) view — a history step.
      historyRef.current.setActiveTab(tab.id);
      historyRef.current.push(tab.location);
      commit(next);
      await restoreActive(next, epoch, isRequestCurrent, navigationToken);
    }),
    [commit, enqueueTransition, navigation, restoreActive, saveActiveContext],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const immediateState = stateRef.current;
      if (immediateState.activeTabId !== tabId) {
        const result = closeWorkspaceTab(immediateState, tabId);
        if (result.state === immediateState) return Promise.resolve();
        navigation.closeTab(tabId);
        for (const removedTabId of result.removedTabIds) {
          historyRef.current.removeTab(removedTabId);
          renderSnapshotCache.delete(removedTabId);
        }
        commit(result.state);
        return Promise.resolve();
      }
      return enqueueTransition(async (epoch, isRequestCurrent) => {
      const current = stateRef.current;
      const saved = current.activeTabId === tabId ? saveActiveContext() : current;
      const result = closeWorkspaceTab(saved, tabId);
      if (result.state === saved) return;
      for (const removedTabId of result.removedTabIds) {
        navigation.closeTab(removedTabId);
        historyRef.current.removeTab(removedTabId);
        renderSnapshotCache.delete(removedTabId);
      }
      let next = result.state;
      if (result.shouldNavigateToAll && result.removedTabIds.length === 0) {
        next = updateWorkspaceTabBrowseState(
          next,
          next.activeTabId,
          callbacksRef.current.getDefaultBrowseState(),
        );
        historyRef.current.clear(
          { kind: "all" },
          next.activeTabId,
        );
      }
      let navigationToken: WorkspaceNavigationToken | undefined;
      if (result.shouldNavigateToAll) {
        if (result.removedTabIds.length > 0) {
          navigation.activateTab(next.activeTabId);
        }
        navigationToken = navigation.begin(next.activeTabId, "none");
      }
      commit(next);
      if (result.shouldNavigateToAll) {
        if (result.removedTabIds.length === 0) {
          await callbacksRef.current.restoreAll(
            () =>
              epoch === transitionEpochRef.current &&
              stateRef.current.activeTabId === next.activeTabId &&
              isRequestCurrent() &&
              (navigationToken === undefined ||
                navigation.isCurrent(navigationToken)),
          );
        } else {
          await restoreActive(next, epoch, isRequestCurrent, navigationToken);
        }
      }
      });
    },
    [commit, enqueueTransition, navigation, renderSnapshotCache, restoreActive, saveActiveContext],
  );

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      const immediateState = stateRef.current;
      if (immediateState.activeTabId === tabId) {
        const result = closeWorkspaceTabsExcept(immediateState, tabId);
        if (result.state === immediateState) return Promise.resolve();
        for (const removedTabId of result.removedTabIds) {
          navigation.closeTab(removedTabId);
          historyRef.current.removeTab(removedTabId);
          renderSnapshotCache.delete(removedTabId);
        }
        commit(result.state);
        return Promise.resolve();
      }
      return enqueueTransition(async (epoch, isRequestCurrent) => {
      const saved = saveActiveContext();
      const result = closeWorkspaceTabsExcept(saved, tabId);
      if (result.state === saved) return;
      for (const removedTabId of result.removedTabIds) {
        navigation.closeTab(removedTabId);
        historyRef.current.removeTab(removedTabId);
        renderSnapshotCache.delete(removedTabId);
      }
      navigation.activateTab(tabId);
      const navigationToken = navigation.begin(tabId, "none");
      commit(result.state);
      if (result.shouldNavigateToAll) {
        await restoreActive(result.state, epoch, isRequestCurrent, navigationToken);
      }
      });
    },
    [commit, enqueueTransition, navigation, renderSnapshotCache, restoreActive, saveActiveContext],
  );

  const resetTabs = useCallback(() => {
    transitionEpochRef.current += 1;
    callbacksRef.current.beginTransition();
    const next = createWorkspaceTabs();
    navigation.invalidateLibrary();
    navigation.activateTab(next.activeTabId);
    renderSnapshotCache.clear();
    historyRef.current.clear(next.tabs[0]!.location, next.tabs[0]!.id);
    // Closing or switching a library tears the strip down; the next library's
    // own session must survive, so this teardown is never written.
    commit(next, false);
  }, [commit, navigation, renderSnapshotCache]);

  /**
   * Rebuilds the strip for the library that just opened. Tab content itself is
   * restored lazily: the startup browse session owns the active tab, and any
   * other tab is loaded the first time the user selects it. The shared
   * Back/Forward timeline is reseeded for the active tab.
   *
   * Returns the rebuilt state and skips the persist hook: this runs during the
   * startup restore, before `library` has re-rendered, so the caller writes the
   * session against the library id it already knows.
   */
  const restoreTabs = useCallback(
    (session: StoredWorkspaceTabsSession | null): WorkspaceTabsState => {
      transitionEpochRef.current += 1;
      callbacksRef.current.beginTransition();
      const next = session
        ? createWorkspaceTabsFromSession(session)
        : createWorkspaceTabs();
      navigation.invalidateLibrary();
      navigation.activateTab(next.activeTabId);
      renderSnapshotCache.clear();
      const active = getWorkspaceTab(next, next.activeTabId)!;
      historyRef.current.clear({ kind: "all" }, active.id);
      seedRestoreLeafLocation(historyRef.current, active.location, active.id);
      commit(next, false);
      return next;
    },
    [commit, navigation, renderSnapshotCache],
  );

  /** Reordering changes the strip only — never identity, content, or focus. */
  const moveTab = useCallback(
    (tabId: string, toIndex: number) => {
      const next = moveWorkspaceTab(stateRef.current, tabId, toIndex);
      if (next === stateRef.current) return;
      commit(next);
    },
    [commit],
  );

  /**
   * Mirrors the shared cursor onto the active tab's cached location. Called
   * after every navigation (the tab strip reads `tab.location`, so it must
   * track the live view, not just the value captured when the tab was left).
   * Skipped mid cross-tab replay, when the cursor points at another tab.
   */
  const syncActiveTabLocation = useCallback(() => {
    const current = stateRef.current;
    const tab = getWorkspaceTab(current, current.activeTabId);
    if (!tab) return;
    if (historyRef.current.currentTabId !== tab.id) return;
    if (workspaceNavLocationsEqual(tab.location, historyRef.current.current)) {
      return;
    }
    const next = setWorkspaceTabLocation(
      current,
      tab.id,
      historyRef.current.current,
    );
    stateRef.current = next;
    setState(next);
  }, []);

  const beginNavigation = useCallback(
    (historyMode: WorkspaceNavigationHistoryMode = "push") => {
      transitionEpochRef.current += 1;
      callbacksRef.current.beginTransition();
      return navigation.begin(
        stateRef.current.activeTabId,
        historyMode,
      );
    },
    [navigation],
  );
  const isNavigationCurrent = useCallback(
    (token: WorkspaceNavigationToken) =>
      navigation.isCurrent(token),
    [navigation],
  );
  const activateRenderSnapshotLibrary = useCallback((libraryId: string | null) => {
    renderSnapshotCache.activateLibrary(libraryId);
  }, [renderSnapshotCache]);
  const getRenderSnapshot = useCallback((tabId: string) =>
    renderSnapshotCache.get(tabId),
  [renderSnapshotCache]);
  const clearRenderSnapshots = useCallback(() => {
    renderSnapshotCache.clear();
  }, [renderSnapshotCache]);

  return {
    state,
    stateRef,
    activeTabId: state.activeTabId,
    historyRef,
    selectTab,
    addTab,
    closeTab,
    closeOtherTabs,
    moveTab,
    resetTabs,
    restoreTabs,
    saveActiveContext,
    syncActiveTabLocation,
    beginNavigation,
    isNavigationCurrent,
    activateRenderSnapshotLibrary,
    getRenderSnapshot,
    clearRenderSnapshots,
  };
}
