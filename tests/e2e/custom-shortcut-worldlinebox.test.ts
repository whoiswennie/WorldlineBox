import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorldlineBoxBrowserApi } from '../../src/shared/browser';
import type { WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import type { WorldlineBoxShortcutsApi } from '../../src/shared/shortcut-api';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

function cleanupFixture(root: string): void {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-module-shortcuts-')) throw Error('Unexpected module shortcut fixture cleanup path');
  rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

async function sendKey(application: ElectronApplication, page: Page, keyCode: string, modifiers: Array<'control' | 'meta' | 'shift'> = []) {
  const native = await application.browserWindow(page);
  await native.evaluate((window, input) => {
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', ...input });
    window.webContents.sendInputEvent({ type: 'keyUp', ...input });
  }, { keyCode, modifiers });
}

test('custom fullscreen survives cold launcher, native browser focus and module changes while global screen shortcuts keep their bindings', async () => {
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-module-shortcuts-'));
  const profile = path.join(root, 'profile'); mkdirSync(profile);
  const platform = process.platform === 'darwin' ? 'mac' : 'windows';
  const modifier = platform === 'mac' ? 'meta' : 'control';
  writeFileSync(path.join(profile, 'shortcut-bindings.json'), JSON.stringify({ version: 1, platforms: {
    mac: platform === 'mac' ? { 'window.toggle-fullscreen': { key: 'F12', code: 'F12', metaKey: true, shiftKey: true } } : {},
    windows: platform === 'windows' ? { 'window.toggle-fullscreen': { key: 'F12', code: 'F12', ctrlKey: true, shiftKey: true } } : {},
  } }));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Native shortcut fixture</title></head><body><h1>Real browser shortcut target</h1><input aria-label="Page text" value="Do not replace my native editing shortcuts"></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing browser fixture address');
  const url = `http://127.0.0.1:${address.port}/shortcut`;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_SHOW_INACTIVE: '1' }) });
    const page = await application.firstWindow();
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    await expect(page.locator('main.app-shell')).toHaveCount(0);
    const native = await application.browserWindow(page);
    // Observe actual native calls while retaining the original BrowserWindow implementation.
    await native.evaluate(window => {
      const original = window.setFullScreen.bind(window);
      const observed = window as unknown as { shortcutFullscreenCalls: number; shortcutFullscreenEvents: number; shortcutSettledFullscreen: boolean; shortcutFullscreenPending: boolean | null };
      observed.shortcutFullscreenCalls = 0;
      observed.shortcutFullscreenEvents = 0;
      observed.shortcutSettledFullscreen = window.isFullScreen();
      observed.shortcutFullscreenPending = null;
      const settled = (fullscreen: boolean) => {
        observed.shortcutFullscreenEvents++; observed.shortcutSettledFullscreen = fullscreen; observed.shortcutFullscreenPending = null;
      };
      window.on('enter-full-screen', () => settled(true));
      window.on('leave-full-screen', () => settled(false));
      window.setFullScreen = (value: boolean) => { observed.shortcutFullscreenCalls++; observed.shortcutFullscreenPending = value; original(value); };
    });
    const snapshot = () => native.evaluate(window => ({ fullscreen: window.isFullScreen(), calls: (window as unknown as { shortcutFullscreenCalls: number }).shortcutFullscreenCalls }));
    const expectToggle = async (calls: number, fullscreen: boolean) => {
      await expect.poll(snapshot, { timeout: 15000 }).toEqual({ calls, fullscreen });
      // isFullScreen() can change before the native transition finishes. The
      // next physical key must be sent after the corresponding native event.
      await expect.poll(() => native.evaluate(window => {
        const observed = window as unknown as { shortcutFullscreenEvents: number; shortcutSettledFullscreen: boolean; shortcutFullscreenPending: boolean | null };
        return { events: observed.shortcutFullscreenEvents, fullscreen: observed.shortcutSettledFullscreen, pending: observed.shortcutFullscreenPending };
      }), { message: 'native fullscreen transition must finish', timeout: 15000 }).toEqual({ events: calls, fullscreen, pending: null });
    };
    await sendKey(application, page, 'F12', [modifier, 'shift']); await expectToggle(1, true);
    await sendKey(application, page, 'F12', [modifier, 'shift']); await expectToggle(2, false);
    if (platform === 'windows') { await sendKey(application, page, 'F11'); await page.waitForTimeout(180); await expectToggle(2, false); }

    const conflicts = await page.evaluate(async (rawPlatform: string) => {
      const targetPlatform: 'mac' | 'windows' = rawPlatform === 'mac' ? 'mac' : 'windows';
      const bridge = (window as unknown as { worldlinebox: { shortcuts: WorldlineBoxShortcutsApi; captureTools: WorldlineBoxCaptureToolsApi } }).worldlinebox;
      const before = await bridge.shortcuts.get();
      const candidate = { ...before.platforms[targetPlatform], 'asset.rename': { key: 's', code: 'KeyS', ...(targetPlatform === 'mac' ? { metaKey: true } : { ctrlKey: true }), altKey: true, shiftKey: true } };
      const rejected = await bridge.shortcuts.set({ platform: targetPlatform, bindings: candidate });
      const state = await bridge.captureTools.request({ type: 'state' }); if (!state.ok || !state.state) throw Error('Missing global screen tool state');
      const settings = structuredClone(state.state.settings);
      settings.shortcuts.screenshot = targetPlatform === 'mac' ? 'Command+Shift+S' : 'Control+Shift+S';
      const reverse = await bridge.captureTools.request({ type: 'settings.save', settings });
      const after = await bridge.shortcuts.get();
      const toolsAfter = await bridge.captureTools.request({ type: 'state' });
      return { rejected, reverse, before, after, globalBefore: state.state.settings, globalAfter: toolsAfter.ok ? toolsAfter.state?.settings : null };
    }, platform);
    expect(conflicts.rejected).toMatchObject({ ok: false, error: 'shortcut-global-tools-conflict' });
    expect(conflicts.reverse.ok).toBe(false); expect(conflicts.after).toEqual(conflicts.before); expect(conflicts.globalAfter).toEqual(conflicts.globalBefore);

    await page.locator('[data-application-module="browser"]').click();
    const navigation = await page.evaluate(async targetUrl => {
      const api = (window as unknown as { worldlinebox: { browser: WorldlineBoxBrowserApi } }).worldlinebox.browser;
      return api.request({ type: 'tab.navigate', text: targetUrl });
    }, url);
    expect(navigation.ok).toBe(true);
    await expect.poll(() => application!.evaluate(({ webContents }, targetUrl) => webContents.getAllWebContents().some(contents => contents.getURL() === targetUrl), url)).toBe(true);
    await expect(page.locator('main.app-shell')).toHaveCount(0);
    const sendPageKey = (keyCode: string, modifiers: Array<'control' | 'meta' | 'shift'> = []) => application!.evaluate(({ webContents }, input) => {
      const target = webContents.getAllWebContents().find(contents => contents.getURL() === input.url); if (!target) throw Error('Missing native browser page');
      target.focus(); target.sendInputEvent({ type: 'keyDown', keyCode: input.keyCode, modifiers: input.modifiers }); target.sendInputEvent({ type: 'keyUp', keyCode: input.keyCode, modifiers: input.modifiers });
    }, { url, keyCode, modifiers });
    await sendPageKey('F12', [modifier, 'shift']); await expectToggle(3, true);
    await sendPageKey('F12', [modifier, 'shift']); await expectToggle(4, false);
    if (platform === 'windows') { await sendPageKey('F11'); await page.waitForTimeout(180); await expectToggle(4, false); }
    for (const [module, calls] of [['assets', 6], ['dsh', 8], ['companions', 10], ['browser', 12]] as const) {
      await page.locator(`[data-application-module="${module}"]`).click();
      await expect(page.locator(`[data-application-module="${module}"]`)).toHaveAttribute('aria-current', 'page');
      if (module === 'assets') await expect(page.locator('main.app-shell')).toBeVisible();
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      if (platform === 'windows') {
        // Check ownership independently of delivery. A disabled native item is
        // a product regression; sending to the wrong focused WebContents is not.
        await expect.poll(() => application!.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()?.getMenuItemById('shortcut.window.toggle-fullscreen.0')?.enabled ?? false,
        ), { message: `${module} must enable its fullscreen accelerator` }).toBe(true);
      }
      // A restored native browser page owns physical keyboard events. Keep the
      // native-page path here instead of sending to its parent renderer HWND.
      const sendCurrentKey = () => module === 'browser'
        ? sendPageKey('F12', [modifier, 'shift'])
        : sendKey(application!, page, 'F12', [modifier, 'shift']);
      await sendCurrentKey(); await expectToggle(calls - 1, true);
      await sendCurrentKey(); await expectToggle(calls, false);
    }
  } finally {
    if (application) { await application.evaluate(({ app }) => app.quit()).catch(() => undefined); await application.close().catch(() => undefined); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    cleanupFixture(root);
  }
});
