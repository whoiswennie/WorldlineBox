import { randomUUID } from 'node:crypto'

/** Opaque native Electron view plus its command channel. */
export interface ElectronViewHandle {
  readonly id: string
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>
  drainEvents(): Promise<ElectronViewEvent[]>
  setDevTools(open?: boolean): Promise<boolean>
  capturePreview(maxWidth: number, maxHeight: number): Promise<BrowserPreviewFrame>
}

/** Latest compressed compositor frame for a native browser view. */
export interface BrowserPreviewFrame {
  mimeType: 'image/jpeg' | 'image/png'
  data: string
  sequence: number
}

/** One bounded CDP event forwarded from the Electron main process. */
export interface ElectronViewEvent {
  method: string
  params: Record<string, unknown>
  timestamp: number
}

/** Desktop main-process bridge that owns native browser views. */
export interface ElectronBrowserViewHost {
  createView(): ElectronViewHandle
  destroyView(handle: ElectronViewHandle): void
  showView?(handle: ElectronViewHandle): void
  hideView?(): void
}

/** Browser-safe projection of one conversation-owned desktop tab. */
export interface UserBrowserTab {
  id: string
  url: string
  /** Latest non-empty page title observed for the tab; absent until one is available. */
  title?: string
  active: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** Package-private automation handle for one owned tab. */
export interface UserBrowserAutomationTarget {
  id: string
  url: string
  title?: string
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>
  drainEvents(): Promise<ElectronViewEvent[]>
  setDevTools(open?: boolean): Promise<boolean>
}

/** Pointer input normalized to the visible browser viewport. */
export interface BrowserPointerInput {
  kind: 'move' | 'down' | 'up' | 'wheel'
  x: number
  y: number
  button?: 'left' | 'middle' | 'right' | 'none'
  clickCount?: number
  deltaX?: number
  deltaY?: number
  modifiers?: number
}

interface NavigationEntry {
  id: number
  url: string
  title?: string
}

interface NavigationHistory {
  currentIndex: number
  entries: NavigationEntry[]
}

interface OwnedTab {
  id: string
  url: string
  title?: string
  handle: ElectronViewHandle
  canGoBack: boolean
  canGoForward: boolean
  committedUrl: string
  pendingUrl?: string
}

interface OwnedSession {
  tabs: Map<string, OwnedTab>
  activeId?: string
  lastAccess: number
}

const HISTORY_TIMEOUT_MS = 2_000
const MAX_CACHED_SESSIONS = 8
const MAX_TABS_PER_SESSION = 12

function validUrl(url: string): boolean {
  return url === 'about:blank' || /^https?:\/\//iu.test(url)
}

function navigationHistory(value: Record<string, unknown>): NavigationHistory | undefined {
  if (!Number.isInteger(value.currentIndex) || !Array.isArray(value.entries)) return undefined
  const entries = value.entries.flatMap((entry): NavigationEntry[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const candidate = entry as { id?: unknown; url?: unknown; title?: unknown }
    return Number.isInteger(candidate.id) && typeof candidate.url === 'string'
      ? [{
        id: candidate.id as number,
        url: candidate.url,
        ...(typeof candidate.title === 'string' && candidate.title.trim() !== ''
          ? { title: candidate.title.trim() }
          : {}),
      }]
      : []
  })
  const currentIndex = value.currentIndex as number
  if (currentIndex < 0 || currentIndex >= entries.length) return undefined
  return { currentIndex, entries }
}

/** Per-conversation browser tabs owned by the desktop product, independent of Agent browser providers. */
export class UserBrowserRuntime {
  private readonly sessions = new Map<string, OwnedSession>()

  constructor(
    private readonly viewHost: ElectronBrowserViewHost,
    private readonly report: (error: unknown) => void = () => {},
  ) {}

  /**
   * List tabs for one conversation after refreshing active navigation state.
   * @param sessionId - conversation identity.
   * @returns tabs in stable insertion order.
   */
  async listTabs(sessionId: string): Promise<UserBrowserTab[]> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return []
    this.touch(session)
    const active = session.activeId === undefined ? undefined : session.tabs.get(session.activeId)
    if (active !== undefined) await this.refresh(active)
    return [...session.tabs.values()].map(tab => ({
      id: tab.id,
      url: tab.url,
      ...(tab.title === undefined ? {} : { title: tab.title }),
      active: tab.id === session.activeId,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    }))
  }

  /**
   * Open an HTTP(S) destination in the active or a new tab.
   * @param sessionId - conversation that owns the tab.
   * @param url - validated HTTP(S) destination or about:blank.
   * @param newTab - whether to create a tab instead of reusing the active one.
   */
  async openUrl(sessionId: string, url: string, newTab = false): Promise<string> {
    if (!validUrl(url)) throw new Error('内置浏览器只允许打开 HTTP(S) 网页。')
    const session = this.session(sessionId)
    let tab = session.activeId === undefined ? undefined : session.tabs.get(session.activeId)
    let created = false
    if (tab === undefined || newTab) {
      tab = await this.createTab(session, url)
      created = true
    } else {
      tab.url = url
      this.navigate(tab, url)
    }
    session.activeId = tab.id
    if (!created) this.viewHost.showView?.(tab.handle)
    return tab.id
  }

  /**
   * Select and reveal an existing conversation tab.
   * @param sessionId - conversation identity.
   * @param tabId - owned tab identity.
   */
  switchTab(sessionId: string, tabId: string): void {
    const session = this.requiredSession(sessionId)
    const tab = this.requiredTab(session, tabId)
    session.activeId = tab.id
    this.viewHost.showView?.(tab.handle)
  }

  /**
   * Destroy an owned tab and select its nearest neighbor.
   * @param sessionId - conversation identity.
   * @param tabId - owned tab identity.
   */
  closeTab(sessionId: string, tabId: string): void {
    const session = this.requiredSession(sessionId)
    const ids = [...session.tabs.keys()]
    const index = ids.indexOf(tabId)
    const tab = this.requiredTab(session, tabId)
    session.tabs.delete(tabId)
    this.viewHost.destroyView(tab.handle)
    if (session.activeId === tabId) {
      const nextId = ids[index + 1] ?? ids[index - 1]
      if (nextId !== undefined && session.tabs.has(nextId)) session.activeId = nextId
      else delete session.activeId
      const next = session.activeId === undefined ? undefined : session.tabs.get(session.activeId)
      if (next !== undefined) this.viewHost.showView?.(next.handle)
    }
    if (session.tabs.size === 0) this.sessions.delete(sessionId)
  }

  /** Restore one conversation's active native view without recreating its page. */
  activateSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    const active = session?.activeId === undefined ? undefined : session.tabs.get(session.activeId)
    if (session !== undefined) this.touch(session)
    if (active === undefined) this.viewHost.hideView?.()
    else this.viewHost.showView?.(active.handle)
  }

  /**
   * Move the active tab one entry backward when possible.
   * @param sessionId - conversation identity.
   */
  async back(sessionId: string, tabId?: string): Promise<void> {
    await this.moveHistory(sessionId, -1, tabId)
  }

  /**
   * Move the active tab one entry forward when possible.
   * @param sessionId - conversation identity.
   */
  async forward(sessionId: string, tabId?: string): Promise<void> {
    await this.moveHistory(sessionId, 1, tabId)
  }

  /**
   * Reload the active native tab.
   * @param sessionId - conversation identity.
   */
  async reload(sessionId: string, tabId?: string): Promise<void> {
    const tab = this.selectedTab(sessionId, tabId)
    await tab.handle.sendCommand('Page.reload')
  }

  /** Return a bounded live preview frame for the active tab. */
  async capturePreview(
    sessionId: string,
    maxWidth: number,
    maxHeight: number,
  ): Promise<BrowserPreviewFrame> {
    return await this.selectedTab(sessionId).handle.capturePreview(maxWidth, maxHeight)
  }

  /** Forward normalized pointer input from the raster preview into Chromium. */
  async dispatchPointer(sessionId: string, input: BrowserPointerInput): Promise<void> {
    const target = this.selectedTab(sessionId)
    const metrics = await target.handle.sendCommand('Page.getLayoutMetrics')
    const viewport = metrics.cssVisualViewport as { clientWidth?: unknown; clientHeight?: unknown } | undefined
    const width = typeof viewport?.clientWidth === 'number' && viewport.clientWidth > 0
      ? viewport.clientWidth
      : 1
    const height = typeof viewport?.clientHeight === 'number' && viewport.clientHeight > 0
      ? viewport.clientHeight
      : 1
    const x = Math.max(0, Math.min(1, input.x)) * width
    const y = Math.max(0, Math.min(1, input.y)) * height
    const type = input.kind === 'move' ? 'mouseMoved'
      : input.kind === 'down' ? 'mousePressed'
        : input.kind === 'up' ? 'mouseReleased'
          : 'mouseWheel'
    await target.handle.sendCommand('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: input.button ?? (input.kind === 'wheel' ? 'none' : 'left'),
      clickCount: input.clickCount ?? (input.kind === 'wheel' ? 0 : 1),
      deltaX: input.deltaX ?? 0,
      deltaY: input.deltaY ?? 0,
      modifiers: input.modifiers ?? 0,
    })
  }

  /** Forward text or a non-printable key into the active Chromium page. */
  async dispatchKeyboard(
    sessionId: string,
    input: { text?: string; key?: string; code?: string; modifiers?: number },
  ): Promise<void> {
    const target = this.selectedTab(sessionId)
    if (typeof input.text === 'string' && input.text !== '') {
      await target.handle.sendCommand('Input.insertText', { text: input.text })
      return
    }
    if (typeof input.key !== 'string' || input.key === '') throw new Error('browser key is required')
    const params = {
      key: input.key,
      code: input.code ?? input.key,
      modifiers: input.modifiers ?? 0,
    }
    await target.handle.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
    await target.handle.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }

  /** Stop loading the selected tab. */
  async stop(sessionId: string, tabId?: string): Promise<void> {
    const tab = this.selectedTab(sessionId, tabId)
    await tab.handle.sendCommand('Page.stopLoading')
  }

  /** Navigate the selected tab without creating another tab. */
  navigateTab(sessionId: string, url: string, tabId?: string): Promise<void> {
    if (!validUrl(url)) throw new Error('内置浏览器只允许打开 HTTP(S) 网页。')
    const tab = this.selectedTab(sessionId, tabId)
    tab.url = url
    this.navigate(tab, url)
    return Promise.resolve()
  }

  /** Refresh and return one selected tab's browser-safe state. */
  async tabState(sessionId: string, tabId?: string): Promise<UserBrowserTab> {
    const session = this.requiredSession(sessionId)
    const tab = tabId === undefined
      ? this.selectedTab(sessionId)
      : this.requiredTab(session, tabId)
    await this.refresh(tab)
    return {
      id: tab.id,
      url: tab.url,
      ...(tab.title === undefined ? {} : { title: tab.title }),
      active: tab.id === session.activeId,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    }
  }

  /** Resolve one selected tab to its package-private CDP channel. */
  automationTarget(sessionId: string, tabId?: string): UserBrowserAutomationTarget {
    const tab = this.selectedTab(sessionId, tabId)
    return {
      id: tab.id,
      url: tab.url,
      ...(tab.title === undefined ? {} : { title: tab.title }),
      sendCommand: (method, params, timeoutMs) => tab.handle.sendCommand(method, params, timeoutMs),
      drainEvents: () => tab.handle.drainEvents(),
      setDevTools: open => tab.handle.setDevTools(open),
    }
  }

  /** Destroy every native view and release all conversation tab state. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      for (const tab of session.tabs.values()) this.viewHost.destroyView(tab.handle)
    }
    this.sessions.clear()
  }

  private session(sessionId: string): OwnedSession {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      this.evictSessionIfNeeded()
      session = { tabs: new Map(), lastAccess: Date.now() }
      this.sessions.set(sessionId, session)
    } else this.touch(session)
    return session
  }

  private requiredSession(sessionId: string): OwnedSession {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('当前对话还没有浏览器页面。')
    this.touch(session)
    return session
  }

  private requiredTab(session: OwnedSession, tabId: string): OwnedTab {
    const tab = session.tabs.get(tabId)
    if (tab === undefined) throw new Error('浏览器页面不存在或已经关闭。')
    return tab
  }

  private activeTab(sessionId: string): OwnedTab {
    const session = this.requiredSession(sessionId)
    if (session.activeId === undefined) throw new Error('当前对话还没有活动的浏览器页面。')
    return this.requiredTab(session, session.activeId)
  }

  private selectedTab(sessionId: string, tabId?: string): OwnedTab {
    if (tabId === undefined) return this.activeTab(sessionId)
    return this.requiredTab(this.requiredSession(sessionId), tabId)
  }

  private async createTab(session: OwnedSession, url: string): Promise<OwnedTab> {
    if (session.tabs.size >= MAX_TABS_PER_SESSION) {
      throw new Error(`每个会话最多保留 ${String(MAX_TABS_PER_SESSION)} 个浏览器页面。`)
    }
    const handle = this.viewHost.createView()
    const tab: OwnedTab = {
      id: `tab:${randomUUID()}`,
      url,
      handle,
      canGoBack: false,
      canGoForward: false,
      committedUrl: 'about:blank',
    }
    session.tabs.set(tab.id, tab)
    try {
      // Request the native view before enabling CDP. A hidden WebContentsView can
      // defer Page-domain commands until Electron has placed it on a live surface.
      this.viewHost.showView?.(handle)
      for (const domain of ['Page', 'Runtime', 'Log', 'Network']) {
        await handle.sendCommand(`${domain}.enable`)
      }
      this.navigate(tab, url)
      return tab
    } catch (error) {
      session.tabs.delete(tab.id)
      this.viewHost.destroyView(handle)
      throw error
    }
  }

  private async history(tab: OwnedTab): Promise<NavigationHistory | undefined> {
    const command = tab.handle.sendCommand('Page.getNavigationHistory')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('browser history snapshot timed out')) }, HISTORY_TIMEOUT_MS)
    })
    let result: Record<string, unknown>
    try {
      result = await Promise.race([command, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    const history = navigationHistory(result)
    if (history === undefined) return undefined
    const current = history.entries[history.currentIndex]
    if (current !== undefined) {
      const currentUrl = current.url
      if (
        tab.pendingUrl === undefined
        || currentUrl === tab.pendingUrl
        || (currentUrl !== tab.committedUrl && currentUrl !== 'about:blank')
      ) {
        tab.url = currentUrl
        tab.committedUrl = currentUrl
        if (current.title === undefined) delete tab.title
        else tab.title = current.title
        delete tab.pendingUrl
      }
    }
    tab.canGoBack = history.currentIndex > 0
    tab.canGoForward = history.currentIndex + 1 < history.entries.length
    return history
  }

  private navigate(tab: OwnedTab, url: string): void {
    tab.pendingUrl = url
    delete tab.title
    void tab.handle.sendCommand('Page.navigate', { url }).catch(this.report)
  }

  private async refresh(tab: OwnedTab): Promise<void> {
    try {
      await this.history(tab)
    } catch {
      // A page can disappear between snapshots; the next explicit operation reports the failure.
    }
  }

  private async moveHistory(sessionId: string, offset: -1 | 1, tabId?: string): Promise<void> {
    const tab = this.selectedTab(sessionId, tabId)
    const history = await this.history(tab)
    if (history === undefined) return
    const target = history.entries[history.currentIndex + offset]
    if (target === undefined) return
    await tab.handle.sendCommand('Page.navigateToHistoryEntry', { entryId: target.id })
    tab.url = target.url
    if (target.title === undefined) delete tab.title
    else tab.title = target.title
    tab.committedUrl = target.url
    delete tab.pendingUrl
    tab.canGoBack = history.currentIndex + offset > 0
    tab.canGoForward = history.currentIndex + offset + 1 < history.entries.length
  }

  private touch(session: OwnedSession): void {
    session.lastAccess = Date.now()
  }

  private evictSessionIfNeeded(): void {
    if (this.sessions.size < MAX_CACHED_SESSIONS) return
    let oldest: [string, OwnedSession] | undefined
    for (const entry of this.sessions) {
      if (oldest === undefined || entry[1].lastAccess < oldest[1].lastAccess) oldest = entry
    }
    if (oldest === undefined) return
    for (const tab of oldest[1].tabs.values()) this.viewHost.destroyView(tab.handle)
    this.sessions.delete(oldest[0])
  }
}
