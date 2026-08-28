import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'

/** Model-independent operations supported by a conversation-owned browser. */
export type BrowserAction =
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

/** One browser operation. Conversation ownership is supplied separately. */
export interface BrowserCommand {
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

/** Browser-safe state for one conversation-owned native tab. */
export interface BrowserTabSnapshot {
  id: string
  url: string
  title?: string
  active: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  devToolsOpen: boolean
}

/** One bounded model-independent browser operation result. */
export interface BrowserCommandResult {
  action: BrowserAction
  tabId?: string
  data?: JsonValue
  tabs: BrowserTabSnapshot[]
}

/** Trusted execution facts supplied by a browser consumer. */
export interface BrowserExecutionOptions {
  /** Trusted workspace root used to contain screenshot writes. */
  workspaceRoot?: string
  /** Cancellation for polling and multi-command operations. */
  signal?: AbortSignal
}

/** Host capability for controlling the native browser owned by one Session. */
export interface BrowserController {
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
