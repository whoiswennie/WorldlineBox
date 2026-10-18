# Built-in browser

The Browser module provides its own Chromium browsing session. It opens a blank home page and creates the web process when first used. Tabs and pages stay available when you switch to Launcher, Companions, or Assets.

## Tabs, bookmarks, and downloads

The browser supports navigation, search, multiple tabs, restoring closed tabs, pinning, muting, zoom, and find in page. The bookmark bar and side panel support folders, search, editing, and removal. History is searchable. Downloads show byte progress and support pause, resume, cancel, retry, opening, and revealing the file.

Cookies and site storage use a dedicated persistent session. Switching modules does not clear sign-ins; websites may still expire their own sessions. Browser settings can clear cache, cookies/site data, history, or download records for the current site or all sites. Clearing download records keeps the files and active downloads.

Common shortcuts: Ctrl+L for the address bar, Ctrl+T for a new tab, Ctrl+W to close, Ctrl+Shift+T to restore, Ctrl+Tab to switch, Ctrl+F to find, Ctrl+R to reload, and Ctrl+plus/minus/0 to zoom. Esc exits website fullscreen; F11 toggles window fullscreen.

## Save to an asset library

Asset capture is built in; no extension installation is needed. Open a library in Assets, then click **Save to asset library** beside the browser's address bar.

1. Choose a destination library and default save folder. Library root, regular folders, and available linked folders are supported. Unavailable folders cannot be selected. Browse the folder tree, search paths, or use recently used folders.
2. Right-click a web image or video, choose **Save to WorldlineBox**, then choose the root or a folder in the native menu. The context and drag menus can choose another folder for that save.
3. Drag an image or video to open the original folder save menu, with recent folders and the library root. Hover over `›` to enter a folder's children, use `‹` to go back, and release on a destination to save. Release outside the menu or press Esc to cancel.
4. Use **Capture a local image** to select a file in the system picker and save it to the default destination. Websites do not receive the local absolute path.

Four preferences are remembered and enabled by default: show system notifications, focus WorldlineBox after saving, reveal saved items in the asset manager, and show the folder menu when dragging media. Revealing a saved item opens its destination library and selects the asset while keeping browser tabs and pages available. **Open asset manager** is also available in the panel.

Recent captures show results, byte progress, and specific errors. A save that is still running can be cancelled. Imports use the same content deduplication as local imports. Open a writable library before capturing media.

Capture downloads HTTP/HTTPS images and videos with the current browser session's cookies and the page Referer. The website still controls access. Each remote item is limited to **500 MiB**, and local images to **32 MiB**. `blob:` / `data:` URLs, segmented HLS/DASH streams, MSE, and DRM media are unsupported; videos need a directly downloadable media URL. Capture supports individual context-menu, drag, and local-picker saves. It does not add page scanning, batch capture, or an extension popup.

External Chrome/Edge browsers still need a separately installed [browser extension](browser-extension.en.md).

## Network and scope

Browser settings link to the application's global network settings for proxies and package/source mirrors. Changes apply to new requests; site content is not rewritten to package mirror URLs. The browser and DSH workbench have separate persistent sessions.

The browser supports up to 50 retained tabs and 8 active pages. Older idle pages can sleep and reload when selected. Chrome extension-store installation, password management, and cross-device account sync are not included.
