import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CaptureImageSource, CaptureToolsRequest, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi } };
type Rect = { x: number; y: number; width: number; height: number };
async function request(page: Page, input: CaptureToolsRequest) {
  const result = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.captureTools.request(input), input);
  if (!result.ok) throw Error(result.error); return result;
}
async function crop(page: Page): Promise<Rect> {
  const value = await page.locator('.desktop-screenshot-selection').getAttribute('data-pixel-crop');
  if (!value) throw Error('The inline selection did not expose its physical pixel crop');
  return JSON.parse(value) as Rect;
}
function physicalRect(source: CaptureImageSource, bounds: Rect): Rect {
  const desktop = source.desktop; if (!desktop) throw Error('Expected a real desktop screenshot');
  const sx = source.width / desktop.bounds.width; const sy = source.height / desktop.bounds.height;
  return { x: Math.round((bounds.x - desktop.bounds.x) * sx), y: Math.round((bounds.y - desktop.bounds.y) * sy),
    width: Math.round(bounds.width * sx), height: Math.round(bounds.height * sy) };
}
function expectRect(actual: Rect, expected: Rect) {
  for (const axis of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(actual[axis] - expected[axis]), `${axis} should match native desktop pixels`).toBeLessThanOrEqual(2);
}
function nativeScreenshotShortcut() {
  // Send a real Windows key chord while an ordinary native fixture owns focus.
  // webContents.sendInputEvent would only exercise a renderer event, bypassing
  // the OS globalShortcut registration that the user actually invokes.
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedScreenshotShortcut {
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static void Send() {
    byte[] keys = { 0x11, 0x12, 0x10, 0x79 };
    try { foreach(byte key in keys) keybd_event(key, 0, 0, UIntPtr.Zero); }
    finally { for(int i=keys.Length-1;i>=0;i--) keybd_event(keys[i], 0, 2, UIntPtr.Zero); }
  }
}
'@
[OwnedScreenshotShortcut]::Send()`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (result.status !== 0) throw Error('The owned native screenshot shortcut failed: ' + result.stderr);
}
function cleanup(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-inline-screenshot-')) throw Error('Unexpected inline screenshot fixture cleanup path');
  rmSync(resolved, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
}

// The independently sized native fixture makes smart-window selection
// deterministic. The captured source remains desktopCapturer's actual screen;
// this test does not supply a fake bitmap, fake window list or fake stream.
// eslint-disable-next-line no-empty-pattern
test('a real global shortcut opens inline desktop selection, smart window/workarea/screen clicks and free drag editing copy the selected pixels', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Smart native window bounds and the real global shortcut are verified on Windows.');
  test.setTimeout(150000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-inline-screenshot-')); const profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined; let failed = false; let cleanupError: unknown;
  let clipboardBefore: { text: string; html: string; rtf: string; image: string } | undefined;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(),
      args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'hardware' }) });
    const main = await application.firstWindow();
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    const state = (await request(main, { type: 'state' })).state!;
    const configured = (await request(main, { type: 'settings.save', settings: { ...state.settings, hideApp: false,
      shortcuts: { ...state.settings.shortcuts, screenshot: 'Control+Alt+Shift+F10' } } })).state!;
    expect(configured.shortcuts.find(shortcut => shortcut.task === 'screenshot')).toMatchObject({ registered: true, accelerator: 'Control+Alt+Shift+F10' });
    const fixture = await application.evaluate(async ({ BrowserWindow, screen }) => {
      const monitor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); const work = monitor.workArea;
      const bounds = { x: work.x + 50, y: work.y + 50, width: Math.min(640, work.width - 100), height: Math.min(440, work.height - 100) };
      const window = new BrowserWindow({ ...bounds, title: 'Inline Desktop Smart Window Fixture', frame: false, show: false,
        backgroundColor: '#20617d', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><title>Inline Desktop Smart Window Fixture</title></head><body style="margin:0;background:#20617d;color:#fff;font:28px Segoe UI"><h1 style="padding:32px">Native window selection</h1><p style="padding:32px">A real ordinary desktop window.</p></body></html>'));
      window.setAlwaysOnTop(true, 'floating'); window.show(); window.moveTop(); window.focus();
      return { id: window.id, bounds: window.getBounds(), displayId: String(monitor.id), workArea: work, screenBounds: monitor.bounds };
    });
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(fixture.id);
    nativeScreenshotShortcut();
    await expect.poll(() => application!.windows().some(page => page.url().includes('window=capture-tools')), { timeout: 20000 }).toBe(true);
    const tool = application.windows().find(page => page.url().includes('window=capture-tools'))!;
    await expect(tool.locator('.desktop-screenshot-overlay')).toBeVisible();
    await expect(tool.getByRole('dialog', { name: '截图工作台', exact: true })).toHaveCount(0);
    const source = (await request(tool, { type: 'context' })).source!;
    expect(source.desktop?.displayId).toBe(fixture.displayId);
    const candidate = source.desktop?.candidates.find(candidate => candidate.kind === 'window' && candidate.name === 'Inline Desktop Smart Window Fixture');
    expect(candidate, 'The ordinary native fixture must be enumerated by the product').toBeTruthy();
    expectRect(candidate!.bounds, fixture.bounds);
    const point = { x: fixture.bounds.x - fixture.screenBounds.x + fixture.bounds.width / 2,
      y: fixture.bounds.y - fixture.screenBounds.y + fixture.bounds.height / 2 };
    await tool.mouse.move(point.x, point.y);
    await expect(tool.locator('.desktop-screenshot-hover')).toHaveAttribute('data-candidate-id', candidate!.id);
    await tool.mouse.click(point.x, point.y);
    await expect(tool.locator('.desktop-screenshot-toolbar')).toBeVisible();
    expectRect(await crop(tool), physicalRect(source, candidate!.bounds));
    const windowCrop = await crop(tool);
    // Native work-area/screen candidates explicitly cover excluding/including the
    // taskbar. Wheel navigation changes a real candidate before a simple click.
    const selectCandidate = async (kind: 'workarea' | 'screen') => {
      await tool.getByRole('button', { name: '重新选择', exact: true }).click(); await tool.mouse.move(point.x, point.y);
      const hover = tool.locator('.desktop-screenshot-hover');
      for (let step = 0; step <= source.desktop!.candidates.length; step++) {
        if (await hover.getAttribute('data-candidate-kind') === kind) break;
        const previous = await hover.getAttribute('data-candidate-id');
        await tool.mouse.wheel(0, 120);
        await expect(hover).not.toHaveAttribute('data-candidate-id', previous!);
      }
      await expect(hover).toHaveAttribute('data-candidate-kind', kind);
      await tool.mouse.click(point.x, point.y);
      await expect(tool.locator('.desktop-screenshot-toolbar')).toBeVisible();
      const expected = kind === 'screen' ? fixture.screenBounds : fixture.workArea;
      expectRect(await crop(tool), physicalRect(source, expected));
      return crop(tool);
    };
    const workAreaCrop = await selectCandidate('workarea'); const screenCrop = await selectCandidate('screen');
    expect(screenCrop).toEqual({ x: 0, y: 0, width: source.width, height: source.height });
    await tool.getByRole('button', { name: '重新选择', exact: true }).click();
    const from = { x: Math.floor(fixture.bounds.width * .15) + point.x - fixture.bounds.width / 2,
      y: Math.floor(fixture.bounds.height * .18) + point.y - fixture.bounds.height / 2 };
    const to = { x: from.x + Math.floor(fixture.bounds.width * .55), y: from.y + Math.floor(fixture.bounds.height * .55) };
    await tool.mouse.move(from.x, from.y); await tool.mouse.down(); await tool.mouse.move(to.x, to.y, { steps: 8 }); await tool.mouse.up();
    await expect(tool.locator('.desktop-screenshot-toolbar')).toBeVisible();
    const dragged = await crop(tool);
    expectRect(dragged, physicalRect(source, { x: from.x + fixture.screenBounds.x, y: from.y + fixture.screenBounds.y, width: to.x - from.x, height: to.y - from.y }));
    expect(dragged.width).toBeLessThan(windowCrop.width); expect(dragged.height).toBeLessThan(windowCrop.height);
    const resize = await tool.locator('[data-resize-handle="se"]').boundingBox(); if (!resize) throw Error('Missing inline selection resize handle');
    await tool.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2); await tool.mouse.down();
    await tool.mouse.move(resize.x + resize.width / 2 + 24, resize.y + resize.height / 2 + 20, { steps: 5 }); await tool.mouse.up();
    const resized = await crop(tool);
    expect(resized.x).toBe(dragged.x); expect(resized.y).toBe(dragged.y);
    expect(Math.abs(resized.width - dragged.width - 24 * source.width / source.desktop!.bounds.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(resized.height - dragged.height - 20 * source.height / source.desktop!.bounds.height)).toBeLessThanOrEqual(2);
    await tool.getByRole('button', { name: '遮盖', exact: true }).click();
    const canvas = await tool.locator('.desktop-screenshot-selection-canvas').boundingBox(); if (!canvas) throw Error('Missing inline selection canvas');
    await tool.mouse.move(canvas.x + canvas.width * .2, canvas.y + canvas.height * .2); await tool.mouse.down();
    await tool.mouse.move(canvas.x + canvas.width * .4, canvas.y + canvas.height * .4, { steps: 8 }); await tool.mouse.up();
    const artifacts = path.resolve('.tools/test-output'); mkdirSync(artifacts, { recursive: true });
    await tool.screenshot({ path: path.join(artifacts, 'desktop-screenshot-inline-selection.png') });
    clipboardBefore = await application.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }));
    await Promise.all([tool.waitForEvent('close'), tool.getByRole('button', { name: '复制并完成', exact: true }).click()]);
    const copied = await application.evaluate(({ clipboard }) => clipboard.readImage().toPNG().toString('base64'));
    const png = Buffer.from(copied, 'base64'); expect(await sharp(png).metadata()).toMatchObject({ format: 'png', width: resized.width, height: resized.height });
    expect([...await sharp(png).extract({ left: Math.floor(resized.width * .3), top: Math.floor(resized.height * .3), width: 1, height: 1 }).removeAlpha().raw().toBuffer()]).toEqual([0, 0, 0]);
    const unchanged = { left: Math.floor(resized.width * .9), top: Math.floor(resized.height * .9), width: 1, height: 1 };
    const originalPixel = await sharp(Buffer.from(source.dataUrl.split(',')[1]!, 'base64')).extract({ ...unchanged, left: resized.x + unchanged.left, top: resized.y + unchanged.top }).removeAlpha().raw().toBuffer();
    expect([...await sharp(png).extract(unchanged).removeAlpha().raw().toBuffer()]).toEqual([...originalPixel]);
    const evidence = { globalNativeShortcut: true, ordinaryNativeWindowEnumerated: true, actualScreenSource: true, containerDialog: false,
      windowCrop, workAreaCrop, screenCrop, freeDragCrop: dragged, resizedCrop: resized, editInPlace: true, flattenedRedaction: true, copyClosesOverlay: true,
      fakeSources: false, actualSunloginSession: false };
    await testInfo.attach('inline-desktop-selection-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
    console.log('INLINE_DESKTOP_SELECTION_E2E_RESULT', JSON.stringify(evidence));
  } catch (error) { failed = true; throw error; }
  finally {
    if (application && clipboardBefore) await application.evaluate(({ clipboard, nativeImage }, previous) => clipboard.write({ text: previous.text, html: previous.html, rtf: previous.rtf, image: nativeImage.createFromDataURL(previous.image) }), clipboardBefore).catch(error => { if (!failed) cleanupError = error; });
    if (application) {
      const logs = path.join(profile, 'logs');
      if (failed && existsSync(logs)) for (const filename of readdirSync(logs)) if (filename.endsWith('.log')) await testInfo.attach(filename, { body: readFileSync(path.join(logs, filename)), contentType: 'text/plain' });
      await application.close().catch(error => { if (!failed) cleanupError ??= error; });
    }
    try { cleanup(root); } catch (error) { if (!failed) cleanupError ??= error; }
  }
  if (cleanupError) throw cleanupError;
});
