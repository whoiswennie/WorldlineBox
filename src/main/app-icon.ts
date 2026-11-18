import { existsSync, renameSync } from "node:fs";
import path from "node:path";

import { app, nativeImage, shell, type BrowserWindow, type BrowserWindowConstructorOptions, type NativeImage } from "electron";

import { resolveAppIconCandidates } from "./app-icon-paths";

export function appIconImage(): NativeImage | undefined {
  const candidates = resolveAppIconCandidates({
    cwd: process.cwd(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
  }).map((candidate) => path.normalize(candidate));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image;
  }
  return undefined;
}

/** Native children share the main window's packaged/development icon resolver. */
export function withAppWindowIcon<T extends BrowserWindowConstructorOptions>(options: T): T & Pick<BrowserWindowConstructorOptions, 'icon'> {
  if (options.icon !== undefined) return options;
  const icon = appIconImage();
  return icon ? { ...options, icon } : options;
}

export function applyDevAppIcon(): void {
  const image = appIconImage();
  if (!image) return;
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(image);
  }
}

export const WINDOWS_APP_ID = 'com.worldlinebox.app';
const toastClsid = '{24BC5C0E-9196-41EA-90D5-8037889B7B7D}';

export function registerWindowsSender() {
  if (process.platform !== 'win32') return;
  app.setAppUserModelId(WINDOWS_APP_ID);
  app.setToastActivatorCLSID(toastClsid);
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const link = path.join(programs, '世界线盒子.lnk');
  const appPath = app.getAppPath();
  // Test builds share the checkout's executable and Windows sender identity.
  const project = !app.isPackaged && process.env.WORLDLINEBOX_E2E === '1'
    && path.basename(appPath) === 'e2e-app' && path.basename(path.dirname(appPath)) === '.tools'
    ? path.resolve(appPath, '..', '..') : appPath;
  const icon = path.join(app.isPackaged ? process.resourcesPath : path.join(project, 'assets', 'icons'), 'app.ico');
  // Only migrate the old shortcut if BOTH its app ID and executable belong to this checkout.
  const legacy = path.join(programs, app.isPackaged ? 'WorldlineBox.lnk' : 'Electron.lnk');
  const old = existsSync(legacy) ? shell.readShortcutLink(legacy) : undefined;
  if (old?.appUserModelId === WINDOWS_APP_ID && path.resolve(old.target).toLowerCase() === process.execPath.toLowerCase()) {
    if (!existsSync(link)) renameSync(legacy, link);
    else void shell.trashItem(legacy).catch(() => undefined);
  }
  const details = { target: process.execPath, cwd: path.dirname(process.execPath),
    args: app.isPackaged ? '' : '"' + project + '"', icon, iconIndex: 0,
    description: '世界线盒子', appUserModelId: WINDOWS_APP_ID, toastActivatorClsid: toastClsid };
  const current = existsSync(link) ? shell.readShortcutLink(link) : undefined;
  if (current && current.appUserModelId !== WINDOWS_APP_ID) return;
  if (!current || current.target !== details.target || current.icon !== icon || current.args !== details.args ||
      current.toastActivatorClsid?.toUpperCase() !== toastClsid) {
    if (!shell.writeShortcutLink(link, current ? 'update' : 'create', details)) throw new Error('无法登记 Windows 通知快捷方式。');
  }
}

/** Windows' grouped taskbar icon uses relaunch metadata, independently of the
 * HWND/title-bar image. Dev electron.exe otherwise supplies its stock icon. */
export function applyWindowsTaskbarIcon(window:BrowserWindow):void {
  if(process.platform!=='win32')return;
  const icon=path.join(app.isPackaged?process.resourcesPath:path.join(process.cwd(),'assets','icons'),'app.ico');
  if(!existsSync(icon))return;
  window.setAppDetails({appId:WINDOWS_APP_ID,appIconPath:icon,appIconIndex:0,relaunchDisplayName:'WorldlineBox',
    relaunchCommand:`"${process.execPath}"${app.isPackaged?'':` "${app.getAppPath()}"`}`});
}
