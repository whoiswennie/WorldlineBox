import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-browser'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DesktopBrowserController } from './browser-automation.ts'
import {
  UserBrowserRuntime,
  type BrowserPreviewFrame,
  type ElectronBrowserViewHost,
  type ElectronViewEvent,
  type ElectronViewHandle,
  type UserBrowserTab,
} from './user-browser.ts'

interface LocalPage {
  root: string
}

interface BridgeReply {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

interface SurfaceBounds {
  x: number
  y: number
  width: number
  height: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    electronViewHost: ElectronBrowserViewHost
  }
}

// This adapter must apply before optional Agent browser providers evaluate
// their `viewHost: ctx.get('electronViewHost')` bundle expression.
export const inject = ['webServer']

const LOCAL_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

const DEFAULT_BROWSER_URL = 'https://www.bilibili.com/'

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function encodedRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).map(encodeURIComponent).join('/')
}

function loopbackOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? ''
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/iu.test(host)) throw new Error('local browser page requires a loopback Host')
  return `http://${host}`
}

class DesktopElectronViewHost implements ElectronBrowserViewHost {
  private visibilityTransition = Promise.resolve()

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly report: (error: unknown) => void,
  ) {}

  createView(): ElectronViewHandle {
    const id = `view:${randomUUID()}`
    const ready = this.rpc('createView', { viewId: id })
    return {
      id,
      sendCommand: async (method, params, timeoutMs) => {
        await ready
        return await this.rpc('sendCommand', { viewId: id, method, params, timeoutMs })
      },
      drainEvents: async () => {
        await ready
        const result = await this.rpc('drainEvents', { viewId: id })
        if (!Array.isArray(result.events)) return []
        return result.events.flatMap((event): ElectronViewEvent[] => {
          if (typeof event !== 'object' || event === null) return []
          const value = event as { method?: unknown; params?: unknown; timestamp?: unknown }
          if (typeof value.method !== 'string' || typeof value.timestamp !== 'number') return []
          return [{
            method: value.method,
            params: typeof value.params === 'object' && value.params !== null
              ? value.params as Record<string, unknown>
              : {},
            timestamp: value.timestamp,
          }]
        })
      },
      setDevTools: async (open) => {
        await ready
        const result = await this.rpc('setDevTools', { viewId: id, open })
        return result.open === true
      },
      capturePreview: async (maxWidth, maxHeight) => {
        await ready
        const result = await this.rpc('captureView', { viewId: id, maxWidth, maxHeight })
        if (
          (result.mimeType !== 'image/jpeg' && result.mimeType !== 'image/png')
          || typeof result.data !== 'string'
          || typeof result.sequence !== 'number'
        ) throw new Error('desktop browser bridge returned an invalid preview frame')
        return result as unknown as BrowserPreviewFrame
      },
    }
  }

  destroyView(handle: ElectronViewHandle): void {
    void this.rpc('destroyView', { viewId: handle.id }).catch(this.report)
  }

  showView(handle: ElectronViewHandle): void {
    this.queueVisibility('showView', { viewId: handle.id })
  }

  hideView(): void {
    this.queueVisibility('hideView', {})
  }

  async setSurface(active: boolean, bounds?: SurfaceBounds): Promise<Record<string, unknown>> {
    await this.visibilityTransition
    return await this.rpc('setSurface', { active, bounds })
  }

  async drainNewPages(): Promise<string[]> {
    const result = await this.rpc('drainNewPages', {})
    return Array.isArray(result.urls)
      ? result.urls.filter((url): url is string => typeof url === 'string' && /^https?:\/\//iu.test(url))
      : []
  }

  private async rpc(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ op, ...body }),
    })
    const reply = await response.json() as BridgeReply
    if (!response.ok || !reply.ok) throw new Error(reply.error ?? `desktop browser bridge failed (${String(response.status)})`)
    return reply.result ?? {}
  }

  private queueVisibility(op: 'showView' | 'hideView', body: Record<string, unknown>): void {
    this.visibilityTransition = this.visibilityTransition
      .then(async () => { await this.rpc(op, body) })
      .catch((error: unknown) => { this.report(error) })
  }
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function respondPreview(res: ServerResponse, frame: BrowserPreviewFrame): void {
  const body = Buffer.from(frame.data, 'base64')
  if (body.length === 0 || body.length > 8 * 1024 * 1024) {
    throw new Error('browser preview frame is empty or too large')
  }
  res.writeHead(200, {
    'content-type': frame.mimeType,
    'content-length': String(body.length),
    'cache-control': 'no-store, max-age=0',
    'x-worldline-browser-frame': String(frame.sequence),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function previewDimension(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value)
  return Number.isFinite(parsed) ? Math.max(160, Math.min(1920, Math.round(parsed))) : fallback
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk)
    length += buffer.length
    if (length > 64 * 1024) throw new Error('browser surface request is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function desktopBridgeEnvironment(env: NodeJS.ProcessEnv = process.env): { url: string; token: string } | undefined {
  const url = env.WORLDLINE_DESKTOP_BROWSER_BRIDGE_URL
  const token = env.WORLDLINE_DESKTOP_BROWSER_BRIDGE_TOKEN
  if (url === undefined || token === undefined) return undefined
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(url) || token.length < 32) return undefined
  return { url, token }
}

/**
 * Desktop-only Cordis owner for the user browser and optional Agent browser adapters.
 *
 * On ordinary Web deployments it contributes nothing. Inside the desktop app
 * it owns persistent user tabs through the main-process view bridge and also
 * publishes the optional electronViewHost seam used by Agent browser providers.
 */
export function apply(ctx: Context): void {
  const endpoint = desktopBridgeEnvironment()
  if (endpoint === undefined) return

  const viewHost = new DesktopElectronViewHost(endpoint.url, endpoint.token, (error) => {
    ctx.logger.warn(error)
  })
  ctx.provide('electronViewHost', viewHost)
  const userBrowser = new UserBrowserRuntime(viewHost, (error) => { ctx.logger.warn(error) })
  ctx.provide('browserController', new DesktopBrowserController(userBrowser))

  const localPages = new Map<string, LocalPage>()
  const localPageUrl = async (req: IncomingMessage, workspaceRoot: string, filePath: string): Promise<string> => {
    const root = await realpath(resolve(workspaceRoot))
    const target = await realpath(resolve(filePath))
    if (!inside(root, target)) throw new Error('只能在内置浏览器中打开当前工作区内的 HTML 文件。')
    if (!(await stat(target)).isFile() || !/^\.x?html?$/iu.test(extname(target))) {
      throw new Error('只有 HTML、HTM 或 XHTML 文件可以作为本地网页打开。')
    }
    const token = randomUUID()
    localPages.set(token, { root })
    return `${loopbackOrigin(req)}/worldline-local-page/${token}/${encodedRelativePath(root, target)}`
  }

  const localPageHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      const requestUrl = new URL(req.url ?? '/', 'http://localhost')
      const rest = requestUrl.pathname.slice('/worldline-local-page/'.length)
      const [token = '', ...encodedParts] = rest.split('/')
      const page = localPages.get(token)
      if (page === undefined || encodedParts.length === 0) {
        respond(res, 404, { error: 'local page not found' })
        return
      }
      const parts = encodedParts.map(part => decodeURIComponent(part))
      const candidate = resolve(page.root, ...parts)
      const target = await realpath(candidate)
      if (!inside(page.root, target) || !(await stat(target)).isFile()) {
        respond(res, 403, { error: 'local page resource is outside the workspace' })
        return
      }
      const body = await readFile(target)
      res.writeHead(200, {
        'content-type': LOCAL_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(body.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      respond(res, 404, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  let activeTaskKey: string | undefined
  let activeSurface: { taskKey: string; surfaceId: string } | undefined
  let flushingNewPages: Promise<void> | undefined
  const flushNewPages = async (): Promise<void> => {
    if (flushingNewPages !== undefined || activeTaskKey === undefined) return await flushingNewPages
    const taskKey = activeTaskKey
    flushingNewPages = (async () => {
      const urls = await viewHost.drainNewPages()
      for (const url of urls) await userBrowser.openUrl(taskKey, url, true)
    })().finally(() => { flushingNewPages = undefined })
    await flushingNewPages
  }

  const snapshot = async (taskKey: string): Promise<{ available: true; session: string; tabs: UserBrowserTab[] }> => {
    await flushNewPages()
    return { available: true, session: `user:${taskKey}`, tabs: await userBrowser.listTabs(taskKey) }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost')
      const taskKey = requestUrl.searchParams.get('session') ?? ''
      if (taskKey === '') {
        respond(res, 400, { error: 'session is required' })
        return
      }
      if (req.method === 'GET') {
        if (requestUrl.searchParams.get('preview') === '1') {
          await flushNewPages()
          const frame = await userBrowser.capturePreview(
            taskKey,
            previewDimension(requestUrl.searchParams.get('width'), 1280),
            previewDimension(requestUrl.searchParams.get('height'), 960),
          )
          respondPreview(res, frame)
          return
        }
        respond(res, 200, await snapshot(taskKey))
        return
      }
      if (req.method !== 'POST') {
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readJson(req)
      const action = body.action
      if (action === 'surface') {
        const raw = body.bounds as Partial<SurfaceBounds> | undefined
        const bounds = raw !== undefined
          && [raw.x, raw.y, raw.width, raw.height].every(value => typeof value === 'number' && Number.isFinite(value))
          ? raw as SurfaceBounds
          : undefined
        const surfaceId = typeof body.surfaceId === 'string' && body.surfaceId !== ''
          ? body.surfaceId
          : `legacy:${taskKey}`
        const native = body.native === true
        if (body.active === true) {
          activeTaskKey = taskKey
          if (native) {
            activeSurface = { taskKey, surfaceId }
            userBrowser.activateSession(taskKey)
            await viewHost.setSurface(true, bounds)
          }
        } else if (
          native
          && activeSurface?.taskKey === taskKey
          && activeSurface.surfaceId === surfaceId
        ) {
          activeSurface = undefined
          await viewHost.setSurface(false)
        }
        respond(res, 200, await snapshot(taskKey))
        return
      }
      if (action === 'input') {
        const kind = body.kind
        if (kind === 'move' || kind === 'down' || kind === 'up' || kind === 'wheel') {
          const button = body.button === 'middle' || body.button === 'right' || body.button === 'none'
            ? body.button
            : 'left'
          await userBrowser.dispatchPointer(taskKey, {
            kind,
            x: finiteNumber(body.x),
            y: finiteNumber(body.y),
            button,
            clickCount: Math.max(0, Math.min(3, Math.round(finiteNumber(body.clickCount, 1)))),
            deltaX: finiteNumber(body.deltaX),
            deltaY: finiteNumber(body.deltaY),
            modifiers: Math.max(0, Math.min(15, Math.round(finiteNumber(body.modifiers)))),
          })
        } else if (kind === 'key') {
          await userBrowser.dispatchKeyboard(taskKey, {
            ...(typeof body.text === 'string' ? { text: body.text.slice(0, 16) } : {}),
            ...(typeof body.key === 'string' ? { key: body.key.slice(0, 32) } : {}),
            ...(typeof body.code === 'string' ? { code: body.code.slice(0, 32) } : {}),
            modifiers: Math.max(0, Math.min(15, Math.round(finiteNumber(body.modifiers)))),
          })
        } else {
          respond(res, 400, { error: 'invalid browser input' })
          return
        }
        respond(res, 200, await snapshot(taskKey))
        return
      }
      if (action === 'open' && typeof body.url === 'string' && /^https?:\/\//iu.test(body.url)) {
        activeTaskKey = taskKey
        await userBrowser.openUrl(taskKey, body.url, true)
        respond(res, 200, await snapshot(taskKey))
        return
      }
      if (action === 'open-local' && typeof body.workspaceRoot === 'string' && typeof body.path === 'string') {
        activeTaskKey = taskKey
        await userBrowser.openUrl(taskKey, await localPageUrl(req, body.workspaceRoot, body.path), true)
        respond(res, 200, await snapshot(taskKey))
        return
      }
      if (action === 'switch' && typeof body.tabId === 'string') {
        activeTaskKey = taskKey
        userBrowser.switchTab(taskKey, body.tabId)
      } else if (action === 'close' && typeof body.tabId === 'string') {
        activeTaskKey = taskKey
        userBrowser.closeTab(taskKey, body.tabId)
      } else if (action === 'navigate' && typeof body.url === 'string' && /^https?:\/\//iu.test(body.url)) {
        activeTaskKey = taskKey
        await userBrowser.openUrl(taskKey, body.url)
      } else if (action === 'back') {
        await userBrowser.back(taskKey)
      } else if (action === 'forward') {
        await userBrowser.forward(taskKey)
      } else if (action === 'reload') {
        await userBrowser.reload(taskKey)
      } else if (action === 'new') {
        activeTaskKey = taskKey
        await userBrowser.openUrl(taskKey, DEFAULT_BROWSER_URL, true)
      } else {
        respond(res, 400, { error: 'invalid browser action' })
        return
      }
      respond(res, 200, await snapshot(taskKey))
    } catch (error) {
      respond(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/worldline-browser', handler }),
    'desktop-browser: embedded surface route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/worldline-local-page', handler: localPageHandler }),
    'desktop-browser: workspace-local page route',
  )
  ctx.effect(() => {
    const timer = setInterval(() => {
      void flushNewPages().catch((error: unknown) => { ctx.logger.warn(error) })
    }, 300)
    return () => { clearInterval(timer) }
  }, 'desktop-browser: route host-level new pages into embedded tabs')
  ctx.effect(() => () => {
    localPages.clear()
    userBrowser.dispose()
    void viewHost.setSurface(false).catch((error: unknown) => { ctx.logger.warn(error) })
  })
}
