import { describe, expect, it } from "vitest";

import {
  browseStateForWorkspaceNavigation,
  historyReplayClosesPreview,
  workspaceNavigationKeepsLiveDiscovery,
} from "../../src/renderer/workspace-discovery-navigation";
import { createDefaultWorkspaceTabBrowseState } from "../../src/renderer/workspace-tabs";

describe("workspaceNavigationKeepsLiveDiscovery", () => {
  it("keeps live chips for same-tab push and history replay", () => {
    expect(
      workspaceNavigationKeepsLiveDiscovery({
        hasRequestBrowseState: false,
        historyMode: "push",
      }),
    ).toBe(true);
    expect(
      workspaceNavigationKeepsLiveDiscovery({
        hasRequestBrowseState: false,
        historyMode: "replay",
      }),
    ).toBe(true);
  });

  it("replaces live chips when restoring a tab snapshot or an unrestored tab", () => {
    expect(
      workspaceNavigationKeepsLiveDiscovery({
        hasRequestBrowseState: true,
        historyMode: "none",
      }),
    ).toBe(false);
    expect(
      workspaceNavigationKeepsLiveDiscovery({
        hasRequestBrowseState: false,
        historyMode: "none",
      }),
    ).toBe(false);
  });
});

describe("browseStateForWorkspaceNavigation", () => {
  it("keeps the live tab snapshot when same-tab navigation omits browseState", () => {
    const live = createDefaultWorkspaceTabBrowseState();
    live.filters.formatFilter = "text";
    const empty = createDefaultWorkspaceTabBrowseState();
    expect(
      browseStateForWorkspaceNavigation({
        requestBrowseState: undefined,
        liveBrowseState: live,
        emptyBrowseState: empty,
        historyMode: "replay",
      }),
    ).toBe(live);
    expect(
      browseStateForWorkspaceNavigation({
        requestBrowseState: undefined,
        liveBrowseState: live,
        emptyBrowseState: empty,
        historyMode: "push",
      }),
    ).toBe(live);
  });

  it("uses the empty snapshot when a tab restore omits browseState", () => {
    const live = createDefaultWorkspaceTabBrowseState();
    live.filters.formatFilter = "text";
    const empty = createDefaultWorkspaceTabBrowseState();
    expect(
      browseStateForWorkspaceNavigation({
        requestBrowseState: undefined,
        liveBrowseState: live,
        emptyBrowseState: empty,
        historyMode: "none",
      }),
    ).toBe(empty);
  });

  it("replaces live chips when the request carries a stored snapshot", () => {
    const live = createDefaultWorkspaceTabBrowseState();
    live.filters.formatFilter = "text";
    const stored = createDefaultWorkspaceTabBrowseState();
    stored.filters.formatFilter = "png";
    const empty = createDefaultWorkspaceTabBrowseState();
    expect(
      browseStateForWorkspaceNavigation({
        requestBrowseState: stored,
        liveBrowseState: live,
        emptyBrowseState: empty,
        historyMode: "none",
      }),
    ).toBe(stored);
  });
});

describe("historyReplayClosesPreview", () => {
  const folder = { kind: "folder" as const, folderId: "folder-a" };
  const preview = { kind: "preview" as const, assetId: "asset-1" };

  it("closes the viewer when Back lands on the browse scope under the preview", () => {
    expect(
      historyReplayClosesPreview({
        direction: "back",
        leaving: preview,
        arriving: folder,
        previewOpen: true,
        sameTab: true,
        browseUnderPreview: folder,
      }),
    ).toBe(true);
  });

  it("does not treat Forward onto a folder as a viewer close", () => {
    expect(
      historyReplayClosesPreview({
        direction: "forward",
        leaving: preview,
        arriving: folder,
        previewOpen: true,
        sameTab: true,
        browseUnderPreview: folder,
      }),
    ).toBe(false);
  });

  it("does not close when the arriving location is not the browse-under-preview", () => {
    expect(
      historyReplayClosesPreview({
        direction: "back",
        leaving: preview,
        arriving: { kind: "folder", folderId: "folder-b" },
        previewOpen: true,
        sameTab: true,
        browseUnderPreview: folder,
      }),
    ).toBe(false);
  });

  it("does not close across tabs or when the viewer is already gone", () => {
    expect(
      historyReplayClosesPreview({
        direction: "back",
        leaving: preview,
        arriving: folder,
        previewOpen: true,
        sameTab: false,
        browseUnderPreview: folder,
      }),
    ).toBe(false);
    expect(
      historyReplayClosesPreview({
        direction: "back",
        leaving: preview,
        arriving: folder,
        previewOpen: false,
        sameTab: true,
        browseUnderPreview: folder,
      }),
    ).toBe(false);
  });

  it("does not close ordinary folder-to-folder Back", () => {
    expect(
      historyReplayClosesPreview({
        direction: "back",
        leaving: { kind: "folder", folderId: "folder-b" },
        arriving: folder,
        previewOpen: false,
        sameTab: true,
        browseUnderPreview: null,
      }),
    ).toBe(false);
  });
});
