import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserController,
  BrowserExecutionOptions,
  BrowserTabSnapshot,
} from '@deepseek-ai/dsh-browser'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import type { ElectronViewEvent, UserBrowserAutomationTarget, UserBrowserTab } from './user-browser.ts'
import { UserBrowserRuntime } from './user-browser.ts'

interface ConsoleEntry {
  level: string
  message: string
  timestamp: number
  source?: string
  line?: number
}

interface NetworkEntry {
  requestId: string
  url: string
  method?: string
  type?: string
  status?: number
  statusText?: string
  mimeType?: string
  errorText?: string
  fromCache?: boolean
  startedAt: number
  finishedAt?: number
  durationMs?: number
}

interface TabDiagnostics {
  loading: boolean
  devToolsOpen: boolean
  console: ConsoleEntry[]
  network: NetworkEntry[]
  requests: Map<string, NetworkEntry>
}

interface RuntimeEvaluateResult {
  result?: { value?: unknown; description?: string; subtype?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

const MAX_LOG_ENTRIES = 500
const MAX_DIAGNOSTIC_TABS = 128
const MAX_COMMAND_TIMEOUT_MS = 60_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_TEXT_LENGTH = 12_000
const MAX_TEXT_LENGTH = 200_000
const DEFAULT_ELEMENTS = 80
const MAX_ELEMENTS = 500
const DEFAULT_LOG_RESULT_ENTRIES = 100
const MAX_LOG_RESULT_ENTRIES = 500
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : fallback
}

function asJson(value: unknown): JsonValue {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function messageOfRemoteObject(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value !== 'object') return ''
  const candidate = value as { value?: unknown; description?: unknown }
  if (candidate.value !== undefined) {
    return typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.value)
  }
  return typeof candidate.description === 'string' ? candidate.description : ''
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return { width: 0, height: 0 }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function tabSnapshot(tab: UserBrowserTab, diagnostics: TabDiagnostics): BrowserTabSnapshot {
  return {
    id: tab.id,
    url: tab.url,
    ...(tab.title === undefined ? {} : { title: tab.title }),
    active: tab.active,
    loading: diagnostics.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    devToolsOpen: diagnostics.devToolsOpen,
  }
}

/** CDP-backed controller for the product's existing conversation-owned tabs. */
export class DesktopBrowserController implements BrowserController {
  private readonly diagnostics = new Map<string, TabDiagnostics>()

  constructor(private readonly browser: UserBrowserRuntime) {}

  async execute(
    sessionId: SessionId,
    command: BrowserCommand,
    options: BrowserExecutionOptions = {},
  ): Promise<BrowserCommandResult> {
    options.signal?.throwIfAborted()
    const timeoutMs = boundedInteger(command.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS)
    let tabId = command.tabId
    let data: JsonValue | undefined

    switch (command.action) {
      case 'list':
        break
      case 'open': {
        const url = this.url(command.url ?? 'about:blank')
        tabId = await this.browser.openUrl(sessionId, url, true)
        this.meta(tabId).loading = url !== 'about:blank'
        data = asJson(await this.state(sessionId, tabId))
        break
      }
      case 'focus':
        tabId = this.requireTabId(command)
        this.browser.switchTab(sessionId, tabId)
        data = asJson(await this.state(sessionId, tabId))
        break
      case 'close':
        tabId = this.requireTabId(command)
        this.browser.closeTab(sessionId, tabId)
        this.diagnostics.delete(tabId)
        break
      case 'state': {
        const state = await this.state(sessionId, tabId)
        tabId = state.id
        data = asJson(state)
        break
      }
      case 'navigate': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        const url = this.url(this.required(command.url, 'navigate requires url'))
        await this.browser.navigateTab(sessionId, url, tabId)
        this.meta(tabId).loading = true
        data = asJson({ url })
        break
      }
      case 'reload': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        await this.browser.reload(sessionId, tabId)
        this.meta(tabId).loading = true
        break
      }
      case 'back': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        await this.browser.back(sessionId, tabId)
        this.meta(tabId).loading = true
        break
      }
      case 'forward': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        await this.browser.forward(sessionId, tabId)
        this.meta(tabId).loading = true
        break
      }
      case 'stop': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        await this.browser.stop(sessionId, tabId)
        this.meta(tabId).loading = false
        break
      }
      case 'snapshot': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(await this.evaluate(
          target,
          this.snapshotScript(
            boundedInteger(command.maxTextLength, DEFAULT_TEXT_LENGTH, MAX_TEXT_LENGTH),
            boundedInteger(command.maxElements, DEFAULT_ELEMENTS, MAX_ELEMENTS),
          ),
          timeoutMs,
          false,
        ))
        break
      }
      case 'html':
      case 'text': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        const cap = boundedInteger(command.maxTextLength, 100_000, MAX_TEXT_LENGTH)
        const expression = command.action === 'html'
          ? `document.documentElement.outerHTML.slice(0, ${String(cap)})`
          : `(document.body?.innerText ?? document.documentElement.innerText ?? '').slice(0, ${String(cap)})`
        data = asJson(await this.evaluate(target, expression, timeoutMs, false))
        break
      }
      case 'screenshot': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(await this.screenshot(target, command, options, timeoutMs))
        break
      }
      case 'evaluate': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        const expression = this.required(command.expression, 'evaluate requires expression')
        data = asJson(await this.evaluate(target, this.evaluationScript(expression), timeoutMs, false))
        break
      }
      case 'click': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(await this.click(target, command, timeoutMs))
        break
      }
      case 'fill':
      case 'type': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(await this.fill(target, command, timeoutMs))
        break
      }
      case 'press': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(await this.press(target, this.required(command.key, 'press requires key'), timeoutMs))
        break
      }
      case 'select': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        const selector = this.required(command.selector, 'select requires selector')
        data = asJson(await this.evaluate(target, this.selectScript(selector, command.value ?? ''), timeoutMs, false))
        break
      }
      case 'wait_for_selector': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(await this.waitForSelector(target, command, timeoutMs, options.signal))
        break
      }
      case 'wait_for_load': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(await this.waitForLoad(target, timeoutMs, options.signal))
        break
      }
      case 'console': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(this.meta(tabId).console.slice(-boundedInteger(
          command.maxEntries,
          DEFAULT_LOG_RESULT_ENTRIES,
          MAX_LOG_RESULT_ENTRIES,
        )))
        break
      }
      case 'network': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        data = asJson(this.meta(tabId).network.slice(-boundedInteger(
          command.maxEntries,
          DEFAULT_LOG_RESULT_ENTRIES,
          MAX_LOG_RESULT_ENTRIES,
        )))
        break
      }
      case 'clear_logs': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        const diagnostics = this.meta(tabId)
        diagnostics.console = []
        diagnostics.network = []
        diagnostics.requests.clear()
        break
      }
      case 'devtools': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        const open = await target.setDevTools(command.open)
        this.meta(tabId).devToolsOpen = open
        data = asJson({ open })
        break
      }
      case 'cdp': {
        const target = await this.target(sessionId, tabId)
        tabId = target.id
        const method = this.required(command.method, 'cdp requires method')
        this.assertSafeRawMethod(method)
        data = asJson(await target.sendCommand(method, command.params, timeoutMs))
        await this.consumeEvents(target)
        break
      }
      default:
        throw new Error(`unsupported browser action: ${String(command.action)}`)
    }

    options.signal?.throwIfAborted()
    const tabs = await this.tabs(sessionId)
    return {
      action: command.action,
      ...(tabId === undefined ? {} : { tabId }),
      ...(data === undefined ? {} : { data }),
      tabs,
    }
  }

  private async tabs(sessionId: SessionId): Promise<BrowserTabSnapshot[]> {
    const tabs = await this.browser.listTabs(sessionId)
    for (const tab of tabs) {
      try { await this.consumeEvents(this.browser.automationTarget(sessionId, tab.id)) } catch { /* tab closed */ }
    }
    return tabs.map(tab => tabSnapshot(tab, this.meta(tab.id)))
  }

  private async state(sessionId: SessionId, tabId?: string): Promise<BrowserTabSnapshot> {
    const tab = await this.browser.tabState(sessionId, tabId)
    const target = this.browser.automationTarget(sessionId, tab.id)
    await this.consumeEvents(target)
    return tabSnapshot(tab, this.meta(tab.id))
  }

  private async target(sessionId: SessionId, tabId?: string): Promise<UserBrowserAutomationTarget> {
    const target = this.browser.automationTarget(sessionId, tabId)
    await this.consumeEvents(target)
    return target
  }

  private meta(tabId: string): TabDiagnostics {
    let value = this.diagnostics.get(tabId)
    if (value !== undefined) {
      this.diagnostics.delete(tabId)
      this.diagnostics.set(tabId, value)
      return value
    }
    if (this.diagnostics.size >= MAX_DIAGNOSTIC_TABS) {
      const oldest = this.diagnostics.keys().next().value
      if (oldest !== undefined) this.diagnostics.delete(oldest)
    }
    value = {
      loading: false,
      devToolsOpen: false,
      console: [],
      network: [],
      requests: new Map(),
    }
    this.diagnostics.set(tabId, value)
    return value
  }

  private async consumeEvents(target: UserBrowserAutomationTarget): Promise<void> {
    const diagnostics = this.meta(target.id)
    for (const event of await target.drainEvents()) this.consumeEvent(diagnostics, event)
  }

  private consumeEvent(diagnostics: TabDiagnostics, event: ElectronViewEvent): void {
    const params = event.params
    if (event.method === 'Page.frameStartedLoading') diagnostics.loading = true
    if (event.method === 'Page.loadEventFired' || event.method === 'Page.frameStoppedLoading') {
      diagnostics.loading = false
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params.args) ? params.args : []
      this.push(diagnostics.console, {
        level: typeof params.type === 'string' ? params.type : 'log',
        message: args.map(messageOfRemoteObject).join(' '),
        timestamp: event.timestamp,
      })
      return
    }
    if (event.method === 'Log.entryAdded') {
      const entry = params.entry as Record<string, unknown> | undefined
      if (entry === undefined) return
      this.push(diagnostics.console, {
        level: typeof entry.level === 'string' ? entry.level : 'log',
        message: typeof entry.text === 'string' ? entry.text : '',
        timestamp: event.timestamp,
        ...(typeof entry.url === 'string' ? { source: entry.url } : {}),
        ...(typeof entry.lineNumber === 'number' ? { line: entry.lineNumber } : {}),
      })
      return
    }
    if (event.method === 'Network.requestWillBeSent') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const request = params.request as Record<string, unknown> | undefined
      if (requestId === '' || request === undefined || typeof request.url !== 'string') return
      const entry: NetworkEntry = {
        requestId,
        url: request.url,
        ...(typeof request.method === 'string' ? { method: request.method } : {}),
        ...(typeof params.type === 'string' ? { type: params.type } : {}),
        startedAt: event.timestamp,
      }
      diagnostics.requests.set(requestId, entry)
      this.push(diagnostics.network, entry)
      return
    }
    if (event.method === 'Network.responseReceived') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const response = params.response as Record<string, unknown> | undefined
      const entry = diagnostics.requests.get(requestId)
      if (entry === undefined || response === undefined) return
      if (typeof response.status === 'number') entry.status = response.status
      if (typeof response.statusText === 'string') entry.statusText = response.statusText
      if (typeof response.mimeType === 'string') entry.mimeType = response.mimeType
      entry.fromCache = response.fromDiskCache === true || response.fromPrefetchCache === true
      return
    }
    if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const entry = diagnostics.requests.get(requestId)
      if (entry === undefined) return
      entry.finishedAt = event.timestamp
      entry.durationMs = event.timestamp - entry.startedAt
      if (event.method === 'Network.loadingFailed') {
        entry.errorText = typeof params.errorText === 'string' ? params.errorText : 'Loading failed'
      }
    }
  }

  private push<T>(entries: T[], entry: T): void {
    entries.push(entry)
    if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES)
  }

  private async evaluate(
    target: UserBrowserAutomationTarget,
    expression: string,
    timeoutMs: number,
    userGesture: boolean,
  ): Promise<unknown> {
    const response = await target.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    }, timeoutMs) as RuntimeEvaluateResult
    if (response.exceptionDetails !== undefined) {
      throw new Error(response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? 'page evaluation failed')
    }
    const remote = response.result
    if (remote?.value !== undefined) return remote.value
    if (remote?.subtype === 'null') return null
    return remote?.description ?? null
  }

  private async click(
    target: UserBrowserAutomationTarget,
    command: BrowserCommand,
    timeoutMs: number,
  ): Promise<Record<string, JsonValue>> {
    let point: { x: number; y: number; selector?: string; text?: string }
    if (command.selector !== undefined || command.text !== undefined) {
      const result = await this.evaluate(
        target,
        this.clickPointScript(command.selector, command.text),
        timeoutMs,
        true,
      ) as typeof point | null
      if (result === null) throw new Error('target element was not found or is not visible')
      point = result
    } else if (typeof command.x === 'number' && typeof command.y === 'number') {
      point = { x: command.x, y: command.y }
    } else {
      throw new Error('click requires selector, text, or x/y coordinates')
    }
    await target.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y,
    }, timeoutMs)
    await target.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    }, timeoutMs)
    await target.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    }, timeoutMs)
    await this.consumeEvents(target)
    return asJson({ ...point, clicked: true }) as Record<string, JsonValue>
  }

  private async fill(
    target: UserBrowserAutomationTarget,
    command: BrowserCommand,
    timeoutMs: number,
  ): Promise<unknown> {
    const value = command.value ?? command.text ?? ''
    if (command.selector === undefined) {
      await target.sendCommand('Input.insertText', { text: value }, timeoutMs)
      return { inserted: value.length }
    }
    return this.evaluate(
      target,
      this.fillScript(command.selector, value, command.action === 'type'),
      timeoutMs,
      true,
    )
  }

  private async press(
    target: UserBrowserAutomationTarget,
    shortcut: string,
    timeoutMs: number,
  ): Promise<Record<string, JsonValue>> {
    const parts = shortcut.split('+').map(part => part.trim()).filter(Boolean)
    const key = parts.pop()
    if (key === undefined) throw new Error('press requires key')
    let modifiers = 0
    for (const part of parts) {
      switch (part.toLowerCase()) {
        case 'alt': case 'option': modifiers |= 1; break
        case 'ctrl': case 'control': modifiers |= 2; break
        case 'cmd': case 'command': case 'meta': modifiers |= 4; break
        case 'shift': modifiers |= 8; break
        default: throw new Error(`unsupported key modifier: ${part}`)
      }
    }
    const aliases: Record<string, string> = {
      enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', backspace: 'Backspace',
      delete: 'Delete', space: ' ', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
      arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End',
      pageup: 'PageUp', pagedown: 'PageDown',
    }
    const normalized = aliases[key.toLowerCase()] ?? key
    await target.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: normalized, code: normalized, modifiers,
    }, timeoutMs)
    await target.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: normalized, code: normalized, modifiers,
    }, timeoutMs)
    return { key: normalized, modifiers }
  }

  private async waitForSelector(
    target: UserBrowserAutomationTarget,
    command: BrowserCommand,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, JsonValue>> {
    if (command.selector === undefined && command.text === undefined) {
      throw new Error('wait_for_selector requires selector or text')
    }
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      signal?.throwIfAborted()
      const exists = await this.evaluate(
        target,
        this.elementExistsScript(command.selector, command.text),
        Math.min(timeoutMs, 5_000),
        false,
      )
      if (exists === true) return { found: true, elapsedMs: Date.now() - startedAt }
      await this.delay(250, signal)
    }
    throw new Error('timed out waiting for selector')
  }

  private async waitForLoad(
    target: UserBrowserAutomationTarget,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, JsonValue>> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      signal?.throwIfAborted()
      await this.consumeEvents(target)
      const readyState = await this.evaluate(target, 'document.readyState', Math.min(timeoutMs, 5_000), false)
      if (readyState === 'complete') {
        this.meta(target.id).loading = false
        return { readyState, elapsedMs: Date.now() - startedAt }
      }
      await this.delay(250, signal)
    }
    throw new Error('timed out waiting for page load')
  }

  private async screenshot(
    target: UserBrowserAutomationTarget,
    command: BrowserCommand,
    options: BrowserExecutionOptions,
    timeoutMs: number,
  ): Promise<Record<string, JsonValue>> {
    const path = await this.screenshotPath(options.workspaceRoot, command.savePath)
    const clipValues = [command.x, command.y, command.width, command.height]
    const hasClip = clipValues.every(value => typeof value === 'number' && Number.isFinite(value))
    if (hasClip && ((command.width as number) <= 0 || (command.height as number) <= 0)) {
      throw new Error('screenshot width and height must be positive')
    }
    const response = await target.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      ...(hasClip ? {
        clip: {
          x: command.x, y: command.y, width: command.width, height: command.height, scale: 1,
        },
      } : {}),
    }, timeoutMs)
    if (typeof response.data !== 'string') throw new Error('browser screenshot returned no PNG data')
    const png = Buffer.from(response.data, 'base64')
    if (png.length > MAX_SCREENSHOT_BYTES) throw new Error('browser screenshot exceeds the 32 MiB safety limit')
    const file = await open(path, 'wx')
    try {
      await file.writeFile(png)
    } finally {
      await file.close()
    }
    const size = pngSize(png)
    return { path, width: size.width, height: size.height, bytes: png.length }
  }

  private async screenshotPath(workspaceRoot: string | undefined, requested: string | undefined): Promise<string> {
    if (workspaceRoot === undefined) throw new Error('browser screenshot requires a Session workspace')
    if (requested !== undefined && isAbsolute(requested)) {
      throw new Error('browser screenshot path must be relative to the Session workspace')
    }
    const root = await realpath(resolve(workspaceRoot))
    const candidate = resolve(
      root,
      requested ?? `screenshots/browser-${String(Date.now())}-${randomUUID()}.png`,
    )
    if (!inside(root, candidate)) throw new Error('browser screenshot path escapes the Session workspace')
    const parts = relative(root, candidate).split(sep)
    const fileName = parts.pop()
    if (fileName === undefined || fileName === '' || fileName === '.' || fileName === '..') {
      throw new Error('browser screenshot path must name a file')
    }
    let parent = root
    for (const part of parts) {
      const next = resolve(parent, part)
      try {
        const stats = await lstat(next)
        if (stats.isSymbolicLink()) throw new Error('browser screenshot path cannot traverse a symbolic link')
        if (!stats.isDirectory()) throw new Error('browser screenshot parent path is not a directory')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(next)
      }
      parent = await realpath(next)
      if (!inside(root, parent)) throw new Error('browser screenshot path resolves outside the Session workspace')
    }
    const target = resolve(parent, basename(fileName))
    try {
      await lstat(target)
      throw new Error('browser screenshot refuses to overwrite an existing path')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return target
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await new Promise<void>((resolveDelay, reject) => {
      const timer = setTimeout(resolveDelay, ms)
      const abort = () => {
        clearTimeout(timer)
        reject(signal?.reason instanceof Error
          ? signal.reason
          : new Error('browser operation aborted'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal !== undefined) {
        setTimeout(() => { signal.removeEventListener('abort', abort) }, ms)
      }
    })
  }

  private url(value: string): string {
    const trimmed = value.trim()
    if (trimmed === 'about:blank' || /^https?:\/\//iu.test(trimmed)) return trimmed
    if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
      throw new Error('the embedded browser only allows HTTP(S) URLs')
    }
    return `https://${trimmed}`
  }

  private required(value: string | undefined, message: string): string {
    if (value === undefined || value.trim() === '') throw new Error(message)
    return value
  }

  private requireTabId(command: BrowserCommand): string {
    return this.required(command.tabId, `${command.action} requires tabId`)
  }

  private assertSafeRawMethod(method: string): void {
    if (method === 'Browser.setDownloadBehavior' || method === 'Page.setDownloadBehavior') {
      throw new Error(`${method} is blocked because it can write outside the Session workspace`)
    }
  }

  private evaluationScript(expression: string): string {
    return `(async () => {
      const source = ${JSON.stringify(expression)};
      let value;
      try { value = await eval('(' + source + ')'); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        value = await eval('(async () => {\\n' + source + '\\n})()');
      }
      return value;
    })()`
  }

  private snapshotScript(maxTextLength: number, maxElements: number): string {
    return `(() => {
      const maxTextLength = ${String(maxTextLength)};
      const maxElements = ${String(maxElements)};
      const visible = (el, rect) => {
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
          && style.display !== 'none' && Number(style.opacity || 1) > 0;
      };
      const selectorFor = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 5) {
          let part = node.localName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(child => child.localName === node.localName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(' > ');
      };
      const elements = [];
      const candidates = document.querySelectorAll('a,button,input,textarea,select,summary,label,[role],[contenteditable="true"],[tabindex]');
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (!visible(el, rect)) continue;
        elements.push({
          index: elements.length,
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          text: String(el.innerText || el.textContent || '').trim().slice(0, 300),
          ariaLabel: el.getAttribute('aria-label') || '',
          role: el.getAttribute('role') || '',
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          value: 'value' in el ? String(el.value || '').slice(0, 300) : '',
          href: el.href || '',
          disabled: Boolean(el.disabled),
          checked: Boolean(el.checked),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
        if (elements.length >= maxElements) break;
      }
      return {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        text: String(document.body?.innerText || document.documentElement.innerText || '').slice(0, maxTextLength),
        elements,
      };
    })()`
  }

  private clickPointScript(selector?: string, text?: string): string {
    return `(() => {
      const selector = ${JSON.stringify(selector ?? '')};
      const wanted = ${JSON.stringify(text ?? '')}.replace(/\\s+/g, ' ').trim().toLowerCase();
      const visibleRect = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' ? rect : null;
      };
      let el = selector ? document.querySelector(selector) : null;
      if (!el && wanted) {
        const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,label,summary,[role],[tabindex],h1,h2,h3,h4,p,span,div')).slice(0, 5000);
        el = candidates.find(node => visibleRect(node) && [node.innerText, node.textContent,
          node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('alt'), node.value]
          .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().toLowerCase().includes(wanted));
      }
      if (!el) return null;
      el = el.closest('a,button,input,textarea,select,label,summary,[role="button"],[role="link"],[contenteditable="true"],[tabindex]') || el;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = visibleRect(el);
      if (!rect) return null;
      el.focus?.();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        selector: selector || '',
        text: String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 160),
      };
    })()`
  }

  private fillScript(selector: string, value: string, append: boolean): string {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('element not found: ' + ${JSON.stringify(selector)});
      const value = ${JSON.stringify(value)};
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = ${append ? "String(el.textContent || '') + value" : 'value'};
      } else if ('value' in el) {
        const nextValue = ${append ? "String(el.value || '') + value" : 'value'};
        const prototype = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) descriptor.set.call(el, nextValue); else el.value = nextValue;
      } else throw new Error('target is not editable');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selector: ${JSON.stringify(selector)}, valueLength: value.length };
    })()`
  }

  private selectScript(selector: string, value: string): string {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLSelectElement)) throw new Error('select target is not a <select>: ' + ${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selector: ${JSON.stringify(selector)}, value: el.value };
    })()`
  }

  private elementExistsScript(selector?: string, text?: string): string {
    return `(() => {
      const selector = ${JSON.stringify(selector ?? '')};
      const wanted = ${JSON.stringify(text ?? '')}.toLowerCase();
      let el = selector ? document.querySelector(selector) : null;
      if (!el && wanted) el = Array.from(document.querySelectorAll('body *')).slice(0, 10000)
        .find(node => String(node.innerText || node.textContent || '').toLowerCase().includes(wanted));
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    })()`
  }
}
