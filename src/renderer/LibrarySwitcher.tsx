import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ImportMenuCopy } from "./browse-empty-state";
import { iconActionAttrs } from "./icon-action-attrs";
import { useLocale } from "./i18n";
import { isImeKeyboardEvent } from "./ime-safe-dismiss";
import {
  focusFirstRovingItem,
  handleRovingListKeyDown,
} from "./roving-list-keyboard";
import { Icon } from "./Icons";
import { Tooltip } from "./ui/primitives/Tooltip";
import { PortaledPopover } from "./PortaledPopover";
import { MenuSurface, resolveMenuNodes } from "./ui/patterns";

const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';
const LIBRARY_MENU_SURFACE_NODES = resolveMenuNodes([
  { id: "library-menu-content", kind: "separator" as const },
]);

export type RecentLibraryMenuEntry = {
  path: string;
  name: string;
};

/**
 * The other-libraries menu section lists every known recent library except the
 * one currently open (identified by absolute path, so same-named libraries still
 * distinguish correctly). Store order (most recent first) is preserved.
 */
export function buildRecentLibraryMenuEntries(
  entries: RecentLibraryMenuEntry[],
  currentLibraryPath: string | null,
): RecentLibraryMenuEntry[] {
  return entries.filter((entry) => entry.path !== currentLibraryPath);
}

export type LibrarySwitcherProps = {
  libraryName: string | null;
  disabled?: boolean;
  onCreateLibrary: () => void;
  /** Opens the open-library chooser (existing WorldlineBox + third-party + sync). */
  onOpenLibrary: () => void;
  /** @deprecated Kept for callers while the library menu is consolidated. */
  onCloseLibrary: () => void;
  /** Soft remove: close + drop from recents; disk untouched (WorldlineBox-ucx). */
  onRemoveLibrary?: () => void;
  /** Irreversible delete of the currently open library root (WorldlineBox-9i8). */
  onDeleteLibraryFromDisk?: () => void;
  onOpenLibrarySettings?: () => void;
  /** Recent libraries excluding the open one; the section hides when empty. */
  recentLibraries?: RecentLibraryMenuEntry[];
  onOpenRecent?: (path: string) => void;
  /** Soft-forget a recent entry without opening it. */
  onForgetRecent?: (path: string) => void;
  /** Called when the menu opens so the owner can refresh recentLibraries. */
  onMenuOpen?: () => void;
  /** True when a library is open (gates library-scoped transfer actions). */
  libraryOpen?: boolean;
  /**
   * Portal the menu to document.body. Required in the app toolbar: the toolbar
   * is its own stacking context at `--ui-layer-shell`, so an in-place menu ties
   * with the fixed pane resizers and hovering the menu where it crosses the
   * pane divider starts a pane drag instead of clicking the item (the menu did
   * paint above them — which is why it looked right — but the resizer still won
   * the pointer). The sidebar placement keeps the in-place menu.
   */
  portaled?: boolean;
  /** 同步连接状态（WorldlineBox-ae7257 后续）：link / link-off 图标提示。 */
  syncStatus?: "none" | "disabled" | "enabled";
  busy?: boolean;
  /** @deprecated Asset-level imports now live in the File menu. */
  importMenuCopy?: ImportMenuCopy;
  onImportFolder?: () => void;
  onImportLinkedFolder?: () => void;
  onExportLibrary?: () => void;
  /** Opens the import-library chooser (folder/ZIP + third-party). */
  onImportLibrary?: () => void;
};

/**
 * Top-left library control: current library name with create/open/close menu.
 * Replaces the brand glyph + static label.
 */
export function LibrarySwitcher({
  libraryName,
  disabled = false,
  onCreateLibrary,
  onOpenLibrary,
  onCloseLibrary,
  onRemoveLibrary,
  onDeleteLibraryFromDisk,
  onOpenLibrarySettings,
  recentLibraries = [],
  onOpenRecent,
  onForgetRecent,
  onMenuOpen,
  libraryOpen = false,
  portaled = false,
  syncStatus = "none",
  busy = false,
  onImportLibrary,
  onExportLibrary,
}: LibrarySwitcherProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const label = libraryName ?? t("shell.chooseLibrary");

  function closeMenu(restoreTriggerFocus: boolean) {
    setOpen(false);
    setKeyboardNav(false);
    if (restoreTriggerFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (rootRef.current?.contains(target as Node)) return;
      // The portaled menu lives on document.body, outside rootRef; without
      // this, clicking any menu item would read as an outside click and close
      // the menu before the action runs.
      if (
        target instanceof Element &&
        target.closest('[data-library-switcher-menu="portaled"]') !== null
      ) {
        return;
      }
      closeMenu(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    const raf = requestAnimationFrame(() => {
      const menu = document.getElementById(menuId);
      if (menu instanceof HTMLDivElement) {
        focusFirstRovingItem(menu, MENU_ITEM_SELECTOR);
      }
    });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      cancelAnimationFrame(raf);
    };
  }, [menuId, open]);

  function runMenuAction(handler: () => void) {
    closeMenu(true);
    handler();
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (isImeKeyboardEvent(event.nativeEvent)) return;
    const menu = event.currentTarget;
    const result = handleRovingListKeyDown({
      key: event.key,
      container: menu,
      itemSelector: MENU_ITEM_SELECTOR,
    });
    if (!result.handled) return;
    event.preventDefault();
    event.stopPropagation();
    if (result.action === "escape") {
      closeMenu(true);
      return;
    }
    setKeyboardNav(true);
  }

  // One source of truth for the menu items. The in-place MenuSurface is

  // used when the switcher sits in the sidebar; the portalled surface is

  // required in the app toolbar, whose own stacking context would otherwise

  // hand the pointer to the fixed pane resizers and start a pane drag.

  const menuItems = (
    <>
        <button
          className="library-switcher-item"
          onClick={() => runMenuAction(onCreateLibrary)}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {t("shell.createLibraryEllipsis")}
        </button>
        <button
          className="library-switcher-item"
          onClick={() => runMenuAction(onOpenLibrary)}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {t("shell.openLibraryEllipsis")}
        </button>
        <button
          className="library-switcher-item"
          disabled={!libraryName}
          onClick={() => runMenuAction(onCloseLibrary)}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {t("shell.closeLibrary")}
        </button>
        <button
          className="library-switcher-item"
          data-hover-tip={t("toolbar.importLibraryHint")}
          disabled={!onImportLibrary || !libraryOpen || busy}
          onClick={() => {
            if (onImportLibrary) runMenuAction(onImportLibrary);
          }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {t("toolbar.importLibrary")}
        </button>
        <button
          className="library-switcher-item"
          disabled={!onExportLibrary || !libraryOpen || busy}
          onClick={() => {
            if (onExportLibrary) runMenuAction(onExportLibrary);
          }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {t("toolbar.exportLibrary")}
        </button>
        <button
          className="library-switcher-item"
          disabled={!libraryName || !onRemoveLibrary}
          onClick={() => {
            if (onRemoveLibrary) runMenuAction(onRemoveLibrary);
          }}
          role="menuitem"
          tabIndex={-1}
          data-hover-tip={t("shell.removeLibraryHint")}
          type="button"
        >
          {t("shell.removeLibrary")}
        </button>
        <button
          className="library-switcher-item is-danger"
          disabled={!libraryName || !onDeleteLibraryFromDisk}
          onClick={() => {
            if (onDeleteLibraryFromDisk) runMenuAction(onDeleteLibraryFromDisk);
          }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {t("shell.deleteLibraryFromDisk")}
        </button>
        <button
          className="library-switcher-item"
          disabled={!libraryName || busy || !onOpenLibrarySettings}
          onClick={() => {
            if (onOpenLibrarySettings) runMenuAction(onOpenLibrarySettings);
          }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {t("settings.librarySettings")}
        </button>
        {recentLibraries.length > 0 && (
          <>
            <div aria-hidden="true" className="library-switcher-divider" />
            <div
              aria-label={t("shell.otherLibraries")}
              className="library-switcher-section"
              role="group"
            >
              <div className="library-switcher-section-label">
                {t("shell.otherLibraries")}
              </div>
              {recentLibraries.map((entry) => (
                <div className="library-switcher-recent-row" key={entry.path}>
                  {/* WorldlineBox-s0oq: hovering a recent library reveals its full
                      path via the standard document-level hover tip (420ms,
                      themed) — no inline path line. */}
                  <Tooltip label={entry.path}>
                    <button
                      className="library-switcher-item library-switcher-recent-open"
                      onClick={() => {
                        closeMenu(true);
                        onOpenRecent?.(entry.path);
                      }}
                      role="menuitem"
                      tabIndex={-1}
                      type="button"
                    >
                      <span className="library-switcher-item-label">
                        {entry.name}
                      </span>
                    </button>
                  </Tooltip>
                  {onForgetRecent != null && (
                    <button
                      className="library-switcher-recent-forget"
                      onClick={(event) => {
                        event.stopPropagation();
                        onForgetRecent(entry.path);
                      }}
                      tabIndex={-1}

                      type="button"
                      {...iconActionAttrs(t("shell.forgetRecentLibrary"))}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
    </>

  );

  return (
    <div className="library-switcher" ref={rootRef}>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          libraryName
            ? t("shell.currentLibrary", { name: libraryName })
            : t("shell.libraryMenu")
        }
        className="library-switcher-trigger"
        disabled={disabled}
        onClick={() => {
          if (open) {
            closeMenu(true);
            return;
          }
          onMenuOpen?.();
          setOpen(true);
        }}
        ref={triggerRef}
        data-hover-tip={
          libraryName
            ? t("shell.libraryNamed", { name: libraryName })
            : t("shell.noLibraryOpen")
        }
        type="button"
      >
        <span className="library-switcher-name">{label}</span>
        {/* Selector affordance: the row opens the library menu. */}
        <Icon name="chevrons-up-down" size={13} />
        {syncStatus !== "none" ? (
          <span
            className="library-switcher-sync-status"
            data-state={syncStatus}
            data-hover-tip={
              syncStatus === "enabled"
                ? t("shell.syncConnected")
                : t("shell.syncDisconnected")
            }
          >
            <Icon name={syncStatus === "enabled" ? "link" : "link-off"} size={12} />
          </span>
        ) : null}
      </button>
      {open && (portaled ? (
        <PortaledPopover
          anchorRef={triggerRef}
          data-library-switcher-menu="portaled"
          className={`library-switcher-menu${keyboardNav ? " is-keyboard-navigation" : ""}`}
          id={menuId}
          onKeyDown={onMenuKeyDown}
          onPointerMove={() => setKeyboardNav(false)}
          role="menu"
        >
          {menuItems}
        </PortaledPopover>
      ) : (
        <MenuSurface
          className={`library-switcher-menu${keyboardNav ? " is-keyboard-navigation" : ""}`}
          id={menuId}
          nodes={LIBRARY_MENU_SURFACE_NODES}
          onKeyDown={onMenuKeyDown}
          onPointerMove={() => setKeyboardNav(false)}
          renderNode={() => menuItems}
        />
      ))}
    </div>
  );
}
