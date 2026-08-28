# @deepseek-ai/dsh-client-ui-browser

English | [中文](README.zh.md)

Conversation browser view for the desktop product. It registers a `browser` conversation seat, routes HTTP(S) and workspace-local page links to the Host, and controls conversation-owned tabs through the `/worldline-browser` endpoint.

Opening a routed link from Settings or another feature page returns to the current conversation page before selecting its Browser tab. Native Electron content therefore never renders over an unrelated application page.

The component reports serialized visible bounds so Electron can place the native view without stale resize updates, polls the Host snapshot for titles, history state, and tab changes, and renders a bounded live raster preview of the same native tab when the client cannot receive Electron's overlay. Pointer, wheel, and keyboard input on that preview is normalized and forwarded to Chromium, so arbitrary sites remain visible and interactive without relying on `iframe` permission. Closing the final tab leaves an explicit empty browser.

## Model Experience

### User browser view

#### What the model sees

Nothing: `BrowserSnapshot` values, addresses, and user navigation actions remain product UI state.

#### Token effect

Opening or navigating tabs adds no Agent prompt, tool schema, or tool-result tokens.

#### KV Cache effect

User browser state is independent of model requests and does not change reusable prefixes.

## Known Limitations and Deferred Work

- **Desktop bridge required** — ordinary Web deployments can render the unavailable state but cannot host native browser tabs.
- **Polling snapshot** — tab metadata refreshes once per second, so title and history controls can briefly lag behind the native page.
- **Raster fallback** — clients outside the owning Electron window receive compressed live frames instead of a second DOM; accessibility trees, native text selection, and high-frame-rate video remain available only through the native view.
