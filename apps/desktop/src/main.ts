import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  app, BrowserWindow, Menu, session as electronSession, webContents as electronWebContents,
} from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { withAuthBootstrapFragment } from '@deepseek-ai/dsh-local-auth'
import { createDesktopContext } from './desktop-profile.ts'
import { desktopTenantLaunch } from './tenant-runtime.ts'
import { browserHostEntry, runBrowserHostEntry } from './browser-host-entry.ts'
import { EmbeddedBrowserBridge } from './embedded-browser-bridge.ts'
import { desktopPermissionAllowed } from './permission-policy.ts'
import {
  RENDER_DATA_PREFIX,
  RENDER_WEBVIEW_PARTITION,
  configureRenderWebPreferences,
  embeddingResponseHeaders,
  isRenderWebviewAttachment,
  renderRequestAllowed,
} from './render-webview-policy.ts'
import type {} from './desktop-services.ts'
import type {} from './runtime-supervisor.ts'
import type { RuntimeLaunchRecipe } from './runtime-supervisor.ts'
import { desktopStartupDataUrl } from './startup-window.ts'
import { WINDOWS_APP_ID, windowsAppDetails } from './windows-app-details.ts'

const PRODUCT_NAME = '世界线'
// Keep the pre-rename directory as an internal compatibility key. Changing this
// path would silently discard installed and development browser cookies, site
// storage, cache, window state, and other Electron-local data.
const ELECTRON_USER_DATA_NAME = 'Worldline Fantasy'
const SMOKE_FLAG = '--desktop-smoke-test'
const STARTUP_SMOKE_FLAG = '--desktop-startup-smoke-test'
// Windows resolves the taskbar group/icon before `ready` on some first-launch
// paths. Set the same AUMID electron-builder writes into NSIS shortcuts as soon
// as the main module loads, before any BrowserWindow can be constructed.
if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_ID)
// The built-in player restores playback during app boot, before a click exists.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
let window: BrowserWindow | undefined
let desktop: Context | undefined
let embeddedBrowser: EmbeddedBrowserBridge | undefined
let embeddedBrowserEndpoint: { url: string; token: string } | undefined
let runtimeBootstrapToken: string | undefined
let quitting = false
async function smoke(url: string): Promise<void> {
  const response = await fetch(url)
  const html = await response.text()
  // Structured index injection uses a global assignment instead of the old
  // literal `window.__WORLDLINE_BOOT__` spelling. The stable wire name is the
  // smoke contract; its JavaScript receiver syntax is intentionally not.
  const hasBootManifest = html.includes('__WORLDLINE_BOOT__')
  if (!response.ok || !hasBootManifest) {
    throw new Error(`Desktop runtime smoke failed: HTTP ${response.status}, boot manifest=${hasBootManifest}`)
  }
  const browserResponse = await fetch(new URL('/worldline-browser?session=desktop-smoke', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'surface',
      surfaceId: 'desktop-smoke',
      active: true,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    }),
  })
  const browser = await browserResponse.json() as {
    available?: unknown
    tabs?: Array<{ id?: unknown; url?: unknown }>
  }
  if (
    !browserResponse.ok
    || browser.available !== true
    || browser.tabs?.length !== 0
  ) {
    throw new Error(
      `Desktop browser smoke failed: HTTP ${browserResponse.status}, snapshot=${JSON.stringify(browser)}`,
    )
  }
  const newPageResponse = await fetch(new URL('/worldline-browser?session=desktop-smoke', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'new' }),
  })
  const opened = await newPageResponse.json() as typeof browser
  const openedTab = opened.tabs?.[0]
  if (!newPageResponse.ok || openedTab?.url !== 'https://www.bilibili.com/' || typeof openedTab.id !== 'string') {
    throw new Error(
      `Desktop browser new-page smoke failed: HTTP ${newPageResponse.status}, snapshot=${JSON.stringify(opened)}`,
    )
  }
  const closeResponse = await fetch(new URL('/worldline-browser?session=desktop-smoke', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'close', tabId: openedTab.id }),
  })
  const closed = await closeResponse.json() as typeof browser
  if (!closeResponse.ok || closed.tabs?.length !== 0) {
    throw new Error(
      `Desktop browser close-page smoke failed: HTTP ${closeResponse.status}, snapshot=${JSON.stringify(closed)}`,
    )
  }
  await smokeBrowserRenderBlock()
  console.log(`worldline desktop smoke: ${url}`)
}

async function smokeBrowserRenderBlock(): Promise<void> {
  if (window === undefined) throw new Error('Desktop render-block smoke requires a window')
  const document = [
    '<!doctype html><html><body><canvas id="probe" width="12" height="8"></canvas>',
    '<script>document.getElementById("probe").getContext("2d").fillRect(0,0,4,4)</script>',
    '</body></html>',
  ].join('')
  const src = `${RENDER_DATA_PREFIX}${Buffer.from(document).toString('base64')}`
  const guestId = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const guest = document.createElement('webview');
    guest.setAttribute('partition', ${JSON.stringify(RENDER_WEBVIEW_PARTITION)});
    guest.setAttribute('src', ${JSON.stringify(src)});
    guest.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px';
    // The first guest process can take longer to warm up on a freshly unpacked
    // build while antivirus scans the Electron binaries and bundled runtime.
    // Keep the probe strict, but do not turn that one-time startup cost into a
    // false packaging failure.
    const timer = setTimeout(() => reject(new Error('render-block guest timed out')), 15000);
    guest.addEventListener('dom-ready', () => {
      clearTimeout(timer);
      resolve(guest.getWebContentsId());
    }, { once: true });
    guest.addEventListener('did-fail-load', (event) => {
      if (event.errorCode === -3) return;
      clearTimeout(timer);
      reject(new Error(event.errorDescription || 'render-block guest failed'));
    });
    document.body.append(guest);
  })`) as unknown
  if (typeof guestId !== 'number') throw new Error('render-block guest returned no WebContents id')
  const guest = electronWebContents.fromId(guestId)
  if (guest === undefined) throw new Error('render-block guest WebContents is unavailable')
  const probe = await guest.executeJavaScript(`({
    canvas: document.getElementById('probe') instanceof HTMLCanvasElement,
    node: typeof process,
  })`) as { canvas?: unknown; node?: unknown }
  if (
    probe.canvas !== true
    || probe.node !== 'undefined'
    || guest.session !== electronSession.fromPartition(RENDER_WEBVIEW_PARTITION)
  ) {
    throw new Error(`Desktop render-block smoke failed: ${JSON.stringify({ probe })}`)
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('webview[partition=${JSON.stringify(RENDER_WEBVIEW_PARTITION)}]')?.remove()`,
  )
}

async function createWindow(url: string, showOnReady = true, bootstrapToken?: string): Promise<void> {
  if (desktop === undefined) throw new Error('desktop context unavailable')
  window = desktop.desktopWindows.create({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: PRODUCT_NAME,
    icon: desktop.desktopAssets.iconIco(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      preload: join(import.meta.dirname, 'preload.cjs'),
    },
  })
  if (process.platform === 'win32') {
    window.setAppDetails(windowsAppDetails(desktop.desktopAssets.iconIco(), process.execPath))
  }
  window.setMenuBarVisibility(false)
  const appOrigin = new URL(url).origin
  window.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    desktopPermissionAllowed(permission, requestingOrigin, appOrigin))
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    let requestingOrigin = ''
    try { requestingOrigin = new URL(details.requestingUrl).origin } catch { /* invalid requests stay denied */ }
    callback(desktopPermissionAllowed(permission, requestingOrigin, appOrigin))
  })
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (isRenderWebviewAttachment(webPreferences, params)) {
      configureRenderWebPreferences(webPreferences)
      return
    }
    if (typeof params.src !== 'string' || !/^https?:\/\//iu.test(params.src)) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
  })
  window.webContents.on('did-attach-webview', (_event, contents) => {
    if (contents.session === electronSession.fromPartition(RENDER_WEBVIEW_PARTITION)) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('will-navigate', (event, target) => {
        if (!renderRequestAllowed(target)) event.preventDefault()
      })
      return
    }
    contents.setWindowOpenHandler(({ url: target }) => {
      embeddedBrowser?.enqueueNewPage(target)
      return { action: 'deny' }
    })
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    embeddedBrowser?.enqueueNewPage(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith(url)) return
    event.preventDefault()
    embeddedBrowser?.enqueueNewPage(target)
  })
  if (showOnReady) window.once('ready-to-show', () => window?.show())
  await window.loadURL(withAuthBootstrapFragment(url, bootstrapToken))
}

async function createStartupWindow(): Promise<BrowserWindow> {
  if (desktop === undefined) throw new Error('desktop context unavailable')
  const startup = desktop.desktopWindows.create({
    width: 520,
    height: 420,
    minWidth: 520,
    minHeight: 420,
    maximizable: false,
    resizable: false,
    // Create the native window visibly from the outset. In an installed
    // Windows GUI process, calling show() only after loading a data URL can be
    // ignored during the first NSIS launch before the renderer has obtained a
    // compositor frame, which leaves the application alive but invisible.
    show: true,
    title: `${PRODUCT_NAME} · 正在启动`,
    icon: desktop.desktopAssets.iconIco(),
    autoHideMenuBar: true,
    backgroundColor: '#f8fcff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  if (process.platform === 'win32') {
    startup.setAppDetails(windowsAppDetails(desktop.desktopAssets.iconIco(), process.execPath))
  }
  startup.setMenuBarVisibility(false)
  startup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await startup.loadURL(desktopStartupDataUrl(await readFile(desktop.desktopAssets.logoPng())))
  // The initial data: document is trusted and self-contained. Attach the
  // navigation guard only after it has loaded so it cannot cancel loadURL and
  // make a normal installer/launcher start fail with ERR_ABORTED.
  startup.webContents.on('will-navigate', (event) => { event.preventDefault() })
  // Show explicitly after loadURL resolves. This makes the normal installer
  // finish-page launch and the packaged startup probe deterministic even on
  // machines where ready-to-show is delayed by GPU initialization.
  startup.show()
  // BrowserWindow.show() schedules the native HWND transition. Packaged
  // Windows builds can therefore still report isVisible() === false in the
  // same microtask, especially on the first launch from the NSIS finish page.
  // Wait for the real native visibility state so callers never race ahead and
  // conclude that the installed application failed to open.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5_000
    const check = (): void => {
      if (startup.isDestroyed()) {
        reject(new Error('Desktop startup window was destroyed before it became visible'))
        return
      }
      if (startup.isVisible()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error('Desktop startup window did not become visible within 5 seconds'))
        return
      }
      setTimeout(check, 25)
    }
    check()
  })
  return startup
}

function configureRenderWebviewSession(): void {
  const preview = electronSession.fromPartition(RENDER_WEBVIEW_PARTITION)
  preview.setPermissionCheckHandler(() => false)
  preview.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
  preview.on('will-download', (event) => { event.preventDefault() })
  preview.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !renderRequestAllowed(details.url) })
  })
  preview.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const responseHeaders = embeddingResponseHeaders(details.responseHeaders)
    callback(responseHeaders === undefined ? {} : { responseHeaders })
  })
}

function runtimeLaunchRecipe(): RuntimeLaunchRecipe {
  if (desktop === undefined) throw new Error('desktop context unavailable')
  if (embeddedBrowserEndpoint === undefined) throw new Error('desktop browser bridge unavailable')
  const browserEndpoint = embeddedBrowserEndpoint
  return {
    options: async () => {
      const launch = await desktopTenantLaunch()
      runtimeBootstrapToken = launch.bootstrapToken
      return {
        cwd: app.getPath('home'),
        environment: {
          ...launch.environment,
          WORLDLINE_DESKTOP_BROWSER_BRIDGE_URL: browserEndpoint.url,
          WORLDLINE_DESKTOP_BROWSER_BRIDGE_TOKEN: browserEndpoint.token,
          WORLDLINE_VIDEO_TOOLS_DIR: app.isPackaged
            ? join(process.resourcesPath, 'tools')
            : join(import.meta.dirname, '..', '..', '..', 'resources', 'tools'),
        },
        ...(app.isPackaged ? { cliEntry: join(process.resourcesPath, 'runtime', 'lib', 'bin.js') } : {}),
      }
    },
    onRestarted: async (url) => {
      await window?.loadURL(withAuthBootstrapFragment(url, runtimeBootstrapToken))
    },
  }
}

function startDesktop(): void {
  app.setName(PRODUCT_NAME)
  // A source checkout launched by start-electron.bat must not reuse the installed
  // application's single-instance lock. Account/Profile data still comes from
  // ~/.worldline; Electron-local state stays in stable compatibility paths so
  // the visible product rename does not sign users out of browser sessions.
  app.setPath(
    'userData',
    join(
      app.getPath('appData'),
      app.isPackaged ? ELECTRON_USER_DATA_NAME : `${ELECTRON_USER_DATA_NAME} Development`,
    ),
  )
  const hasLock = app.requestSingleInstanceLock()
  if (!hasLock) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    desktop?.desktopRuntimeBridge.publish({ stage: 'stopping' })
    void Promise.all([
      desktop?.fiber.dispose() ?? Promise.resolve(),
      embeddedBrowser?.stop() ?? Promise.resolve(),
    ]).finally(() => { app.quit() })
  })

  app.on('window-all-closed', () => { app.quit() })

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    configureRenderWebviewSession()
    desktop = await createDesktopContext()
    const startupWindow = process.argv.includes(SMOKE_FLAG) ? undefined : await createStartupWindow()
    window = startupWindow
    if (process.argv.includes(STARTUP_SMOKE_FLAG)) {
      if (startupWindow === undefined || !startupWindow.isVisible()) {
        throw new Error('Packaged startup window did not become visible')
      }
      console.log(`worldline desktop startup smoke: visible, icon=${desktop.desktopAssets.iconIco()}`)
      quitting = true
      await desktop.fiber.dispose()
      app.exit(0)
      return
    }
    embeddedBrowser = new EmbeddedBrowserBridge(() => window)
    embeddedBrowserEndpoint = await embeddedBrowser.start()
    const currentDesktop = desktop
    currentDesktop.desktopRuntimeSupervisor.configure(runtimeLaunchRecipe())
    const url = await currentDesktop.desktopRuntimeSupervisor.start()
    if (process.argv.includes(SMOKE_FLAG)) {
      await createWindow(url, false, runtimeBootstrapToken)
      // A native WebContentsView only receives a live compositor surface once
      // its owner window is shown. Keep the smoke owner far off-screen while
      // exercising the same native browser path used by an interactive window.
      window?.setPosition(-32_000, -32_000)
      window?.showInactive()
      await smoke(url)
      desktop.desktopRuntimeBridge.publish({ stage: 'ready' })
      quitting = true
      await Promise.all([desktop.fiber.dispose(), embeddedBrowser.stop()])
      app.exit(0)
      return
    }
    await createWindow(url, true, runtimeBootstrapToken)
    startupWindow?.close()
    desktop.desktopRuntimeBridge.publish({ stage: 'ready' })
  }).catch(async (error: unknown) => {
    console.error('[desktop] startup failed:', error)
    desktop?.desktopRuntimeBridge.publish({
      stage: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    })
    quitting = true
    await Promise.all([
      desktop?.fiber.dispose() ?? Promise.resolve(),
      embeddedBrowser?.stop() ?? Promise.resolve(),
    ])
    app.exit(1)
  })
}

const delegatedBrowserHost = browserHostEntry()
if (delegatedBrowserHost === undefined) {
  startDesktop()
} else {
  // Do not acquire the desktop single-instance lock or create the application
  // window. This process belongs entirely to the installed browser plugin.
  await runBrowserHostEntry(delegatedBrowserHost)
}
