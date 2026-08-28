import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebContentsView, type BrowserWindow, type NativeImage, type Rectangle } from 'electron'
import { browserViewBounds } from './browser-view-bounds.ts'

const CDP_VERSION = '1.3'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const CDP_COMMAND_TIMEOUT_MS = 2_000
const MAX_CDP_COMMAND_TIMEOUT_MS = 60_000
const MAX_VIEW_EVENTS = 1_000

interface CdpEvent {
  method: string
  params: Record<string, unknown>
  timestamp: number
}

interface RpcRequest {
  op: 'createView' | 'destroyView' | 'showView' | 'hideView' | 'sendCommand'
    | 'setSurface' | 'drainNewPages' | 'drainEvents' | 'setDevTools' | 'captureView'
  viewId?: string
  method?: string
  params?: Record<string, unknown>
  timeoutMs?: number
  open?: boolean
  active?: boolean
  bounds?: Rectangle
  maxWidth?: number
  maxHeight?: number
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(encoded.length),
    'cache-control': 'no-store',
  })
  res.end(encoded)
}

async function readBody(req: IncomingMessage): Promise<RpcRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('desktop browser RPC body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest
}

function validBounds(value: Rectangle | undefined): Rectangle | undefined {
  if (value === undefined) return undefined
  const fields = [value.x, value.y, value.width, value.height]
  if (fields.some(field => !Number.isFinite(field))) return undefined
  return {
    x: Math.max(0, Math.round(value.x)),
    y: Math.max(0, Math.round(value.y)),
    width: Math.max(1, Math.round(value.width)),
    height: Math.max(1, Math.round(value.height)),
  }
}

/**
 * Main-process owner for native browser WebContentsViews.
 *
 * The Agent runtime lives in a child Node process, so the ordinary Cordis
 * electronViewHost service talks to this owner over an authenticated loopback
 * channel. The desktop window remains the sole owner of native Electron
 * objects. Views are hidden rather than destroyed when the user changes an
 * application view or browser tab, and their persistent partition retains
 * cookies, storage, cache, and login state across application restarts.
 */
export class EmbeddedBrowserBridge {
  private readonly token = randomBytes(32).toString('hex')
  private readonly views = new Map<string, WebContentsView>()
  private readonly viewEvents = new Map<string, CdpEvent[]>()
  private requestedViewId: string | undefined
  private fullscreenViewId: string | undefined
  private surfaceActive = false
  private surfaceBounds: Rectangle | undefined
  private readonly pendingNewPages: string[] = []
  private previewSequence = 0
  private stopping = false
  private observedWindow: BrowserWindow | undefined
  private readonly onWindowResize = () => { this.syncVisibility() }
  private readonly server = createServer((req, res) => { void this.handle(req, res) })

  constructor(private readonly getWindow: () => BrowserWindow | undefined) {}

  async start(): Promise<{ url: string; token: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address() as AddressInfo
    return { url: `http://127.0.0.1:${String(address.port)}`, token: this.token }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.unobserveWindow()
    for (const id of [...this.views.keys()]) this.destroyView(id)
    if (!this.server.listening) return
    await new Promise<void>(resolve => this.server.close(() => { resolve() }))
  }

  /** Queue any host-level navigation that requested a new page. */
  enqueueNewPage(url: string): void {
    if (!/^https?:\/\//iu.test(url)) return
    this.pendingNewPages.push(url)
    if (this.pendingNewPages.length > 100) this.pendingNewPages.splice(0, this.pendingNewPages.length - 100)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${this.token}`) {
      json(res, 404, { error: 'not found' })
      return
    }
    try {
      const body = await readBody(req)
      const result = await this.dispatch(body)
      json(res, 200, { ok: true, result })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async dispatch(request: RpcRequest): Promise<unknown> {
    if (request.op === 'createView') {
      if (typeof request.viewId !== 'string' || request.viewId === '') throw new Error('createView requires viewId')
      await this.createView(request.viewId)
      return {}
    }
    if (request.op === 'destroyView') {
      if (typeof request.viewId !== 'string') throw new Error('destroyView requires viewId')
      this.destroyView(request.viewId)
      return {}
    }
    if (request.op === 'showView') {
      if (typeof request.viewId !== 'string') throw new Error('showView requires viewId')
      this.requestedViewId = request.viewId
      this.syncVisibility()
      return {}
    }
    if (request.op === 'hideView') {
      this.requestedViewId = undefined
      this.syncVisibility()
      return {}
    }
    if (request.op === 'setSurface') {
      this.surfaceActive = request.active === true
      this.surfaceBounds = validBounds(request.bounds)
      this.syncVisibility()
      return {}
    }
    if (request.op === 'drainNewPages') {
      return { urls: this.pendingNewPages.splice(0) }
    }
    if (request.op === 'drainEvents') {
      if (typeof request.viewId !== 'string') throw new Error('drainEvents requires viewId')
      if (!this.views.has(request.viewId)) throw new Error(`unknown browser view "${request.viewId}"`)
      return { events: this.viewEvents.get(request.viewId)?.splice(0) ?? [] }
    }
    if (request.op === 'setDevTools') {
      if (typeof request.viewId !== 'string') throw new Error('setDevTools requires viewId')
      const view = this.views.get(request.viewId)
      if (view === undefined) throw new Error(`unknown browser view "${request.viewId}"`)
      const open = request.open ?? !view.webContents.isDevToolsOpened()
      if (open) view.webContents.openDevTools({ mode: 'detach' })
      else view.webContents.closeDevTools()
      return { open: view.webContents.isDevToolsOpened() }
    }
    if (request.op === 'captureView') {
      if (typeof request.viewId !== 'string') throw new Error('captureView requires viewId')
      const view = this.views.get(request.viewId)
      if (view === undefined) throw new Error(`unknown browser view "${request.viewId}"`)
      const maxWidth = this.previewDimension(request.maxWidth, 1280)
      const maxHeight = this.previewDimension(request.maxHeight, 960)
      const window = this.getWindow()
      const nativeVisible = this.surfaceActive
        && this.surfaceBounds !== undefined
        && this.requestedViewId === request.viewId
      if (!nativeVisible && window !== undefined && !window.isDestroyed()) {
        // Keep remote previews composited without placing them above Worldline's
        // renderer. Index zero puts the browser behind the application view.
        window.contentView.addChildView(view, 0)
        view.setBounds({ x: 0, y: 0, width: maxWidth, height: maxHeight })
        view.setVisible(true)
        await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
      }
      const captured = view.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('browser preview capture timed out')) }, 5_000)
      })
      let image: NativeImage
      try {
        image = await Promise.race([captured, timeout])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.syncVisibility()
      }
      if (image.isEmpty()) throw new Error('browser preview frame is empty')
      const size = image.getSize()
      const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height)
      const output = scale < 1
        ? image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: 'good',
        })
        : image
      return {
        mimeType: 'image/jpeg',
        data: output.toJPEG(78).toString('base64'),
        sequence: ++this.previewSequence,
      }
    }
    if (typeof request.viewId !== 'string' || typeof request.method !== 'string') {
      throw new Error('sendCommand requires viewId and method')
    }
    const view = this.views.get(request.viewId)
    if (view === undefined) throw new Error(`unknown browser view "${request.viewId}"`)
    if (!view.webContents.debugger.isAttached()) view.webContents.debugger.attach(CDP_VERSION)
    if (request.method === 'Page.navigate') {
      void view.webContents.debugger.sendCommand(request.method, request.params).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        const closedDuringNavigation = /target closed while handling command/iu.test(message)
        if (!this.stopping && !closedDuringNavigation && !view.webContents.isDestroyed()) {
          console.error('[desktop-browser] navigation failed:', error)
        }
      })
      return {}
    }
    const command = view.webContents.debugger.sendCommand(request.method, request.params)
    const timeoutMs = typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs)
      ? Math.max(1, Math.min(Math.round(request.timeoutMs), MAX_CDP_COMMAND_TIMEOUT_MS))
      : CDP_COMMAND_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`browser command timed out after ${String(timeoutMs)}ms: ${request.method}`))
      }, timeoutMs)
    })
    try {
      return await Promise.race([command, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async createView(id: string): Promise<void> {
    if (this.views.has(id)) return
    const window = this.getWindow()
    if (window === undefined || window.isDestroyed()) throw new Error('desktop window is not ready')
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: 'persist:worldline-browser',
      },
    })
    const events: CdpEvent[] = []
    this.viewEvents.set(id, events)
    view.setVisible(false)
    view.webContents.setWindowOpenHandler(({ url }) => {
      this.enqueueNewPage(url)
      return { action: 'deny' }
    })
    view.webContents.on('enter-html-full-screen', () => {
      this.fullscreenViewId = id
      this.requestedViewId = id
      this.syncVisibility()
    })
    view.webContents.on('leave-html-full-screen', () => {
      if (this.fullscreenViewId === id) this.fullscreenViewId = undefined
      this.syncVisibility()
    })
    this.observeWindow(window)
    window.contentView.addChildView(view)
    this.views.set(id, view)
    this.syncVisibility()
    try {
      await view.webContents.loadURL('about:blank')
      view.webContents.debugger.attach(CDP_VERSION)
      view.webContents.debugger.on('message', (_event, method, params) => {
        events.push({
          method,
          params: typeof params === 'object' && params !== null
            ? params as Record<string, unknown>
            : {},
          timestamp: Date.now(),
        })
        if (events.length > MAX_VIEW_EVENTS) events.splice(0, events.length - MAX_VIEW_EVENTS)
      })
    } catch (error) {
      this.destroyView(id)
      throw error
    }
  }

  private previewDimension(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(160, Math.min(1920, Math.round(value)))
      : fallback
  }

  private destroyView(id: string): void {
    const view = this.views.get(id)
    if (view === undefined) return
    this.views.delete(id)
    this.viewEvents.delete(id)
    if (this.requestedViewId === id) this.requestedViewId = undefined
    if (this.fullscreenViewId === id) this.fullscreenViewId = undefined
    const window = this.getWindow()
    if (window !== undefined && !window.isDestroyed()) {
      try { window.contentView.removeChildView(view) } catch { /* already detached */ }
    }
    if (!view.webContents.isDestroyed()) {
      try {
        if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach()
      } catch { /* renderer already gone */ }
      view.webContents.close()
    }
    this.syncVisibility()
  }

  private syncVisibility(): void {
    const visible = this.surfaceActive && this.surfaceBounds !== undefined
      ? this.requestedViewId
      : undefined
    for (const [id, view] of this.views) {
      if (visible === id && this.surfaceBounds !== undefined) {
        const window = this.getWindow()
        const content = window === undefined || window.isDestroyed() ? undefined : window.getContentBounds()
        const bounds = browserViewBounds(this.surfaceBounds, this.fullscreenViewId === id, content)
        window?.contentView.addChildView(view)
        view.setBounds(bounds)
        view.setVisible(true)
      } else {
        view.setVisible(false)
      }
    }
  }

  private observeWindow(window: BrowserWindow): void {
    if (this.observedWindow === window) return
    this.unobserveWindow()
    this.observedWindow = window
    window.on('resize', this.onWindowResize)
  }

  private unobserveWindow(): void {
    const window = this.observedWindow
    this.observedWindow = undefined
    if (window !== undefined && !window.isDestroyed()) window.off('resize', this.onWindowResize)
  }
}
