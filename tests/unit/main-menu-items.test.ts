import { describe, expect, it, vi } from "vitest";

import {
  buildMainMenuSections,
  collectMainMenuCommandStates,
  type MainMenuActions,
} from "../../src/renderer/main-menu-items";
import { setShortcutRuntime } from "../../src/renderer/shortcut-runtime";
import { DEFAULT_SHORTCUT_BINDINGS, setShortcutOverride } from "../../src/shared/shortcut-bindings";

function createActions(): MainMenuActions {
  return {
    createLibrary: vi.fn(),
    openLibrary: vi.fn(),
    closeLibrary: vi.fn(),
    removeLibrary: vi.fn(),
    deleteLibraryFromDisk: vi.fn(),
    importFiles: vi.fn(),
    importFolder: vi.fn(),
    importLinkedFolder: vi.fn(),
    pasteImage: vi.fn(),
    importLibrary: vi.fn(),
    exportLibrary: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    copySelection: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    invertSelection: vi.fn(),
    clearSelection: vi.fn(),
    openSettings: vi.fn(),
    openBackgroundJobs: vi.fn(),
    toggleFullscreen: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    openAppLog: vi.fn(),
    openAbout: vi.fn(),
    openGitHub: vi.fn(),
    openOpenSourceLicenses: vi.fn(),
    revealAppLog: vi.fn(),
    toggleShowMissingLinkedFiles: vi.fn(),
  };
}

function build(overrides?: Partial<Parameters<typeof buildMainMenuSections>[0]>) {
  const actions = createActions();
  const sections = buildMainMenuSections({
    locale: "zh-CN",
    platform: "windows",
    state: {
      libraryOpen: true,
      busy: false,
      hasUndoableOperation: true,
      hasRedoableOperation: false,
      hasSelectedAssets: true,
      hasPasteTarget: true,
      hasBrowseAssets: true,
      showMissingLinkedFiles: true,
    },
    actions,
    ...overrides,
  });
  return { actions, sections };
}

describe("main-menu-items (WorldlineBox-bnah)", () => {
  it("splits the menu bar into stable Windows sections", () => {
    const { sections } = build();
    expect(sections.map((section) => section.id)).toEqual([
      "file",
      "edit",
      "view",
      "library",
      "window",
      "about",
      "settings",
    ]);
    expect(sections.map((section) => section.label)).toEqual([
      "文件",
      "编辑",
      "查看",
      "资源库",
      "窗口",
      "关于",
      "设置",
    ]);
    expect(sections[1]?.items?.find((item) => item.id === "edit.select-all")?.shortcut).toBe(
      "Ctrl+A",
    );
    expect(sections[1]?.items?.find((item) => item.id === "edit.undo")?.shortcut).toBe(
      "Ctrl+Z",
    );
    expect(sections[1]?.items?.find((item) => item.id === "edit.redo")?.shortcut).toBe(
      "Ctrl+Shift+Z",
    );
  });

  it("uses the macOS undo and redo shortcut labels", () => {
    const { sections } = build({ platform: "mac" });
    const edit = sections.find((section) => section.id === "edit");
    expect(edit?.items?.find((item) => item.id === "edit.undo")?.shortcut).toBe("⌘Z");
    expect(edit?.items?.find((item) => item.id === "edit.redo")?.shortcut).toBe("⌘⇧Z");
  });

  it("updates Main menu labels from the active shortcut bindings", () => {
    let bindings = setShortcutOverride(DEFAULT_SHORTCUT_BINDINGS, "mac", "edit.undo", {
      key: "y", code: "KeyY", metaKey: true,
    });
    bindings = setShortcutOverride(bindings, "mac", "selection.invert", {
      key: "i", code: "KeyI", metaKey: true, shiftKey: true,
    });
    setShortcutRuntime("mac", bindings);
    const { sections } = build({ platform: "mac" });
    const edit = sections.find((section) => section.id === "edit");
    expect(edit?.items?.find((item) => item.id === "edit.undo")?.shortcut).toBe("⌘Y");
    expect(edit?.items?.find((item) => item.id === "edit.invert-selection")?.shortcut).toBe("⌘⇧I");
    setShortcutRuntime("windows", DEFAULT_SHORTCUT_BINDINGS);
  });

  it("gates library and selection actions from the shared state", () => {
    const { sections } = build({
      state: {
        libraryOpen: false,
        busy: true,
        hasUndoableOperation: false,
        hasRedoableOperation: false,
        hasSelectedAssets: false,
        hasPasteTarget: false,
        hasBrowseAssets: false,
        showMissingLinkedFiles: true,
      },
    });
    const file = sections.find((section) => section.id === "file");
    const edit = sections.find((section) => section.id === "edit");
    expect(file?.items?.every((item) => item.disabled)).toBe(true);
    expect(edit?.items?.find((item) => item.id === "edit.select-all")?.disabled).toBe(true);
    expect(edit?.items?.find((item) => item.id === "edit.clear-selection")?.disabled).toBe(true);
  });

  it("replaces the version display with a check-for-updates item (WorldlineBox-0fe8b4)", () => {
    const { actions, sections } = build();
    const about = sections.find((section) => section.id === "about");
    expect(about?.items?.find((item) => item.id === "about.version")).toBeUndefined();
    const checkUpdate = about?.items?.find(
      (item) => item.id === "about.check-update",
    );
    expect(checkUpdate?.label).toBe("检查更新");
    checkUpdate?.onSelect?.();
    expect(actions.openAbout).toHaveBeenCalledTimes(1);
  });

  it("keeps the action callbacks attached to their split menu items", () => {
    const { actions, sections } = build();
    const settings = sections.find((section) => section.id === "settings");
    settings?.onSelect?.();
    expect(actions.openSettings).toHaveBeenCalledTimes(1);
    expect(settings?.items).toBeUndefined();
    expect(sections.find((section) => section.id === "window")?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "window.toggle-fullscreen", shortcut: "F11" }),
        expect.objectContaining({ id: "window.background-jobs" }),
        expect.objectContaining({ id: "window.diagnostics" }),
      ]),
    );
    const fullscreen = sections
      .find((section) => section.id === "window")
      ?.items?.find((item) => item.id === "window.toggle-fullscreen");
    fullscreen?.onSelect();
    expect(actions.toggleFullscreen).toHaveBeenCalledTimes(1);
    const about = sections.find((section) => section.id === "about");
    const diagnostics = about?.items?.find((item) => item.id === "about.diagnostics");
    diagnostics?.onSelect?.();
    expect(actions.openAppLog).toHaveBeenCalledTimes(1);
  });

  it("shows Control+Command+F for window fullscreen on macOS", () => {
    const { sections } = build({ platform: "mac" });
    expect(
      sections
        .find((section) => section.id === "window")
        ?.items?.find((item) => item.id === "window.toggle-fullscreen")?.shortcut,
    ).toBe("⌃⌘F");
  });

  it("keeps the Library menu aligned with the library switcher", () => {
    const { sections } = build();
    const file = sections.find((section) => section.id === "file");
    const library = sections.find((section) => section.id === "library");
    expect(file?.items?.some((item) => item.id === "library.import-eagle")).toBe(false);
    expect(library?.items?.map((item) => item.id)).toEqual([
      "library.create",
      "library.open",
      "library.close",
      "library.import",
      "library.export",
      "library.remove",
      "library.delete-from-disk",
      "library.settings",
      "library.show-missing-linked",
    ]);
    expect(library?.items?.find((item) => item.id === "library.rename")).toBeUndefined();
    expect(library?.items?.find((item) => item.id === "library.open-external")).toBeUndefined();
    expect(library?.items?.find((item) => item.id === "library.import-external")).toBeUndefined();
    expect(library?.items?.find((item) => item.id === "library.delete-from-disk")?.danger).toBe(
      true,
    );
  });

  it("maps canonical custom commands to native enabled states", () => {
    const { sections } = build({
      state: {
        libraryOpen: false,
        busy: true,
        hasUndoableOperation: false,
        hasRedoableOperation: false,
        hasSelectedAssets: false,
        hasPasteTarget: false,
        hasBrowseAssets: false,
        showMissingLinkedFiles: true,
      },
    });
    const states = new Map(
      collectMainMenuCommandStates(sections).map((state) => [state.command, state.enabled]),
    );
    expect(states.get("library.close")).toBe(false);
    expect(states.get("library.open")).toBe(false);
    expect(states.get("library.export")).toBe(false);
    expect(states.get("settings")).toBe(false);
    expect(states.get("window.diagnostics")).toBe(true);
  });

  it("does not expose a library rename menu item", () => {
    const { sections } = build();
    const library = sections.find((section) => section.id === "library");
    expect(library?.items?.some((item) => item.id === "library.rename")).toBe(false);
  });

  it("routes paste-image in the File menu to the clipboard-image action (WorldlineBox-a3de58)", () => {
    const { actions, sections } = build();
    const file = sections.find((section) => section.id === "file");
    const item = file?.items?.find((candidate) => candidate.id === "file.paste-image");
    expect(item?.label).toBe("粘贴图片");
    expect(item?.disabled).toBe(false);
    item?.onSelect?.();
    expect(actions.pasteImage).toHaveBeenCalledTimes(1);
  });

  it("disables paste-image when no library is open", () => {
    const { sections } = build({
      state: {
        libraryOpen: false,
        busy: false,
        hasUndoableOperation: false,
        hasRedoableOperation: false,
        hasSelectedAssets: false,
        hasPasteTarget: false,
        hasBrowseAssets: false,
        showMissingLinkedFiles: true,
      },
    });
    const file = sections.find((section) => section.id === "file");
    expect(file?.items?.find((item) => item.id === "file.paste-image")?.disabled).toBe(true);
  });
});
