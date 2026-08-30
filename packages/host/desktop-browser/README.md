# @deepseek-ai/dsh-host-desktop-browser

English | [中文](README.zh.md)

Desktop-only Host adapter for conversation-owned Electron browser tabs. It validates the loopback bridge environment, exposes user browser actions through `host-webserver`, publishes the low-level `electronViewHost`, and provides the first-party `ctx.browserController` CDP automation seam. The same route serves bounded JPEG compositor frames and forwards normalized preview input for Worldline clients that cannot host Electron's native overlay. Native views remain alive when the user changes conversation or application page, while an eight-conversation least-recently-used cache and a twelve-tab per-conversation limit bound memory use. Page-requested HTML fullscreen uses the complete Electron content area and returns to the reported center-column bounds on exit.

Workspace-local pages use opaque route tokens and realpath containment. Only HTML entry files below the selected workspace can be opened, and every referenced resource is rechecked against the same canonical root before delivery.

The CDP action vocabulary and diagnostics design were adapted from the MIT-licensed Master Cat browser automation implementation; see [MASTER_CAT_NOTICE.md](MASTER_CAT_NOTICE.md).

## Model Experience

### User-owned native tabs

#### What the model sees

Without `@deepseek-ai/dsh-tool-browser`, nothing. With that desktop Agent plugin, the model receives the bounded `browser_control` contract and acts on the same Session-owned native tabs shown to the user.

#### Token effect

User navigation and native view lifecycle add no tokens to Agent requests.

#### KV Cache effect

Product browser state is independent of model prefixes and cannot invalidate an existing cache entry.

## Known Limitations and Deferred Work

- **Desktop process lifetime** — conversation tabs are retained across in-app navigation but are destroyed when the Host plugin is disposed; they are not restored after an application restart. After eight conversations have browser state, opening a ninth evicts the least recently used conversation.
- **Restricted local entry points** — only workspace-contained HTML, HTM, or XHTML files can become local pages; arbitrary local files and non-HTTP remote schemes are rejected.
