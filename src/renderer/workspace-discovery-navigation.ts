import type { WorkspaceNavigationHistoryMode } from "./workspace-navigation-coordinator";
import type { WorkspaceTabBrowseState } from "./workspace-tabs";
import {
  workspaceNavLocationsEqual,
  type WorkspaceNavLocation,
} from "./workspace-nav-history";

/**
 * Discovery (search + format/color/tag filters) belongs to the tab, not to a
 * history location.
 *
 * - An explicit `request.browseState` always replaces live chips (tab restore).
 * - `historyMode: "none"` without a snapshot is also a replace: a new or
 *   unrestored tab must not inherit the previous tab's filters.
 * - Same-tab `push` / `replay` without a snapshot keep the live tab state.
 *   Absence is not an empty snapshot.
 */
export function workspaceNavigationKeepsLiveDiscovery(input: {
  hasRequestBrowseState: boolean;
  historyMode: WorkspaceNavigationHistoryMode;
}): boolean {
  return !input.hasRequestBrowseState && input.historyMode !== "none";
}

export function browseStateForWorkspaceNavigation(input: {
  requestBrowseState: WorkspaceTabBrowseState | undefined;
  liveBrowseState: WorkspaceTabBrowseState;
  emptyBrowseState: WorkspaceTabBrowseState;
  historyMode: WorkspaceNavigationHistoryMode;
}): WorkspaceTabBrowseState {
  if (input.requestBrowseState) return input.requestBrowseState;
  if (input.historyMode === "none") return input.emptyBrowseState;
  return input.liveBrowseState;
}

export function historyReplayClosesPreview(input: {
  direction: "back" | "forward";
  leaving: WorkspaceNavLocation;
  arriving: WorkspaceNavLocation;
  previewOpen: boolean;
  sameTab: boolean;
  browseUnderPreview: WorkspaceNavLocation | null;
}): boolean {
  if (input.direction !== "back") return false;
  if (!input.previewOpen || !input.sameTab) return false;
  if (input.leaving.kind !== "preview") return false;
  if (input.arriving.kind === "preview") return false;
  if (!input.browseUnderPreview) return false;
  return workspaceNavLocationsEqual(input.arriving, input.browseUnderPreview);
}
