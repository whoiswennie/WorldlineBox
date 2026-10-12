export type WorkspaceNavLocation =
  | { kind: "all" }
  | { kind: "root" }
  | { kind: "folder"; folderId: string }
  | { kind: "tag"; tagId: string }
  | { kind: "collection"; collectionId: string; recursive: boolean }
  | { kind: "smart-collection"; collectionId: string }
  | { kind: "trash"; tombstoneId: string | null }
  /**
   * 资产查看器：打开资产 = 一个历史状态（WorldlineBox-b7e173）。查看器内
   * next/prev 用 replaceCurrent 原地更新 assetId，不新增历史条目。
   */
  | { kind: "preview"; assetId: string }
  | { kind: "tag-management" }
  | { kind: "plugin-sidebar"; viewId: string };

export interface WorkspaceNavViewport {
  /** Exact scroll offset, used when the restored extent is unchanged. */
  scrollTop: number;
  /** Relative position keeps a location stable when its virtual extent changes. */
  scrollProgress: number;
  scrollExtent: number;
}

/**
 * One step in the shared workspace timeline. The tab id travels with the
 * location so Back/Forward can cross tab switches: replaying an entry whose
 * tab differs first activates that tab, then restores its recorded location.
 */
export interface WorkspaceNavEntry {
  readonly tabId: string;
  readonly location: WorkspaceNavLocation;
}

export type WorkspaceNavHistory = {
  /** Location of the entry the cursor is on. */
  current: WorkspaceNavLocation;
  /** Tab the current entry belongs to (may differ from the active tab while a
   *  cross-tab Back/Forward replay is in flight). */
  currentTabId: string;
  currentViewport: WorkspaceNavViewport;
  canBack: boolean;
  canForward: boolean;
  /**
   * Tells the history which tab subsequent `push`es belong to. Called when the
   * active tab changes (user switch, new tab, restore) — not a history event
   * by itself; the tab-switch entry is pushed explicitly by the caller.
   */
  setActiveTab: (tabId: string) => void;
  push: (location: WorkspaceNavLocation) => void;
  saveCurrentViewport: (viewport: WorkspaceNavViewport) => void;
  /** 原地替换当前条目（查看器内切资产用），不清空 forward 分支。 */
  replaceCurrent: (location: WorkspaceNavLocation) => void;
  /** 移除当前条目并回退到前一条（X/Esc 主动关闭查看器用），无 forward 残留。 */
  dismissCurrent: () => void;
  back: () => WorkspaceNavLocation | null;
  forward: () => WorkspaceNavLocation | null;
  clear: (initial?: WorkspaceNavLocation, tabId?: string) => void;
  /** Drops every entry that belongs to a closed tab (WorldlineBox-b8a853). */
  removeTab: (tabId: string) => void;
  peek: (delta: number) => WorkspaceNavLocation | null;
  peekViewport: (delta: number) => WorkspaceNavViewport | null;
  peekTabId: (delta: number) => string | null;
};

const DEFAULT_LOCATION: WorkspaceNavLocation = { kind: "all" };
const DEFAULT_VIEWPORT: WorkspaceNavViewport = {
  scrollTop: 0,
  scrollProgress: 0,
  scrollExtent: 0,
};

export function workspaceNavLocationsEqual(
  a: WorkspaceNavLocation,
  b: WorkspaceNavLocation,
): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "all":
    case "root":
      return true;
    case "trash":
      return (
        a.tombstoneId ===
        (b as Extract<WorkspaceNavLocation, { kind: "trash" }>).tombstoneId
      );
    case "folder":
      return a.folderId === (b as Extract<WorkspaceNavLocation, { kind: "folder" }>).folderId;
    case "tag":
      return a.tagId === (b as Extract<WorkspaceNavLocation, { kind: "tag" }>).tagId;
    case "collection": {
      const other = b as Extract<WorkspaceNavLocation, { kind: "collection" }>;
      return a.collectionId === other.collectionId && a.recursive === other.recursive;
    }
    case "smart-collection":
      return (
        a.collectionId ===
        (b as Extract<WorkspaceNavLocation, { kind: "smart-collection" }>).collectionId
      );
    case "preview":
      return a.assetId === (b as Extract<WorkspaceNavLocation, { kind: "preview" }>).assetId;
    case "tag-management":
      return true;
    case "plugin-sidebar":
      return a.viewId === (b as Extract<WorkspaceNavLocation, { kind: "plugin-sidebar" }>).viewId;
  }
}

/**
 * 会话恢复的叶子位置种子（WorldlineBox-ada7ad）：恢复进非 all scope 时以
 * {kind:"all"} 作为历史基底再 push 叶子，使「后退到全部资产」从第一帧即可用；
 * 恢复为 all 本身则保持单条、canBack=false。返回恢复后 canBack 是否应为 true。
 */
export function seedRestoreLeafLocation(
  history: WorkspaceNavHistory,
  restored: WorkspaceNavLocation,
  tabId: string = history.currentTabId,
): { canBack: boolean } {
  const baseIsAll = restored.kind === "all";
  history.clear({ kind: "all" }, tabId);
  if (!baseIsAll) history.push(restored);
  return { canBack: !baseIsAll };
}

/**
 * The single shared workspace timeline. Entries are `{tabId, location}` so a
 * Back/Forward step can cross a tab switch; `setActiveTab` stamps the tab that
 * later pushes belong to, and `removeTab` drops a closed tab's steps.
 */
export function createWorkspaceNavHistory(
  initial: WorkspaceNavLocation = DEFAULT_LOCATION,
  initialTabId = "workspace-tab-0",
): WorkspaceNavHistory {
  const stack: Array<{
    tabId: string;
    location: WorkspaceNavLocation;
    viewport: WorkspaceNavViewport;
  }> = [
    { tabId: initialTabId, location: initial, viewport: { ...DEFAULT_VIEWPORT } },
  ];
  let index = 0;
  let activeTabId = initialTabId;

  const syncCurrent = () => {
    history.current = stack[index]!.location;
    history.currentTabId = stack[index]!.tabId;
    history.currentViewport = stack[index]!.viewport;
    history.canBack = index > 0;
    history.canForward = index < stack.length - 1;
  };

  const history: WorkspaceNavHistory = {
    current: initial,
    currentTabId: initialTabId,
    currentViewport: { ...DEFAULT_VIEWPORT },
    canBack: false,
    canForward: false,
    setActiveTab(tabId) {
      activeTabId = tabId;
    },
    push(location) {
      const entry = stack[index]!;
      if (
        entry.tabId === activeTabId &&
        workspaceNavLocationsEqual(entry.location, location)
      ) {
        entry.viewport = { ...DEFAULT_VIEWPORT };
        syncCurrent();
        return;
      }
      stack.length = index + 1;
      stack.push({ tabId: activeTabId, location, viewport: { ...DEFAULT_VIEWPORT } });
      index = stack.length - 1;
      syncCurrent();
    },
    saveCurrentViewport(viewport) {
      stack[index]!.viewport = {
        scrollTop: Math.max(0, viewport.scrollTop),
        scrollProgress: Math.min(1, Math.max(0, viewport.scrollProgress)),
        scrollExtent: Math.max(0, viewport.scrollExtent),
      };
      syncCurrent();
    },
    replaceCurrent(location) {
      stack[index]!.location = location;
      syncCurrent();
    },
    dismissCurrent() {
      if (index <= 0) {
        return;
      }
      stack.splice(index, 1);
      index -= 1;
      activeTabId = stack[index]!.tabId;
      syncCurrent();
    },
    back() {
      if (index <= 0) {
        return null;
      }
      index -= 1;
      activeTabId = stack[index]!.tabId;
      syncCurrent();
      return history.current;
    },
    forward() {
      if (index >= stack.length - 1) {
        return null;
      }
      index += 1;
      activeTabId = stack[index]!.tabId;
      syncCurrent();
      return history.current;
    },
    clear(nextInitial = DEFAULT_LOCATION, tabId = activeTabId) {
      stack.length = 0;
      stack.push({ tabId, location: nextInitial, viewport: { ...DEFAULT_VIEWPORT } });
      index = 0;
      activeTabId = tabId;
      syncCurrent();
    },
    removeTab(tabId) {
      const currentEntry = stack[index]!;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.tabId !== tabId) continue;
        stack.splice(i, 1);
        if (i <= index) index -= 1;
      }
      // Steps that became adjacent duplicates (same tab + location) once the
      // closed tab's steps are gone would make Back land on a no-op; collapse
      // them so every Back moves the view.
      for (let i = 1; i < stack.length; ) {
        const prev = stack[i - 1]!;
        const entry = stack[i]!;
        if (
          entry.tabId === prev.tabId &&
          workspaceNavLocationsEqual(entry.location, prev.location)
        ) {
          stack.splice(i, 1);
          if (i <= index) index -= 1;
        } else {
          i += 1;
        }
      }
      if (stack.length === 0) {
        stack.push({
          tabId: currentEntry.tabId === tabId ? activeTabId : currentEntry.tabId,
          location: { ...DEFAULT_LOCATION },
          viewport: { ...DEFAULT_VIEWPORT },
        });
        index = 0;
      } else if (index < 0) {
        index = 0;
      } else if (index > stack.length - 1) {
        index = stack.length - 1;
      }
      activeTabId = stack[index]!.tabId;
      syncCurrent();
    },
    peek(delta) {
      const target = index + delta;
      if (target < 0 || target >= stack.length) {
        return null;
      }
      return stack[target]!.location;
    },
    peekViewport(delta) {
      const target = index + delta;
      if (target < 0 || target >= stack.length) {
        return null;
      }
      return stack[target]!.viewport;
    },
    peekTabId(delta) {
      const target = index + delta;
      if (target < 0 || target >= stack.length) {
        return null;
      }
      return stack[target]!.tabId;
    },
  };

  return history;
}

/**
 * Browse scope under a tab's open viewer. The shared timeline can have another
 * tab's folder immediately before the current preview, so peek(-1) is not
 * the folder that belongs to this tab.
 */
export function browseLocationUnderPreview(
  history: WorkspaceNavHistory,
  tabId: string,
): WorkspaceNavLocation {
  return browseEntryUnderPreview(history, tabId).location;
}

export function browseEntryUnderPreview(
  history: WorkspaceNavHistory,
  tabId: string,
): { location: WorkspaceNavLocation; viewport: WorkspaceNavViewport } {
  for (let delta = -1; ; delta -= 1) {
    const owner = history.peekTabId(delta);
    if (owner === null) {
      return { location: { kind: "all" }, viewport: { ...DEFAULT_VIEWPORT } };
    }
    if (owner !== tabId) continue;
    const location = history.peek(delta);
    const viewport = history.peekViewport(delta);
    if (!location) {
      return { location: { kind: "all" }, viewport: { ...DEFAULT_VIEWPORT } };
    }
    if (location.kind !== "preview") {
      return {
        location,
        viewport: viewport ?? { ...DEFAULT_VIEWPORT },
      };
    }
  }
}
