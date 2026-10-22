# Built-in browser

The Browser module provides its own Chromium browsing session. Its native start page offers web search, AI research, Markdown fetching and browsing without loading external sites on startup. Bookmarks stay in the toolbar and management panel, without duplicating cards below the start-page search. Tabs and pages stay available when you switch to Launcher, Companions, or Assets.

## Tabs, bookmarks, and downloads

The browser supports navigation, search, multiple tabs, restoring closed tabs, pinning, muting, zoom, and find in page. HTTP/HTTPS pages opened by links, scripts, or forms become tabs while keeping the browsing session, opener relationship, and submitted content. Background tabs keep the current page selected. The bookmark bar and side panel support folders, search, editing, and removal.

History supports search and 50 records per page, with matching counts and page numbers. Downloads show 20 records per page and support filename, URL, error, or status search and a status filter. Byte progress and pause, resume, cancel, retry, open, and reveal actions remain available. Clearing records adjusts the page automatically.

Cookies and site storage use a dedicated persistent session. Switching modules does not clear sign-ins; websites may still expire their own sessions. Browser settings can clear cache, cookies/site data, history, or download records for the current site or all sites. Clearing download records keeps the files and active downloads.

Common shortcuts: Ctrl+L for the address bar, Ctrl+T for a new tab, Ctrl+W to close, Ctrl+Shift+T to restore, Ctrl+Tab to switch, Ctrl+F to find, Ctrl+R to reload, and Ctrl+plus/minus/0 to zoom. Esc exits website fullscreen; F11 toggles window fullscreen.

The tab audio button independently mutes/unmutes its native audio output, including background tabs. Right-click any tab for mute, duplicate, pin, reload, close others/right, and restore. Batch closing retains pinned tabs. Muting survives reload and session restoration. Middle-click closes tabs; Ctrl+M toggles audio, Ctrl+1–8 selects a tab, Ctrl+9 selects the last, and Ctrl+PageUp/PageDown switches. Ctrl+S saves MHTML through a native dialog; Ctrl+P opens the native print dialog.

## Native AI search and browser conversation

Browser Settings has a dedicated, OS-encrypted DeepSeek Search/Fetch key independent of the global model. Without a browser key, only an official DeepSeek global endpoint/key can supply search credentials. Test or remove the dedicated key without changing global model settings. Search/fetch use the [official DeepSeek tool APIs](https://api-docs.deepseek.com/guides/search/); planning, conversation and analysis use the configured global model.

Use **Web search** for structured results without a chat model, **Fetch & read** for public-page Markdown, **AI research** for native model/tool rounds, or **Browse** for normal browsing. Search supports `site:`, `OR`, `-site:`, excluded terms/phrases, exact quotes, `lang:`, `after:` and `before:` within 128 Unicode characters. Remote fetch does not receive browser cookies; local/private and credential-bearing URLs are rejected. Analyze a signed-in page by explicitly asking the assistant to read the rendered page instead.

The AI toolbar button opens/closes the sidebar. Drag its divider or use the arrow keys to resize. The composer grows with text; Enter sends and Shift+Enter adds a line, with IME composition preserved. Answers support CommonMark, GFM tables/tasks/footnotes, math, highlighted copyable code and sanitized Mermaid. Diagrams render after streaming completes and retain source on errors. Links open through explicit clicks, and model images never fetch automatically.

Reference cards show the source title, site, excerpt and provenance: search result, fetched page or live browser read. Numbered citations open their exact source. Full source content renders only after clicking Read content. Tool steps use readable labels; raw arguments and responses remain inside collapsed technical details.

The dedicated tool set covers search/fetch/cached-source pagination, tabs/navigation, grounded page observation/read/click/hover/fill/select, keyboard/scroll/find, bookmarks/history, bounded download actions, zoom/fullscreen, native save/print dialogs and saving page screenshots to a writable asset library. It exposes no terminal, arbitrary JavaScript, cookies, browser keys, or arbitrary filesystem access. Actions that submit forms/messages or change sensitive state show a specific confirmation. Sensitive fields and CAPTCHA are handled directly by the user. A cross-origin embedded page can be opened by its public URL in another tab.

Chat, source bodies and tool records are temporary, kept only in memory and never written to a conversation database or session file. Closing the app clears them; New conversation clears them immediately. Only the encrypted key and preferences such as context budget and sidebar width persist. The 8,192–32,768 token budget includes instructions, tools, evidence and history, while reserving output capacity. Earlier history is compacted at complete call/result boundaries; source caches, messages and action records are bounded. Long pages use pagination. Each turn is limited to 18 model iterations, 28 executed tools and five minutes. Stopping preserves actions already performed. Search, fetch and model analysis run only on user requests.

## Website sign-in and the default browser

Embedded pages run in visible Chromium views, without headless mode. WorldlineBox keeps a dedicated persistent profile, separate from Chrome or Edge. A website may recognize this independent profile as a new device.

Google restricts sign-in in embedded browsers. Its account pages show an explanation and an **Open original site in default browser** action when the referring site is known. Otherwise, open the current page. **More → Open in default browser** is also available for HTTP/HTTPS pages. Opening an external browser requires clicking the action.

After signing in with the default browser, continue using the website there. Its cookies are not automatically transferred back to WorldlineBox. The embedded browser keeps its actual Chromium/Electron identity; device verification and account policies remain controlled by the website. See [Google's embedded sign-in guidance](https://developers.googleblog.com/en/guidance-to-developers-affected-by-our-effort-to-block-less-secure-browsers-and-applications/).

## Screen-tool startup

Screenshot and recording tools appear after their selection interface and captured desktop image are ready. Recording controls are also laid out before they become visible. Region recordings place controls outside the captured area; a full-display recording hides them when no outside area is available. Use the recording shortcut again to stop.

## Save to an asset library

Asset capture is built in; no extension installation is needed. Open a library in Assets, then click **Save to asset library** beside the browser's address bar.

1. Choose a destination library and default save folder. Library root, regular folders, and available linked folders are supported. Unavailable folders cannot be selected. Browse the folder tree, search paths, or use recently used folders.
2. Right-click a web image or video, choose **Save to WorldlineBox**, then choose the root or a folder in the native menu. The context and drag menus can choose another folder for that save.
3. Drag an image or video to open the original folder save menu, with recent folders and the library root. Hover over `›` to enter a folder's children, use `‹` to go back, and release on a destination to save. Release outside the menu or press Esc to cancel.
4. Use **Capture a local image** to select a file in the system picker and save it to the default destination. Websites do not receive the local absolute path.

Four preferences are remembered and enabled by default: show system notifications, focus WorldlineBox after saving, reveal saved items in the asset manager, and show the folder menu when dragging media. Revealing a saved item opens its destination library and selects the asset while keeping browser tabs and pages available. **Open asset manager** is also available in the panel.

Recent captures show results, byte progress, and specific errors. A save that is still running can be cancelled. Imports use the same content deduplication as local imports. Open a writable library before capturing media.

Web capture is enabled on HTTP/HTTPS pages. Blank tabs, embedded blank documents, and browser error pages do not initialize capture. If a page closes or navigates during a request, wait for the page to finish loading and try again. Local images continue to use the system picker.

Capture downloads HTTP/HTTPS images and videos with the current browser session's cookies and the page Referer. The website still controls access. Each remote item is limited to **500 MiB**, and local images to **32 MiB**. `blob:` / `data:` URLs, segmented HLS/DASH streams, MSE, and DRM media are unsupported; videos need a directly downloadable media URL. Capture supports individual context-menu, drag, and local-picker saves. It does not add page scanning, batch capture, or an extension popup.

External Chrome/Edge browsers still need a separately installed [browser extension](browser-extension.en.md).

## Network and scope

Choose **Global network** in the far-left application sidebar, or follow the link from Browser settings. This page works independently of the launcher. The proxy covers the browser, companions and models, asset AI and semantic services, sync, plugins, music, updates, downloads, and app-managed commands. Site content is not rewritten to package mirror URLs. The browser and DSH workbench have separate persistent sessions.

The proxy switch in **Currently applied** immediately selects a direct connection when turned off. Turning it back on restores the previous system or custom proxy configuration. Quick choices include local HTTP/mixed ports **7897, 7890, 7896, 7898, 10809, and 8080**; choose the port actually used by your proxy application. These choices do not start a proxy service. Unrelated unsaved edits remain drafts.

**Switch applied proxy mode** offers **Smart proxy (this app)**, **Global proxy (this app)**, system and direct modes. Existing custom proxy settings retain global behavior. Smart mode connects local networks and common Chinese sites directly, while unknown public domains use the selected proxy. When applied, it probes both direct and proxy HTTPS routes for the exact hosts `s.pximg.net` and `i.pximg.net`, preferring the proxy and selecting direct only if proxy fails and direct succeeds. The probe takes up to about five seconds. Current direct CDN routes are displayed; **Recheck smart routes** repeats the probes after a node change. Other source changes reuse the result.

Global mode sends all public requests to the selected proxy without automatic direct CDN fallback. Both modes cover browser sessions, Node requests, background Workers and managed commands. They do not change Windows or Clash modes; upstream rules and the selected node still determine whether a resource is reachable.

**Pixiv connection check** separately checks the public page, sign-in page, actual referenced CSS and JS, a public artwork API, its image and the CAPTCHA script, showing routes, statuses, bytes and failures. Resource checks read bounded prefixes; they do not establish complete downloads or script execution. The check does not sign in, bookmark, follow, post or purchase. Authenticated features, R-18, animation playback and site restrictions require separate verification with a working node and authorized account.

npm presets include the official registry, npmmirror, and Huawei Cloud. Python presets include PyPI, TUNA, USTC, Aliyun, and Huawei Cloud; custom sources are also supported. Choosing a preset applies that source immediately. An explicitly selected npm source uses the selected registry. Source changes preserve unrelated drafts, and do not promise a fixed download speed. Proxy changes also affect new requests from running app-managed commands; existing connections are closed and failed requests need a retry. Local loopback services remain direct. An exported CLI launched outside the app reads saved settings at its next invocation. Mirror changes apply to later downloads and new commands; cancel and retry an active installation to change its source.

**Recent network failures** groups HTTP failures by site origin, error code and resource type. It keeps up to 40 groups for the current session, with search, 10 groups per page and a clear action. URL paths, query parameters and credentials are not stored. Main-page and subresource failures are distinguished. `net_error -100` means the connection closed; when accompanied by a TLS handshake failure, check the proxy port and rules before retrying. Low-level preconnections and WebRTC messages may not correspond to an HTTP failure in this list.

Failed pages explain DNS, connection, offline, timeout, TLS, or proxy errors and offer **Reload** and **Global network settings**. Expand technical details to see the underlying error code. Check the connection or proxy before retrying; changing these settings does not bypass certificate validation. Website player errors and individual failed subresources can still depend on the site and current network.

The browser supports up to 50 retained tabs and 8 active pages. Older idle pages can sleep and reload when selected. Chrome extension-store installation, password management, and cross-device account sync are not included.
