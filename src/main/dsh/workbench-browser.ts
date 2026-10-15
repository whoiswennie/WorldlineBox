import { type BrowserWindow, shell } from 'electron';

export function isWorkbenchOrigin(value: string, origin: string): boolean {
  try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}
export function isExternalWorkbenchUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}
export function mayWriteWorkbenchClipboard(permission: string, currentUrl: string, requestingUrl: string, origin: string, isMainFrame: boolean): boolean {
  return permission === 'clipboard-sanitized-write' && isMainFrame && isWorkbenchOrigin(currentUrl, origin) && isWorkbenchOrigin(requestingUrl, origin);
}

/** The native UI preopens about:blank during a click, then navigates it after PKCE initialization. */
export function configureWorkbenchBrowser(window: BrowserWindow, readyUrl: string, options: {
  icon?: Electron.NativeImage; onIssue(message: string): void; openExternal?: (url: string) => Promise<void>;
}): void {
  const origin = new URL(readyUrl).origin; const contents = window.webContents;
  const open = (value: string) => {
    if (!isExternalWorkbenchUrl(value)) return;
    void (options.openExternal ?? shell.openExternal)(value).catch(() => options.onIssue('无法打开系统浏览器。可在 DSH 登录弹窗复制链接后手动打开。'));
  };
  contents.session.setPermissionCheckHandler((requester, permission, requestingOrigin, details) => requester === contents
    && mayWriteWorkbenchClipboard(permission, requester.getURL(), details.requestingUrl ?? requestingOrigin, origin, details.isMainFrame));
  contents.session.setPermissionRequestHandler((requester, permission, callback, details) => callback(requester === contents
    && mayWriteWorkbenchClipboard(permission, requester.getURL(), details.requestingUrl, origin, details.isMainFrame)));
  let popup: BrowserWindow | undefined; let opening = false;
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' && !opening && (!popup || popup.isDestroyed()) && isWorkbenchOrigin(contents.getURL(), origin)) {
      opening = true;
      return { action: 'allow', overrideBrowserWindowOptions: { parent: window, show: false, icon: options.icon, title: 'DSH 登录', autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } } };
    }
    open(url); return { action: 'deny' };
  });
  contents.on('did-create-window', child => {
    opening = false; popup = child; child.setMenu(null);
    const timer = setTimeout(() => { if (!child.isDestroyed()) child.destroy(); }, 120_000); timer.unref();
    child.once('closed', () => { clearTimeout(timer); if (popup === child) popup = undefined; });
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const navigate = (event: Electron.Event, value: string) => {
      if (value === 'about:blank') return;
      event.preventDefault(); open(value);
      if (!child.isDestroyed()) child.destroy();
    };
    child.webContents.on('will-navigate', navigate); child.webContents.on('will-redirect', navigate);
  });
  const navigate = (event: Electron.Event, value: string) => {
    if (isWorkbenchOrigin(value, origin)) return;
    event.preventDefault(); open(value);
  };
  contents.on('will-navigate', navigate); contents.on('will-redirect', navigate);
  window.once('closed', () => { if (popup && !popup.isDestroyed()) popup.destroy(); });
}
