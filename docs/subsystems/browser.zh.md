# 浏览器自动化

[English](browser.md) | 中文

浏览器自动化 seam 操控一个 Session 自有的原生标签页。Service Definition 是 [`@deepseek-ai/dsh-browser`](../../packages/browser/browser/README.md)，桌面 Provider 是 [`@deepseek-ai/dsh-host-desktop-browser`](../../packages/host/desktop-browser/README.md)，模型侧 Consumer 是 [`@deepseek-ai/dsh-tool-browser`](../../packages/browser/tool-browser/README.md)。Provider 复用 Worldline“浏览器”面板中用户可见的标签页，而不会创建第二个隐藏浏览器。Electron 所有者渲染器以外的客户端显示同一标签页的有界合成帧并转发归一化输入，从而绕过跨域 `iframe` 限制，又不拆分用户与 Agent 状态。

Session 身份和工作区根目录是可信执行事实，不是模型参数。命令和结果只包含 JSON 安全数据；Electron 对象与 CDP 传输留在 Provider 内部。截图只能通过新建的相对路径写到 Session 工作区内；原始 CDP 下载路径命令会被拒绝，因为它们可能绕过这个边界。

## 动作与命令

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

高级动作覆盖标签页生命周期、导航、语义快照、页面文本/HTML、截图、鼠标/键盘/表单交互、等待、控制台/网络诊断与 DevTools。`evaluate` 和 `cdp` 只在高级动作无法表达任务时兜底；是否公开它们由 Consumer 策略决定。

## 结果与可信执行

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
