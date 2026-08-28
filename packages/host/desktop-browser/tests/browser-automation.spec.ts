import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DesktopBrowserController } from '../src/browser-automation.ts'
import {
  UserBrowserRuntime,
  type ElectronViewEvent,
  type ElectronViewHandle,
} from '../src/user-browser.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function pngBase64(): string {
  const png = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png)
  png.writeUInt32BE(1, 16)
  png.writeUInt32BE(1, 20)
  return png.toString('base64')
}

function fixture() {
  const commands: Array<{ method: string; params?: Record<string, unknown>; timeoutMs?: number }> = []
  const events: ElectronViewEvent[] = []
  let url = 'about:blank'
  let devToolsOpen = false
  const handle: ElectronViewHandle = {
    id: 'native-view',
    sendCommand: vi.fn(async (
      method: string,
      params?: Record<string, unknown>,
      timeoutMs?: number,
    ) => {
      commands.push({ method, ...(params === undefined ? {} : { params }), ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      if (method === 'Page.navigate' && typeof params?.url === 'string') url = params.url
      if (method === 'Page.getNavigationHistory') {
        return { currentIndex: 0, entries: [{ id: 1, url, title: 'Fixture page' }] }
      }
      if (method === 'Runtime.evaluate') {
        const expression = typeof params?.expression === 'string' ? params.expression : ''
        if (expression.includes('const maxElements')) {
          return { result: { value: { title: 'Fixture page', url, text: 'Hello', elements: [] } } }
        }
        if (expression.includes('const wanted')) {
          return { result: { value: { x: 12, y: 34, selector: '#go', text: 'Go' } } }
        }
        if (expression === 'document.readyState') return { result: { value: 'complete' } }
        return { result: { value: 'evaluated' } }
      }
      if (method === 'Page.captureScreenshot') return { data: pngBase64() }
      if (method === 'Runtime.getIsolateId') return { id: 'isolate' }
      return {}
    }),
    drainEvents: vi.fn(async () => events.splice(0)),
    setDevTools: vi.fn(async (open?: boolean) => {
      devToolsOpen = open ?? !devToolsOpen
      return devToolsOpen
    }),
    capturePreview: vi.fn(async () => ({ mimeType: 'image/jpeg' as const, data: 'aGVsbG8=', sequence: 1 })),
  }
  const runtime = new UserBrowserRuntime({
    createView: () => handle,
    destroyView: () => {},
    showView: () => {},
  })
  return {
    controller: new DesktopBrowserController(runtime),
    commands,
    events,
  }
}

describe('DesktopBrowserController', () => {
  it('reuses conversation tabs for snapshot, click, diagnostics, and guarded CDP', async () => {
    const { controller, commands, events } = fixture()
    const sessionId = SessionId('browser-session')
    const opened = await controller.execute(sessionId, { action: 'open', url: 'example.com' })
    const tabId = opened.tabId!

    expect(opened.tabs[0]).toMatchObject({ id: tabId, url: 'https://example.com', active: true })
    await expect(controller.execute(sessionId, { action: 'snapshot', tabId })).resolves.toMatchObject({
      data: { title: 'Fixture page', text: 'Hello' },
    })
    await expect(controller.execute(sessionId, { action: 'click', tabId, selector: '#go' })).resolves.toMatchObject({
      data: { x: 12, y: 34, clicked: true },
    })
    expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent')).toHaveLength(3)

    events.push(
      { method: 'Runtime.consoleAPICalled', params: { type: 'warning', args: [{ value: 'careful' }] }, timestamp: 10 },
      { method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { url: 'https://example.com/api', method: 'GET' } }, timestamp: 20 },
      { method: 'Network.responseReceived', params: { requestId: 'r1', response: { status: 200, mimeType: 'application/json' } }, timestamp: 25 },
      { method: 'Network.loadingFinished', params: { requestId: 'r1' }, timestamp: 30 },
    )
    await expect(controller.execute(sessionId, { action: 'console', tabId })).resolves.toMatchObject({
      data: [{ level: 'warning', message: 'careful' }],
    })
    await expect(controller.execute(sessionId, { action: 'network', tabId })).resolves.toMatchObject({
      data: [{ requestId: 'r1', status: 200, durationMs: 10 }],
    })
    await expect(controller.execute(sessionId, {
      action: 'cdp', tabId, method: 'Runtime.getIsolateId', params: {},
    })).resolves.toMatchObject({ data: { id: 'isolate' } })
    await expect(controller.execute(sessionId, {
      action: 'cdp', tabId, method: 'Page.setDownloadBehavior', params: { downloadPath: 'C:\\outside' },
    })).rejects.toThrow(/blocked/u)
  })

  it('contains screenshots to a new file below the Session workspace', async () => {
    const { controller } = fixture()
    const sessionId = SessionId('screenshot-session')
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'worldline-browser-'))
    temporaryRoots.push(workspaceRoot)
    const opened = await controller.execute(sessionId, { action: 'open', url: 'https://example.com/' })
    const tabId = opened.tabId!

    const result = await controller.execute(sessionId, {
      action: 'screenshot', tabId, savePath: 'artifacts/page.png',
    }, { workspaceRoot })
    expect(result.data).toMatchObject({ width: 1, height: 1, bytes: 24 })
    expect(await readFile(join(workspaceRoot, 'artifacts', 'page.png'))).toHaveLength(24)

    await expect(controller.execute(sessionId, {
      action: 'screenshot', tabId, savePath: '..\\escape.png',
    }, { workspaceRoot })).rejects.toThrow(/escapes/u)
    await expect(controller.execute(sessionId, {
      action: 'screenshot', tabId, savePath: 'artifacts/page.png',
    }, { workspaceRoot })).rejects.toThrow(/overwrite/u)
  })
})
