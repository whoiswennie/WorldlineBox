import { app, Menu, Tray, type BrowserWindow } from "electron";

import { appIconImage } from "./app-icon";
import type { AppLocale } from "../shared/native-dialog-i18n";

type WindowsTrayOptions = {
  getMainWindow: () => BrowserWindow | undefined;
  onQuit: () => void;
  onStopRecording?: () => void;
  locale: AppLocale;
};

export type WindowsTrayController = {
  updateLocale: (locale: AppLocale) => void;
  updateRecording: (active: boolean) => void;
  destroy: () => void;
};

function restoreMainWindow(getMainWindow: WindowsTrayOptions["getMainWindow"]): void {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function menuLabels(locale: AppLocale): { show: string; quit: string } {
  return locale === "zh-CN"
    ? { show: "显示 WorldlineBox", quit: "退出 WorldlineBox" }
    : { show: "Show WorldlineBox", quit: "Quit WorldlineBox" };
}

/**
 * Windows-only notification-area integration. Closing the custom caption hides
 * the window, while this menu provides the discoverable way to show it again or
 * explicitly quit the process. Portable Electron apps support Tray just like
 * installed apps; no installer registration is required.
 */
export function createWindowsTray(
  options: WindowsTrayOptions,
): WindowsTrayController | undefined {
  if (process.platform !== "win32") return undefined;
  const image = appIconImage();
  if (!image) return undefined;

  const tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip("WorldlineBox");
  let currentLocale = options.locale;
  let recording = false;

  const rebuildMenu = (locale: AppLocale): void => {
    currentLocale = locale;
    const labels = menuLabels(locale);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: labels.show,
          click: () => restoreMainWindow(options.getMainWindow),
        },
        ...(options.onStopRecording ? [{
          label: locale === "zh-CN" ? "停止录屏并保存" : "Stop recording and save",
          enabled: recording,
          click: options.onStopRecording,
        }] : []),
        { type: "separator" },
        { label: labels.quit, click: options.onQuit },
      ]),
    );
  };

  tray.on("click", () => restoreMainWindow(options.getMainWindow));
  tray.on("double-click", () => restoreMainWindow(options.getMainWindow));
  rebuildMenu(options.locale);

  return {
    updateLocale: rebuildMenu,
    updateRecording: active => { if (recording === active) return; recording = active; rebuildMenu(currentLocale); },
    destroy: () => tray.destroy(),
  };
}

export function requestWindowsTrayQuit(): void {
  app.quit();
}
