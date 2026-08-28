# Browser Automation

English | [中文](browser.zh.md)

The browser automation seam controls native tabs owned by one Session. The Service Definition is [`@deepseek-ai/dsh-browser`](../../packages/browser/browser/README.md), the desktop Provider is [`@deepseek-ai/dsh-host-desktop-browser`](../../packages/host/desktop-browser/README.md), and the model-facing Consumer is [`@deepseek-ai/dsh-tool-browser`](../../packages/browser/tool-browser/README.md). The Provider reuses the tabs visible in Worldline's Browser pane instead of creating a second hidden browser. Clients outside the owning Electron renderer display bounded compositor frames of that same tab and forward normalized input, avoiding cross-origin `iframe` restrictions without splitting user and Agent state.

Session identity and workspace root are trusted execution facts, not model arguments. Commands and results contain only JSON-safe data; Electron objects and CDP transports stay inside the Provider. Screenshots use new relative paths below the Session workspace, while raw CDP download-path commands are rejected because they can bypass that boundary.

## Actions and commands

```ts type-equiv
/** Model-independent operations supported by a conversation-owned browser. */
type BrowserAction =
  | 'list'
  | 'open'
  | 'focus'
  | 'close'
  | 'state'
  | 'navigate'
  | 'reload'
  | 'back'
  | 'forward'
  | 'stop'
  | 'snapshot'
  | 'html'
  | 'text'
  | 'screenshot'
  | 'evaluate'
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'wait_for_selector'
  | 'wait_for_load'
  | 'console'
  | 'network'
  | 'clear_logs'
  | 'devtools'
  | 'cdp'
```

```ts type-equiv
/** One browser operation. Conversation ownership is supplied separately. */
interface BrowserCommand {
  action: BrowserAction
  tabId?: string
  url?: string
  title?: string
  timeoutMs?: number
  selector?: string
  text?: string
  value?: string
  key?: string
  x?: number
  y?: number
  width?: number
  height?: number
  maxTextLength?: number
  maxElements?: number
  maxEntries?: number
  savePath?: string
  returnBase64?: boolean
  expression?: string
  method?: string
  params?: Record<string, JsonValue>
  open?: boolean
}
```

High-level actions cover tab lifecycle, navigation, semantic snapshots, page text/HTML, screenshots, mouse/keyboard/form interaction, waits, console/network diagnostics, and DevTools. `evaluate` and `cdp` are escape hatches when a high-level action cannot express a task; Consumer policy decides whether to expose them.

## Results and trusted execution

```ts type-equiv
/** Browser-safe state for one conversation-owned native tab. */
interface BrowserTabSnapshot {
  id: string
  url: string
  title?: string
  active: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  devToolsOpen: boolean
}
```

```ts type-equiv
/** One bounded model-independent browser operation result. */
interface BrowserCommandResult {
  action: BrowserAction
  tabId?: string
  data?: JsonValue
  tabs: BrowserTabSnapshot[]
}
```

```ts type-equiv
/** Trusted execution facts supplied by a browser consumer. */
interface BrowserExecutionOptions {
  /** Trusted workspace root used to contain screenshot writes. */
  workspaceRoot?: string
  /** Cancellation for polling and multi-command operations. */
  signal?: AbortSignal
}
```

```ts type-equiv
/** Host capability for controlling the native browser owned by one Session. */
interface BrowserController {
  /**
   * Execute one bounded browser operation inside the calling Session's tab namespace.
   * @param sessionId - trusted Session identity; never accepted from model arguments.
   * @param command - normalized operation selected by a Consumer.
   * @param options - trusted workspace containment and cooperative cancellation facts.
   * @returns JSON-safe operation data plus the Session's current native tab snapshots.
   */
  execute(
    sessionId: SessionId,
    command: BrowserCommand,
    options?: BrowserExecutionOptions,
  ): Promise<BrowserCommandResult>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowsercontroller--browsercontroller"></a>

### `ctx.browserController` — `BrowserController`

Host capability for controlling the native browser owned by one Session.

```ts cordis-catalog
/**
 * Execute one bounded browser operation inside the calling Session's tab namespace.
 * @param sessionId - trusted Session identity; never accepted from model arguments.
 * @param command - normalized operation selected by a Consumer.
 * @param options - trusted workspace containment and cooperative cancellation facts.
 * @returns JSON-safe operation data plus the Session's current native tab snapshots.
 */
execute( sessionId: SessionId, command: BrowserCommand, options?: BrowserExecutionOptions, ): Promise<BrowserCommandResult>
```

Types: [SessionId](core.md)

Source: [`packages/browser/browser/src/types.ts:88`](../../packages/browser/browser/src/types.ts)
<!-- END GENERATED cordis-surface -->
