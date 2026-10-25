import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

import {
  importFilesThroughBridge,
  electronLaunchEnv,
  resolveElectronAppPath,
  resolveElectronExecutablePath,
} from "./electron-test-helpers";

test.describe.configure({ timeout: 120_000 });

const platformDirectory = process.platform === "win32"
  ? "win32-x64"
  : process.platform === "darwin"
    ? "darwin-arm64"
    : "linux-x64";
const ffmpegPath = path.join(
  process.cwd(),
  "resources",
  "ffmpeg",
  platformDirectory,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);

const fixtureColors: Record<string, [number, number, number]> = {
  teal: [0, 128, 128],
  purple: [128, 0, 128],
};

// Bundled release ffmpeg builds omit the lavfi device, so synthesize raw
// frames and PCM audio in-process and feed them through raw demuxers.
function generateVideoFixture(outputPath: string, color: string): void {
  const [r, g, b] = fixtureColors[color] ?? [128, 128, 128];
  const width = 320;
  const height = 180;
  const fps = 30;
  const seconds = 6;
  const frame = Buffer.alloc(width * height * 3);
  for (let i = 0; i < frame.length; i += 3) {
    frame[i] = r;
    frame[i + 1] = g;
    frame[i + 2] = b;
  }
  const videoRawPath = `${outputPath}.rgb`;
  writeFileSync(videoRawPath, Buffer.concat(Array(fps * seconds).fill(frame)));
  const sampleRate = 48_000;
  const audio = Buffer.alloc(sampleRate * seconds * 2);
  for (let i = 0; i < sampleRate * seconds; i += 1) {
    audio.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2);
  }
  const audioRawPath = `${outputPath}.pcm`;
  writeFileSync(audioRawPath, audio);
  try {
    execFileSync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps),
      "-i", videoRawPath,
      "-f", "s16le", "-ar", String(sampleRate), "-ac", "1",
      "-i", audioRawPath,
      "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k",
      "-pix_fmt", "yuv420p",
      "-c:a", "libopus", "-b:a", "64k",
      "-shortest",
      outputPath,
    ], { timeout: 60_000 });
  } finally {
    rmSync(videoRawPath, { force: true });
    rmSync(audioRawPath, { force: true });
  }
}

async function menuItemState(
  application: Awaited<ReturnType<typeof electron.launch>>,
  id: string,
): Promise<{ accelerator: string | null; enabled: boolean } | null> {
  return application.evaluate(({ Menu }, itemId) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.id === itemId) return item;
        const nested = find(item.submenu?.items ?? []);
        if (nested) return nested;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    return item
      ? { accelerator: item.accelerator ?? null, enabled: item.enabled }
      : null;
  }, id);
}

async function sendMainShortcutInput(
  application: Awaited<ReturnType<typeof electron.launch>>,
  keyCode: string,
  modifiers: Array<"alt" | "control" | "meta" | "shift">,
): Promise<void> {
  await application.evaluate(({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) throw new Error("The shortcut test window is unavailable.");
    window.webContents.sendInputEvent({ type: "keyDown", ...input });
    window.webContents.sendInputEvent({ type: "keyUp", ...input });
  }, { keyCode, modifiers });
}

async function openShortcutSettings(
  window: Page,
): Promise<void> {
  // WorldlineBox exposes global settings in the outer application rail.
  await window.locator(".application-navigation-settings").click();
  await window.getByRole("dialog", { name: "通用设置" }).waitFor();
  await window.getByRole("tab", { name: "快捷键", exact: true }).click();
}

async function setShortcutFromSettings(
  window: Page,
  actionName: string,
  keyboardChord: string,
  expectedLabel: string,
): Promise<void> {
  const search = window.getByRole("searchbox", { name: "搜索动作或按键" });
  await search.fill(actionName);
  const row = window.locator(".shortcut-settings-row").filter({ hasText: actionName });
  await row.getByRole("button", { name: "更改" }).click();
  await window.keyboard.press(keyboardChord);
  await row.getByRole("button", { name: "确认" }).click();
  await expect(row.locator(".shortcut-keycap")).toHaveText(expectedLabel);
}

async function dispatchMouseButton(
  window: Page,
  button: "back" | "forward",
  x: number,
  y: number,
  modifiers = 2,
): Promise<void> {
  const session = await window.context().newCDPSession(window);
  try {
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      modifiers,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      modifiers,
    });
  } finally {
    await session.detach();
  }
}

async function setMouseShortcutFromSettings(
  window: Page,
  actionName: string,
  button: "back" | "forward",
  expectedLabel: string,
): Promise<void> {
  const search = window.getByRole("searchbox", { name: "搜索动作或按键" });
  await search.fill(actionName);
  const row = window.locator(".shortcut-settings-row").filter({ hasText: actionName });
  await row.getByRole("button", { name: "更改" }).click();
  const capture = row.locator(".shortcut-capture-input");
  await expect(capture).toBeVisible();
  const box = await capture.boundingBox();
  if (!box) throw new Error("The shortcut recorder had no visible bounds.");
  await dispatchMouseButton(
    window,
    button,
    box.x + box.width / 2,
    box.y + box.height / 2,
  );
  await expect(capture).toHaveText(expectedLabel);
  await row.getByRole("button", { name: "确认" }).click();
  await expect(row.locator(".shortcut-keycap")).toHaveText(expectedLabel);
}

test.skip(!existsSync(ffmpegPath), "requires the repository FFmpeg fixture generator");

test("custom menu accelerators sync, yield to text inputs, and viewer keys run once in scope", async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "worldlinebox-shortcut-runtime-e2e-"));
  const libraryName = "Shortcut Runtime";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const mediaPath = path.join(temporaryRoot, "shortcut-clip.webm");
  const secondMediaPath = path.join(temporaryRoot, "shortcut-second.webm");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    generateVideoFixture(mediaPath, "teal");
    generateVideoFixture(secondMediaPath, "purple");
    const applicationDirectory = resolveElectronAppPath();
    application = await electron.launch({
      args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [applicationDirectory],
      cwd: applicationDirectory,
      executablePath: resolveElectronExecutablePath(),
      env: electronLaunchEnv({
        ...process.env,
        WORLDLINEBOX_E2E: "1",
        WORLDLINEBOX_E2E_HIDE_WINDOW: "1",
        WORLDLINEBOX_E2E_SHOW_INACTIVE: "1",
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
        WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
        WORLDLINEBOX_E2E_IMPORT_FILES: [mediaPath, secondMediaPath].join(path.delimiter),
        WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, "profile"),
        WORLDLINEBOX_FFMPEG_PATH: ffmpegPath,
      }),
    });

    await application.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { properties?: string[] };
        return { canceled: false, filePaths: options.properties?.includes('multiSelections')
          ? [fixture.mediaPath, fixture.secondMediaPath] : [fixture.temporaryRoot] };
      };
    }, { temporaryRoot, mediaPath, secondMediaPath });
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const window = await application.firstWindow();
    await expect(window.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    await window.locator('[data-application-module="assets"]').click();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await importFilesThroughBridge(window);
    const asset = window.locator('[data-asset-id][data-asset-name="shortcut-clip.webm"]');
    const secondAsset = window.locator('[data-asset-id][data-asset-name="shortcut-second.webm"]');
    await expect(asset).toBeVisible({ timeout: 30_000 });
    await expect(secondAsset).toBeVisible({ timeout: 30_000 });
    const cards = window.locator(".asset-card[data-asset-id]");
    const firstCard = cards.first();
    const firstName = await firstCard.getAttribute("data-asset-name");
    const secondName = await cards.nth(1).getAttribute("data-asset-name");
    if (!firstName || !secondName) throw new Error("Expected two imported viewer assets.");
    const firstViewer = window.getByRole("region", { name: `${firstName} 查看页面` });
    const secondViewer = window.getByRole("region", { name: `${secondName} 查看页面` });

    // Verify the shipped arrow defaults before replacing them in settings.
    await firstCard.dblclick();
    const defaultVideo = firstViewer.locator("video.preview-video");
    await expect.poll(() => defaultVideo.evaluate((element) => {
      const media = element as HTMLVideoElement;
      return media.readyState >= HTMLMediaElement.HAVE_METADATA
        && media.videoWidth > 0
        && media.duration > 1;
    }), { timeout: 30_000 }).toBe(true);
    await window.keyboard.press("ArrowRight");
    await expect(secondViewer).toBeVisible();
    await window.keyboard.press("ArrowLeft");
    await expect(firstViewer).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(firstViewer).toBeHidden();

    const platform = process.platform === "darwin" ? "mac" : "windows";
    const commandModifier = platform === "mac" ? "Meta" : "Control";
    await openShortcutSettings(window);
    await setShortcutFromSettings(
      window,
      "撤销上次操作",
      `${commandModifier}+Y`,
      platform === "mac" ? "⌘+Y" : "Ctrl+Y",
    );
    // Keep all four video-only fallback letters out of the bare-key set while
    // leaving play/pause as a letter. Main must arm from the active catalog
    // route itself rather than depending on D/F/X/C still being unmodified.
    await setShortcutFromSettings(
      window,
      "上一帧",
      "Control+Shift+F1",
      platform === "mac" ? "⌃⇧F1" : "Ctrl+Shift+F1",
    );
    await setShortcutFromSettings(
      window,
      "下一帧",
      "Control+Shift+F2",
      platform === "mac" ? "⌃⇧F2" : "Ctrl+Shift+F2",
    );
    await setShortcutFromSettings(
      window,
      "减慢播放",
      "Control+Shift+F3",
      platform === "mac" ? "⌃⇧F3" : "Ctrl+Shift+F3",
    );
    await setShortcutFromSettings(
      window,
      "加快播放",
      "Control+Shift+F4",
      platform === "mac" ? "⌃⇧F4" : "Ctrl+Shift+F4",
    );
    await setShortcutFromSettings(window, "播放/暂停", "p", "P");
    await setShortcutFromSettings(window, "适合窗口", "F6", "F6");
    await setShortcutFromSettings(
      window,
      "切换全屏",
      `${commandModifier}+Shift+F12`,
      platform === "mac" ? "⌘⇧F12" : "Ctrl+Shift+F12",
    );
    await setShortcutFromSettings(
      window,
      "查看上一个资产",
      `${commandModifier}+Shift+F9`,
      platform === "mac" ? "⌘⇧F9" : "Ctrl+Shift+F9",
    );
    await setShortcutFromSettings(
      window,
      "查看下一个资产",
      `${commandModifier}+Shift+F10`,
      platform === "mac" ? "⌘⇧F10" : "Ctrl+Shift+F10",
    );
    await setMouseShortcutFromSettings(
      window,
      "重命名资产",
      "back",
      platform === "mac" ? "⌃鼠标后退" : "Ctrl+鼠标后退",
    );
    const fullscreenMenuItemId = platform === "mac"
      ? "window.toggle-fullscreen"
      : "shortcut.window.toggle-fullscreen.0";
    await expect.poll(() => menuItemState(application!, fullscreenMenuItemId))
      .toMatchObject({ enabled: false });
    await window
      .getByRole("dialog", { name: "通用设置" })
      .getByRole("button", { name: "关闭" })
      .click();

    await expect.poll(() => menuItemState(application!, fullscreenMenuItemId))
      .toMatchObject({ accelerator: platform === "mac" ? "Cmd+Shift+F12" : "Ctrl+Shift+F12" });
    await expect.poll(() => menuItemState(application!, fullscreenMenuItemId))
      .toMatchObject({ enabled: true });
    await window.evaluate(() => {
      const shell = (window as unknown as {
        worldlinebox?: {
          shell?: {
            onApplicationMenuCommand(listener: (command: { command: string }) => void): () => void;
          };
        };
      }).worldlinebox?.shell;
      shell?.onApplicationMenuCommand(({ command }) => {
        if (command !== "window.toggle-fullscreen") return;
        const target = window as unknown as { __fullscreenShortcutCommandCount?: number };
        target.__fullscreenShortcutCommandCount = (target.__fullscreenShortcutCommandCount ?? 0) + 1;
      });
    });
    const fullscreenState = () => application!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())?.isFullScreen() ?? false,
    );
    const fullscreenCommandCount = () => window.evaluate(() =>
      (window as unknown as { __fullscreenShortcutCommandCount?: number })
        .__fullscreenShortcutCommandCount ?? 0,
    );
    await sendMainShortcutInput(
      application,
      "F12",
      [platform === "mac" ? "meta" : "control", "shift"],
    );
    await expect.poll(fullscreenCommandCount).toBe(1);
    await expect.poll(fullscreenState).toBe(true);
    // The main-process menu/renderer path intentionally coalesces one physical
    // chord observed through both routes inside a 50 ms window. This is a
    // second user action, so keep it outside that de-duplication window.
    await window.waitForTimeout(75);
    await sendMainShortcutInput(
      application,
      "F12",
      [platform === "mac" ? "meta" : "control", "shift"],
    );
    await expect.poll(fullscreenCommandCount).toBe(2);
    await expect.poll(fullscreenState).toBe(false);

    const nativeUndoId = process.platform === "darwin"
      ? "edit.undo"
      : "shortcut.edit.undo.0";
    const nativeUndoAccelerator = platform === "mac" ? "Cmd+Y" : "Ctrl+Y";
    await expect.poll(() => menuItemState(application!, nativeUndoId))
      .toMatchObject({ accelerator: nativeUndoAccelerator });

    if (process.platform !== "darwin") {
      await window.locator(".main-menu-trigger").click();
      await window.locator('[data-main-menu-section-id="edit"]').hover();
      await expect(
        window.locator('[data-main-menu-item-id="edit.undo"] .main-menu-item-shortcut'),
      ).toHaveText("Ctrl+Y");
      await window.keyboard.press("Escape");

      await expect.poll(() => menuItemState(application!, "shortcut.selection.select-all.0"))
        .toMatchObject({ enabled: true });
    }

    const search = window.locator('input[role="combobox"]').first();
    await search.fill("copied from the input");
    await search.focus();
    await expect.poll(() => menuItemState(application!, fullscreenMenuItemId))
      .toMatchObject({ enabled: false });
    if (process.platform !== "darwin") {
      await expect.poll(() => menuItemState(application!, "shortcut.selection.select-all.0"))
        .toMatchObject({ enabled: false });
    }
    await window.keyboard.press(`${commandModifier}+A`);
    await expect.poll(() => search.evaluate((element) => {
      const input = element as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd];
    })).toEqual([0, "copied from the input".length]);
    await window.keyboard.press(`${commandModifier}+C`);
    await search.fill("replace me");
    await window.keyboard.press(`${commandModifier}+A`);
    await window.keyboard.press(`${commandModifier}+V`);
    await expect(search).toHaveValue("copied from the input");

    await search.fill("");
    await search.evaluate((element) => (element as HTMLElement).blur());
    await asset.click();
    const assetBox = await asset.boundingBox();
    if (!assetBox) throw new Error("The asset card had no visible bounds.");
    await dispatchMouseButton(
      window,
      "back",
      assetBox.x + assetBox.width / 2,
      assetBox.y + assetBox.height / 2,
    );
    const renameInput = asset.locator(".asset-inline-rename-input");
    await expect(renameInput).toBeVisible();
    await renameInput.press("Escape");
    await expect(renameInput).toBeHidden();

    await expect(asset).toBeVisible();
    await firstCard.dblclick();
    const viewer = firstViewer;
    const video = viewer.locator("video.preview-video");
    await expect.poll(() => video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      return media.readyState >= HTMLMediaElement.HAVE_METADATA
        && media.videoWidth > 0
        && media.duration > 1;
    }), { timeout: 30_000 }).toBe(true);
    await search.evaluate((element) => (element as HTMLElement).focus());
    await expect(search).toBeFocused();
    await window.keyboard.press(`${commandModifier}+Shift+F10`);
    await expect(firstViewer).toBeVisible();
    await expect(search).toBeFocused();
    await search.evaluate((element) => (element as HTMLElement).blur());
    await window.keyboard.press(`${commandModifier}+Shift+F10`);
    await expect(secondViewer).toBeVisible();
    await window.keyboard.press(`${commandModifier}+Shift+F9`);
    await expect(firstViewer).toBeVisible();

    await openShortcutSettings(window);
    await window.keyboard.press(`${commandModifier}+Shift+F10`);
    await expect(firstViewer).toBeVisible();
    await window
      .getByRole("dialog", { name: "通用设置" })
      .getByRole("button", { name: "关闭" })
      .click();
    await expect(firstViewer).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(firstViewer).toBeHidden();
    await openShortcutSettings(window);
    await setMouseShortcutFromSettings(
      window,
      "查看下一个资产",
      "forward",
      platform === "mac" ? "⌃鼠标前进" : "Ctrl+鼠标前进",
    );
    await setMouseShortcutFromSettings(
      window,
      "查看上一个资产",
      "back",
      platform === "mac" ? "⌃鼠标后退" : "Ctrl+鼠标后退",
    );
    await window
      .getByRole("dialog", { name: "通用设置" })
      .getByRole("button", { name: "关闭" })
      .click();
    await firstCard.dblclick();
    await expect(firstViewer).toBeVisible();
    const mouseViewer = firstViewer.locator("video.preview-video");
    const mouseViewerBox = await mouseViewer.boundingBox();
    if (!mouseViewerBox) throw new Error("The viewer video had no visible bounds.");
    await dispatchMouseButton(
      window,
      "forward",
      mouseViewerBox.x + mouseViewerBox.width / 2,
      mouseViewerBox.y + mouseViewerBox.height / 2,
    );
    await expect(secondViewer).toBeVisible();
    await dispatchMouseButton(
      window,
      "back",
      mouseViewerBox.x + mouseViewerBox.width / 2,
      mouseViewerBox.y + mouseViewerBox.height / 2,
    );
    await expect(firstViewer).toBeVisible();

    if (process.platform !== "darwin") {
      await expect.poll(() => menuItemState(application!, nativeUndoId))
        .toMatchObject({ enabled: true });
    }
    // Pause through the player's action so its user-paused intent survives
    // the canplay/seeked events caused by seeking below.
    if (!await video.evaluate((element) => (element as HTMLVideoElement).paused)) {
      await viewer.getByRole("button", { name: "暂停", exact: true })
        .evaluate((button) => (button as HTMLButtonElement).click());
    }
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused)).toBe(true);
    await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      media.currentTime = 2.5;
      media.playbackRate = 1;
    });
    await viewer
      .getByRole("button", { name: "播放", exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect.poll(() => video.evaluate((element) =>
      (element as HTMLVideoElement).paused,
    )).toBe(false);
    if (process.platform !== "darwin") {
      await expect.poll(() => menuItemState(application!, "shortcut.viewer.media.play-pause"))
        .toMatchObject({ accelerator: "P", enabled: true });
    }
    await sendMainShortcutInput(application, "P", []);
    await expect.poll(() => video.evaluate((element) =>
      (element as HTMLVideoElement).paused,
    )).toBe(true);
    if (platform !== "mac") {
      await expect.poll(() => menuItemState(application!, "shortcut.viewer.video.rate-faster"))
        .toMatchObject({ accelerator: "Ctrl+Shift+F4", enabled: true });
    }
    await sendMainShortcutInput(application, "F4", ["control", "shift"]);
    await expect.poll(() => video.evaluate((element) =>
      (element as HTMLVideoElement).playbackRate,
    )).toBe(1.5);
    await window.waitForTimeout(75);
    await sendMainShortcutInput(application, "F4", ["control", "shift"]);
    await expect.poll(() => video.evaluate((element) =>
      (element as HTMLVideoElement).playbackRate,
    )).toBe(2);

    const currentRate = await video.evaluate((element) =>
      (element as HTMLVideoElement).playbackRate,
    );
    await search.evaluate((element) => (element as HTMLElement).focus());
    await expect.poll(() => search.evaluate((element) => document.activeElement === element))
      .toBe(true);
    await window.keyboard.press("k");
    await expect(search).toHaveValue("k");
    await expect.poll(() => video.evaluate((element) =>
      (element as HTMLVideoElement).playbackRate,
    )).toBe(currentRate);
    if (process.platform !== "darwin") {
      await expect.poll(() => menuItemState(application!, "shortcut.selection.select-all.0"))
        .toMatchObject({ enabled: false });
    }

    await search.fill("");
    await search.evaluate((element) => (element as HTMLElement).blur());
    await expect.poll(() => menuItemState(application!, fullscreenMenuItemId))
      .toMatchObject({ enabled: true });
    await window.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await window.keyboard.press("k");
    await expect(viewer).toBeHidden();
    await expect(asset).toBeVisible();
  } finally {
    await application?.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await application?.close().catch(() => undefined);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
