import { app, Menu, nativeImage, Tray, type BrowserWindow, type NativeImage } from "electron";

import { appIconImage } from "./app-icon";
import type { AppLocale } from "../shared/native-dialog-i18n";
import type { BotDesktopActivity } from "../shared/companion-bot-media";

type WindowsTrayOptions = {
  getMainWindow: () => BrowserWindow | undefined;
  onQuit: () => void;
  onStopRecording?: () => void;
  locale: AppLocale;
};

export type WindowsTrayController = {
  updateLocale: (locale: AppLocale) => void;
  updateRecording: (active: boolean) => void;
  updateCompanionActivity: (activity?: BotDesktopActivity) => void;
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

function captureBadge(icon: NativeImage) {
  const size = 16, pixels = icon.toBitmap({ scaleFactor: 1 });
  if (pixels.length !== size * size * 4) return icon;
  // Windows native bitmaps use BGRA. Give the red dot a white edge at tray size.
  for (let y = 7; y < size; y++) for (let x = 7; x < size; x++) {
    const distance = Math.hypot(x - 11.5, y - 11.5);
    if (distance <= 4.5) pixels.set(distance <= 3.3 ? [60, 57, 218, 255] : [255, 255, 255, 255], (y * size + x) * 4);
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
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

  const icon = image.resize({ width: 16, height: 16 });
  const tray = new Tray(icon);
  let markedIcon: NativeImage | undefined;
  let activity: BotDesktopActivity | undefined;
  let currentLocale = options.locale;
  let recording = false;

  const rebuildMenu = (locale: AppLocale): void => {
    currentLocale = locale;
    const labels = menuLabels(locale);
    const activityLabels = locale === 'zh-CN'
      ? { recording: '伙伴正在录屏', screenshot: '伙伴正在截图', captured: '伙伴刚刚已截图', observing: '伙伴正在分析本轮观察', listening: '伙伴正在听电脑声音' }
      : { recording: 'Companion is recording the screen', screenshot: 'Companion is taking a screenshot', captured: 'Companion took a screenshot', observing: 'Companion is reviewing this round', listening: 'Companion is listening to system audio' };
    const caption = activity && activityLabels[activity];
    tray.setToolTip(caption ? 'WorldlineBox · ' + caption : 'WorldlineBox');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(caption ? [{ label: caption, enabled: false }] : []),
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
    updateCompanionActivity: next => {
      if (next === activity || tray.isDestroyed()) return;
      if (!!next !== !!activity) tray.setImage(next ? markedIcon ??= captureBadge(icon) : icon);
      activity = next;
      rebuildMenu(currentLocale);
    },
    destroy: () => tray.destroy(),
  };
}

export function requestWindowsTrayQuit(): void {
  app.quit();
}
