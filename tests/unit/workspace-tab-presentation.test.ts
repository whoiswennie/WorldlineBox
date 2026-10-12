import { describe, expect, it } from "vitest";

import { translateForLocale } from "../../src/renderer/i18n";
import {
  folderTabHoverPath,
  presentWorkspaceTab,
} from "../../src/renderer/workspace-tab-presentation";
import { createWorkspaceTabs } from "../../src/renderer/workspace-tabs";

describe("workspace tab presentation", () => {
  it("keeps a cached viewer title after another tab replaces the shared asset list", () => {
    const state = createWorkspaceTabs(() => "viewer-tab");
    const tab = state.tabs[0]!;
    tab.location = { kind: "preview", assetId: "asset-1" };
    tab.cachedTitle = "Reference board.png";

    expect(presentWorkspaceTab(tab, {
      folders: [],
      linkedFolders: [],
      collections: [],
      smartCollections: [],
      tags: [],
      assets: [],
      pluginViews: [],
      t: (key, params) => translateForLocale("en", key, params),
    })).toMatchObject({
      title: "Reference board.png",
      icon: "file",
      entity: null,
    });
  });

  it("exposes folder and collection identities only for their contextual menus", () => {
    const state = createWorkspaceTabs(() => "folder-tab");
    const tab = state.tabs[0]!;
    tab.location = { kind: "folder", folderId: "folder-1" };
    const common = {
      folders: [{
        folderId: "folder-1",
        parentFolderId: null,
        name: "Characters",
        relativePath: "Characters",
        directAssetCount: 2,
        childFolderCount: 0,
      }],
      linkedFolders: [],
      collections: [],
      smartCollections: [],
      tags: [],
      assets: [],
      pluginViews: [],
      t: (key: Parameters<typeof translateForLocale>[1], params?: Record<string, string | number>) =>
        translateForLocale("en", key, params),
    };

    expect(presentWorkspaceTab(tab, common)).toMatchObject({
      title: "Characters",
      tip: "Characters",
      entity: { kind: "folder", id: "folder-1", name: "Characters" },
    });
  });

  it("shows a managed folder's in-library path so same-named folders differ", () => {
    const state = createWorkspaceTabs(() => "folder-tab");
    const tab = state.tabs[0]!;
    tab.location = { kind: "folder", folderId: "folder-1" };

    expect(presentWorkspaceTab(tab, {
      folders: [{
        folderId: "folder-1",
        parentFolderId: null,
        name: "Characters",
        relativePath: "Reference/Characters",
        directAssetCount: 2,
        childFolderCount: 0,
      }],
      linkedFolders: [],
      collections: [],
      smartCollections: [],
      tags: [],
      assets: [],
      pluginViews: [],
      t: (key, params) => translateForLocale("en", key, params),
    })).toMatchObject({
      title: "Characters",
      tip: "Reference/Characters",
    });
  });

  it("shows a linked folder's path on disk, not its label", () => {
    const state = createWorkspaceTabs(() => "linked-tab");
    const tab = state.tabs[0]!;
    tab.location = { kind: "folder", folderId: "linked-1" };

    expect(presentWorkspaceTab(tab, {
      folders: [],
      linkedFolders: [{
        folderId: "linked-1",
        displayName: "绘画",
        status: "available",
        assetCount: 12,
        absoluteRootPath: "E:\\Media\\绘画",
        relativePath: "",
      }],
      collections: [],
      smartCollections: [],
      tags: [],
      assets: [],
      pluginViews: [],
      t: (key, params) => translateForLocale("en", key, params),
    })).toMatchObject({
      title: "绘画",
      tip: "E:\\Media\\绘画",
    });
  });

  it("carries folder and collection appearance onto workspace tabs", () => {
    const appearance = { glyphKind: "emoji" as const, glyphValue: "🎨", colorId: "blue" as const };
    const folderState = createWorkspaceTabs(() => "folder-tab");
    folderState.tabs[0]!.location = { kind: "folder", folderId: "folder-1" };
    expect(presentWorkspaceTab(folderState.tabs[0]!, {
      folders: [{
        folderId: "folder-1",
        parentFolderId: null,
        name: "Characters",
        relativePath: "Characters",
        directAssetCount: 2,
        childFolderCount: 0,
        appearance,
      }],
      linkedFolders: [],
      collections: [],
      smartCollections: [],
      tags: [],
      assets: [],
      pluginViews: [],
      t: (key, params) => translateForLocale("en", key, params),
    })).toMatchObject({ appearance, linkedBadge: null });

    const linkedState = createWorkspaceTabs(() => "linked-tab");
    linkedState.tabs[0]!.location = { kind: "folder", folderId: "linked-1" };
    expect(presentWorkspaceTab(linkedState.tabs[0]!, {
      folders: [],
      linkedFolders: [{
        folderId: "linked-1",
        displayName: "Paint",
        status: "offline",
        assetCount: 2,
        absoluteRootPath: "E:\\Media\\Paint",
        relativePath: "",
        appearance,
      }],
      collections: [],
      smartCollections: [],
      tags: [],
      assets: [],
      pluginViews: [],
      t: (key, params) => translateForLocale("en", key, params),
    })).toMatchObject({
      appearance,
      icon: "folder",
      linkedBadge: "link-off",
    });
  });

  it("repeats the title when a tab is not a folder", () => {
    const state = createWorkspaceTabs(() => "all-tab");
    expect(presentWorkspaceTab(state.tabs[0]!, {
      folders: [],
      linkedFolders: [],
      collections: [],
      smartCollections: [],
      tags: [],
      assets: [],
      pluginViews: [],
      t: (key, params) => translateForLocale("en", key, params),
    })).toMatchObject({ title: "All assets", tip: "All assets" });
  });

  it("joins a nested linked folder with the separator its root already uses", () => {
    expect(folderTabHoverPath(undefined, {
      absoluteRootPath: "E:\\Media\\绘画\\",
      relativePath: "/2024/角色",
    }, "fallback")).toBe("E:\\Media\\绘画\\2024\\角色");
    expect(folderTabHoverPath(undefined, {
      absoluteRootPath: "/mnt/media/art",
      relativePath: "2024",
    }, "fallback")).toBe("/mnt/media/art/2024");
    expect(folderTabHoverPath(undefined, undefined, "fallback")).toBe("fallback");
  });
});
