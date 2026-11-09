import { existsSync } from "node:fs";
import path from "node:path";

import { app, nativeImage, type BrowserWindow, type BrowserWindowConstructorOptions, type NativeImage } from "electron";

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

/** Windows' grouped taskbar icon uses relaunch metadata, independently of the
 * HWND/title-bar image. Dev electron.exe otherwise supplies its stock icon. */
export function applyWindowsTaskbarIcon(window:BrowserWindow):void {
  if(process.platform!=='win32')return;
  const icon=path.join(app.isPackaged?process.resourcesPath:path.join(process.cwd(),'assets','icons'),'app.ico');
  if(!existsSync(icon))return;
  window.setAppDetails({appId:'com.worldlinebox.app',appIconPath:icon,appIconIndex:0,relaunchDisplayName:'WorldlineBox',
    relaunchCommand:`"${process.execPath}"${app.isPackaged?'':` "${app.getAppPath()}"`}`});
}
