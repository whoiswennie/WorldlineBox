import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { BrowserDownload, BrowserRequest, WorldlineBoxBrowserApi } from '../../src/shared/browser';
import type { WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import { electronLaunchEnv, openAppSettingsDialog, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { browser: WorldlineBoxBrowserApi; captureTools: WorldlineBoxCaptureToolsApi } };
async function browserState(page: Page, request: BrowserRequest = { type: 'state' }) {
  const result = await page.evaluate(request => (globalThis as unknown as Bridge).worldlinebox.browser.request(request), request);
  if (!result.ok) throw Error(result.error); if (!result.state) throw Error('No production browser state'); return result.state;
}
async function toolsState(page: Page) {
  const result = await page.evaluate(() => (globalThis as unknown as Bridge).worldlinebox.captureTools.request({ type: 'state' }));
  if (!result.ok) throw Error(result.error); if (!result.state) throw Error('No global tools state'); return result.state;
}
function cleanup(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-browser-tools-ui-')) throw Error('Unexpected browser tools fixture cleanup path');
  rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}

async function platformFontDiagnostics(application: ElectronApplication, page: Page) {
  const session = await application.context().newCDPSession(page);
  try {
    await session.send('DOM.enable'); await session.send('CSS.enable');
    const document = await session.send('DOM.getDocument');
    const output: Record<string, unknown> = {};
    for (const [name, selector] of Object.entries({ intro: '.capture-settings-intro', label: '.capture-key-label strong', kbd: '.capture-key-caps kbd' })) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: document.root.nodeId, selector });
      if (!nodeId) throw Error('No font diagnostic node: ' + selector);
      const platform = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      const computed = await page.locator(selector).first().evaluate(element => {
        const style = getComputedStyle(element);
        return { family: style.fontFamily, weight: style.fontWeight, size: style.fontSize };
      });
      expect(platform.fonts.length, name + ' has a real rendered font').toBeGreaterThan(0);
      output[name] = { selector, platform: platform.fonts, computed };
    }
    return output;
  } finally { await session.detach(); }
}

// All records originate from real Chromium downloads over loopback. No browser
// state, download metadata, settings form value, or registration result is seeded.
// eslint-disable-next-line no-empty-pattern
test('browser downloads can be managed without deleting files, more actions affect the native page, and global shortcuts record actual keys', async ({}, testInfo) => {
  test.setTimeout(150000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-browser-tools-ui-'));
  const profile = path.join(root, 'profile'), downloads = path.join(root, 'downloads'); mkdirSync(downloads);
  const payloads = new Map(['notes.txt', 'reference.zip', 'capture-guide.pdf', 'fresh.txt'].map(name => [name, Buffer.from(('WorldlineBox real browser download: ' + name + '\n').repeat(60))]));
  const server = createServer((request, response) => {
    const name = request.url?.startsWith('/download/') ? decodeURIComponent(request.url.slice('/download/'.length)) : undefined;
    if (name && payloads.has(name)) {
      const payload = payloads.get(name)!;
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + name + '"', 'Content-Length': payload.length }); response.end(payload); return;
    }
    if (request.url === '/slow-download') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="in-progress.bin"', 'Content-Length': 16 * 1024 * 1024 });
      response.write(Buffer.alloc(1024, 1)); const timer = setInterval(() => response.write(Buffer.alloc(1024, 1)), 100);
      response.once('close', () => clearInterval(timer)); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><title>' + (request.url === '/second' ? 'Second browser tools page' : 'WorldlineBox browser tools')
      + '</title></head><body style="margin:0;padding:36px;font:17px/1.8 Segoe UI;background:#f5f7fd;color:#263b69"><h1>Browser tools</h1><p>Downloads, page controls and global shortcuts.</p><p>Findable reference text. Another findable reference text.</p>'
      + [...payloads.keys()].map(filename => '<p><a href="/download/' + filename + '">Download ' + filename + '</a></p>').join('')
      + '<p><a href="/slow-download">Start a long download</a></p></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No local browser tools fixture address');
  const origin = 'http://127.0.0.1:' + address.port, sourceUrl = origin + '/tools';
  let application: ElectronApplication | undefined, failed = false, cleanupFailure: unknown;
  let stderr = ''; const saved: BrowserDownload[] = []; const evidence: Record<string, unknown> = {};
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CAPTURE_DOWNLOAD_PATH: path.join(downloads, 'WorldlineBox') }) });
    application.process().stderr?.on('data', chunk => { stderr += String(chunk); });
    // app.setPath affects this isolated Electron process only, including packaged
    // acceptance where development-only environment overrides are unavailable.
    await application.evaluate(({ app }, directory) => app.setPath('downloads', directory), downloads);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const main = await application.firstWindow(); const native = await application.browserWindow(main);
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    await native.evaluate(window => { window.unmaximize(); window.setContentSize(1440, 1000); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    mkdirSync('artifacts', { recursive: true });
    const snapshot = async (filename: string, target?: string | Locator) => {
      await main.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const bounds = target ? await (typeof target === 'string' ? main.locator(target) : target).boundingBox() : undefined;
      const clip = bounds ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } : undefined;
      const png = await native.evaluate(async (window, rect) => (await window.webContents.capturePage(rect)).toPNG().toString('base64'), clip);
      writeFileSync(path.resolve('artifacts', filename), Buffer.from(png, 'base64'));
    };
    const resize = async (width: number, height: number, zoom: number) => {
      const actual = await native.evaluate((window, next) => {
        window.setContentSize(next.width, next.height); window.webContents.setZoomFactor(next.zoom);
        return { content: window.getContentSize(), zoom: window.webContents.getZoomFactor() };
      }, { width, height, zoom });
      await expect.poll(() => main.evaluate(configuration => Math.abs(innerWidth - configuration.content[0]! / configuration.zoom) <= 2
        && Math.abs(innerHeight - configuration.content[1]! / configuration.zoom) <= 2, actual)).toBe(true);
      return { requested: { width, height, zoom }, actual };
    };
    const compactLayout = async (label: string, container: Locator, controls: Locator, close: Locator) => {
      const dimensions = await resize(960, 640, 1.25);
      await expect(container).toBeVisible();
      const geometry = await container.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth,
        viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth }));
      expect(geometry.scroll, label + ' section width').toBeLessThanOrEqual(geometry.client + 1);
      expect(geometry.pageWidth, label + ' page width').toBeLessThanOrEqual(geometry.viewport.width + 1);
      for (const control of await controls.all()) {
        await control.scrollIntoViewIfNeeded(); await expect(control).toBeVisible();
        const bounds = await control.boundingBox(); expect(bounds, label + ' control geometry').toBeTruthy();
        expect(bounds!.x, label + ' control left').toBeGreaterThanOrEqual(-1);
        expect(bounds!.x + bounds!.width, label + ' control right').toBeLessThanOrEqual(geometry.viewport.width + 1);
        await control.click({ trial: true });
      }
      await close.scrollIntoViewIfNeeded(); await close.click({ trial: true });
      await resize(1440, 1000, 1);
      await container.evaluate(element => { let current: Element | null = element; while (current) { current.scrollTop = 0; current = current.parentElement; } });
      return { ...dimensions, geometry, controls: await controls.count(), closeReachable: true };
    };
    await main.locator('[data-application-module="browser"]').click();
    const location = main.getByRole('textbox', { name: '搜索或输入网址', exact: true }); await location.fill(sourceUrl); await location.press('Enter');
    await expect.poll(() => application!.context().pages().some(page => page.url() === sourceUrl)).toBe(true);
    const web = application.context().pages().find(page => page.url() === sourceUrl)!;
    await expect(web.getByRole('heading', { name: 'Browser tools', exact: true })).toBeVisible();
    const toolbar = main.locator('.browser-toolbar');
    await expect(toolbar.getByRole('button', { name: '截图', exact: true })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: '划词助手', exact: true })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: '浏览器设置', exact: true })).toHaveCount(0);
    const menuTrigger = toolbar.getByRole('button', { name: '设置与更多', exact: true });
    await menuTrigger.click(); await expect(menuTrigger).toHaveAttribute('aria-expanded', 'true');
    const menuPanel = main.getByRole('complementary', { name: '设置与更多', exact: true });
    const quickTab = menuPanel.getByRole('tab', { name: '常用操作', exact: true });
    await quickTab.focus(); await quickTab.press('ArrowRight');
    await expect(menuPanel.getByRole('tab', { name: '浏览器设置', exact: true })).toBeFocused();
    await expect(menuPanel.getByRole('tabpanel')).toContainText('AI 搜索与浏览助手');
    await expect(menuPanel.getByRole('textbox', { name: '默认主页', exact: true })).toBeVisible();
    await snapshot('browser-unified-settings.png');
    await menuPanel.getByRole('textbox', { name: '默认主页', exact: true }).fill(sourceUrl);
    await menuPanel.getByRole('tab', { name: '浏览器设置', exact: true }).press('ArrowLeft');
    await expect(quickTab).toBeFocused(); await expect(quickTab).toHaveAttribute('aria-selected', 'true');
    await quickTab.press('ArrowRight');
    await expect(menuPanel.getByRole('textbox', { name: '默认主页', exact: true })).toHaveValue(sourceUrl);
    await menuPanel.getByRole('tab', { name: '浏览器设置', exact: true }).press('ArrowLeft');
    await snapshot('browser-unified-menu.png');
    const themeSettings = await openAppSettingsDialog(application, main);
    await themeSettings.getByRole('tab', { name: '外观', exact: true }).click();
    await themeSettings.getByRole('radio', { name: '暗色', exact: true }).click(); await main.keyboard.press('Escape');
    await snapshot('browser-unified-menu-dark.png');
    const lightSettings = await openAppSettingsDialog(application, main);
    await lightSettings.getByRole('tab', { name: '外观', exact: true }).click();
    await lightSettings.getByRole('radio', { name: '亮色', exact: true }).click(); await main.keyboard.press('Escape');
    await menuTrigger.click(); await expect(menuPanel).toHaveCount(0);
    await expect(menuTrigger).toHaveAttribute('aria-expanded', 'false');
    evidence.toolbar = { duplicateCaptureActionsRemoved: true, unifiedSettingsAndMore: true, keyboardTabs: true };
    async function download(filename: string) {
      const previous = new Set((await browserState(main)).downloads.map(item => item.id));
      await web.getByRole('link', { name: 'Download ' + filename, exact: true }).click();
      await expect.poll(async () => (await browserState(main)).downloads.find(item => !previous.has(item.id) && item.filename === filename)?.status).toBe('completed');
      const record = (await browserState(main)).downloads.find(item => !previous.has(item.id) && item.filename === filename)!;
      await expect.poll(async () => { const state = await browserState(main); return state.tabs.find(item => item.id === state.activeTabId)?.url; }).toBe(sourceUrl);
      expect(path.resolve(record.path).startsWith(path.resolve(downloads) + path.sep)).toBe(true);
      expect(readFileSync(record.path)).toEqual(payloads.get(filename)); saved.push(record); return record;
    }
    for (const filename of ['notes.txt', 'reference.zip', 'capture-guide.pdf']) await download(filename);
    await web.getByRole('link', { name: 'Start a long download', exact: true }).click();
    await expect.poll(async () => (await browserState(main)).downloads.some(item => item.filename === 'in-progress.bin' && item.received > 0)).toBe(true);
    await expect.poll(async () => { const state = await browserState(main); return state.tabs.find(item => item.id === state.activeTabId)?.url; }).toBe(sourceUrl);
    await main.getByRole('button', { name: '下载', exact: true }).click();
    const panel = main.locator('.browser-panel-downloads'); await expect(panel.locator('.browser-download-row')).toHaveCount(4);
    await snapshot('browser-download-sidebar.png');
    await snapshot('browser-download-sidebar-panel.png', '.browser-panel-downloads');
    const notes = panel.locator('.browser-download-row').filter({ has: main.getByText('notes.txt', { exact: true }) });
    await notes.getByRole('button', { name: '移除此记录: notes.txt', exact: true }).click();
    await expect(panel.locator('.browser-download-row')).toHaveCount(3);
    expect(readFileSync(saved[0]!.path)).toEqual(payloads.get('notes.txt'));
    await panel.getByRole('button', { name: '管理记录', exact: true }).click();
    await panel.getByRole('checkbox', { name: '选择本页', exact: true }).check();
    await expect(panel.getByRole('checkbox', { name: '选择记录: in-progress.bin', exact: true })).toBeDisabled();
    await snapshot('browser-download-sidebar-manage.png');
    await snapshot('browser-download-sidebar-manage-panel.png', '.browser-panel-downloads');
    await panel.getByRole('button', { name: '移除所选', exact: true }).click();
    await expect(panel.locator('.browser-download-row')).toHaveCount(1);
    expect((await browserState(main)).downloads[0]!.filename).toBe('in-progress.bin');
    for (const record of saved) expect(readFileSync(record.path)).toEqual(payloads.get(record.filename));
    await panel.getByRole('button', { name: '完成', exact: true }).click();
    await download('fresh.txt'); await expect(panel.locator('.browser-download-row')).toHaveCount(2);
    await panel.getByRole('button', { name: '清理已结束记录', exact: true }).click();
    await expect(panel.locator('.browser-download-row')).toHaveCount(1); expect(readFileSync(saved.at(-1)!.path)).toEqual(payloads.get('fresh.txt'));
    const active = panel.locator('.browser-download-row').filter({ hasText: 'in-progress.bin' });
    await active.getByRole('button', { name: '暂停', exact: true }).click(); await expect(active).toHaveClass(/is-paused/);
    await expect(panel.getByRole('button', { name: '清理已结束记录', exact: true })).toBeDisabled();
    await active.getByRole('button', { name: '继续', exact: true }).click(); await expect(active).toHaveClass(/is-progressing/);
    await active.getByRole('button', { name: '取消', exact: true }).click(); await expect(active).toHaveClass(/is-cancelled/);
    await panel.getByRole('button', { name: '清理已结束记录', exact: true }).click(); await expect(panel.locator('.browser-download-row')).toHaveCount(0);
    evidence.downloads = { realFiles: saved.length, individualAndBulkRemoval: true, clearFinished: true, activeAndPausedRetained: true, filesUnchanged: true };
    await panel.getByRole('button', { name: '关闭', exact: true }).click();

    await main.getByRole('button', { name: '设置与更多', exact: true }).click();
    const more = main.getByRole('navigation', { name: '更多操作', exact: true }); await expect(more).toBeVisible();
    await more.getByRole('button', { name: '固定标签页', exact: true }).click();
    await expect(more.getByRole('button', { name: '取消固定标签页', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await more.getByRole('button', { name: '静音此标签页', exact: true }).click();
    await expect(more.getByRole('button', { name: '恢复页面声音', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => application!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)?.isAudioMuted(), sourceUrl)).toBe(true);
    await more.getByRole('button', { name: '放大页面', exact: true }).click();
    await expect(more.getByRole('button', { name: '重置为 100%', exact: true })).toHaveText('110%');
    await expect.poll(() => application!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)?.getZoomFactor(), sourceUrl)).toBe(1.1);
    await more.getByRole('button', { name: '缩小页面', exact: true }).click();
    await expect(more.getByRole('button', { name: '重置为 100%', exact: true })).toHaveText('100%');
    await more.getByRole('button', { name: '放大页面', exact: true }).click(); await more.getByRole('button', { name: '重置为 100%', exact: true }).click();
    evidence.moreCompactLayout = await compactLayout('More sidebar', main.locator('.browser-panel-more'), more.getByRole('button'), main.locator('.browser-panel-more').getByRole('button', { name: '关闭', exact: true }));
    await snapshot('browser-more-sidebar.png');
    await snapshot('browser-more-sidebar-panel.png', '.browser-panel-more');
    await native.evaluate(window => { window.setFocusable(true); window.setOpacity(.01); window.show(); window.focus(); window.webContents.focus(); });
    await more.getByRole('button', { name: /^在页面中查找/ }).click();
    const find = main.getByRole('textbox', { name: '在页面中查找', exact: true }); await expect(find).toBeVisible(); await find.fill('findable reference text');
    await expect(find).toHaveValue('findable reference text');
    await expect.poll(async () => (await browserState(main)).find?.matches).toBe(2);
    const firstOrdinal = (await browserState(main)).find!.activeMatchOrdinal; expect(firstOrdinal).toBeGreaterThan(0);
    await find.press('Enter');
    await expect.poll(async () => (await browserState(main)).find?.activeMatchOrdinal).not.toBe(firstOrdinal);
    expect((await browserState(main)).find?.matches).toBe(2); await find.press('Escape');
    await main.getByRole('button', { name: '新建标签页', exact: true }).click(); await location.fill(origin + '/second'); await location.press('Enter');
    await expect.poll(async () => (await browserState(main)).tabs.find(item => item.url === origin + '/second')?.title).toBe('Second browser tools page');
    await main.getByRole('button', { name: '关闭标签页 Second browser tools page', exact: true }).click();
    await main.getByRole('button', { name: '设置与更多', exact: true }).click();
    await more.getByRole('button', { name: /^恢复关闭的标签页/ }).click();
    await expect.poll(async () => (await browserState(main)).tabs.some(item => item.url === origin + '/second')).toBe(true);
    await expect(more.getByRole('button', { name: '全局网络设置', exact: true })).toHaveCount(0);
    await main.locator('[data-application-module="network"]').click();
    await expect(main.locator('[data-application-module="network"]')).toHaveAttribute('aria-current', 'page');
    evidence.more = { pinAndMute: true, nativePageMutedAndZoomed: true, zoomAndReset: true, nativeFindMatches: 2, restoreClosedTab: true, globalNetworkOnlyInSidebar: true };

    const settings = await openAppSettingsDialog(application, main);
    await settings.getByRole('tab', { name: '全局工具与快捷键', exact: true }).click();
    const shortcuts = settings.locator('[data-capture-tools-settings]'); await expect(shortcuts.locator('#capture-key-screenshot')).toBeVisible();
    const original = (await toolsState(main)).settings.shortcuts.screenshot;
    // The field captures actual CDP keyboard down/up events while native global
    // registrations are temporarily suspended. It is not filled programmatically.
    await native.evaluate(window => { window.setFocusable(true); window.setOpacity(.01); window.show(); window.focus(); window.webContents.focus(); });
    // Window activation is asynchronous on Windows. Let focus/blur events settle
    // before entering shortcut recording, which intentionally cancels on blur.
    await expect.poll(() => native.evaluate(window => window.isFocused())).toBe(true);
    await expect.poll(() => main.evaluate(() => document.hasFocus())).toBe(true);
    await main.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshotKey = shortcuts.locator('#capture-key-screenshot'); await screenshotKey.click();
    const screenshotRow = shortcuts.locator('.capture-setting-shortcut').filter({ has: main.locator('#capture-key-screenshot') });
    await expect(screenshotKey).toHaveValue('请按下组合键…');
    const combination = 'Ctrl+Alt+Shift+F12';
    await main.keyboard.down('Control'); await main.keyboard.down('Alt'); await main.keyboard.down('Shift'); await main.keyboard.down('F12');
    await main.keyboard.up('F12'); await main.keyboard.up('Shift'); await main.keyboard.up('Alt'); await main.keyboard.up('Control');
    await expect(screenshotKey).toHaveValue(/F12/);
    expect((await toolsState(main)).settings.shortcuts.screenshot).toBe(original);
    await expect(screenshotRow).toContainText('待保存');
    await shortcuts.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect.poll(async () => (await toolsState(main)).settings.shortcuts.screenshot).toBe(combination);
    await expect.poll(async () => (await toolsState(main)).shortcuts.find(item => item.task === 'screenshot')?.registered).toBe(true);
    expect(await application.evaluate(({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator), combination)).toBe(true);
    await expect(screenshotRow).toContainText('已注册');
    evidence.settingsCompactLayout = await compactLayout('Global tools settings', shortcuts, shortcuts.locator('.capture-key-trigger input'), settings.getByRole('button', { name: '关闭', exact: true }));
    const fontDiagnostics = await platformFontDiagnostics(application, main);
    writeFileSync(path.resolve('artifacts/browser-tools-platform-fonts.json'), JSON.stringify(fontDiagnostics, null, 2));
    console.log('BROWSER_TOOLS_PLATFORM_FONTS', JSON.stringify(fontDiagnostics));
    await screenshotKey.scrollIntoViewIfNeeded(); await snapshot('global-tools-shortcuts-settings.png');
    await snapshot('global-tools-shortcuts-settings-dialog.png', settings);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); });
    evidence.shortcut = { recordedByKeyboardDownUp: true, persisted: combination, nativeRegistered: true, isolatedProfile: true };
    evidence.packaged = await application.evaluate(({ app }) => app.isPackaged);
    writeFileSync(path.resolve('artifacts/browser-tools-ui-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('BROWSER_TOOLS_UI_E2E_RESULT', JSON.stringify(evidence));
    await testInfo.attach('browser-tools-ui-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } catch (cause) { failed = true; await testInfo.attach('browser-tools-ui-stderr', { body: stderr, contentType: 'text/plain' }); throw cause; }
  finally {
    await application?.close().catch(cause => { if (!failed) cleanupFailure = cause; });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    try { cleanup(root); } catch (cause) { if (!failed && !cleanupFailure) cleanupFailure = cause; }
  }
  if (cleanupFailure) throw cleanupFailure;
});
