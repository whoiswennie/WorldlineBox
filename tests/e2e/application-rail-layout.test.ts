import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Rectangle = { x: number; y: number; width: number; height: number; right: number; bottom: number };
const tolerance = .8;
const sizes = [{ width: 960, height: 640 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }];
const zooms = [1, 1.25, 1.5, 2];

function cleanup(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-rail-layout-')) throw Error('Unexpected application rail fixture cleanup path');
  rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
async function settled(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function railGeometry(page: Page) {
  return page.evaluate(() => {
    const element = (selector: string) => { const value = document.querySelector<HTMLElement>(selector); if (!value) throw Error('Missing layout element ' + selector); return value; };
    const rectangle = (node: Element) => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
    const rail = element('.application-navigation'), footer = element('.application-navigation-footer'), modules = element('.application-navigation-modules');
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>('.application-navigation-item')].map(button => ({ name: button.getAttribute('aria-label'), ...rectangle(button) }));
    return { viewport: { width: innerWidth, height: innerHeight }, rail: rectangle(rail), footer: rectangle(footer), modules: rectangle(modules), buttons,
      scroll: { pageX: scrollX, pageY: scrollY, railHeight: rail.clientHeight, railScrollHeight: rail.scrollHeight, footerHeight: footer.clientHeight, footerScrollHeight: footer.scrollHeight,
        modulesHeight: modules.clientHeight, modulesScrollHeight: modules.scrollHeight, modulesScrollTop: modules.scrollTop, modulesOverflowY: getComputedStyle(modules).overflowY } };
  });
}
function inside(inner: Rectangle, outer: Rectangle, description: string) {
  expect(inner.width, description + ' width').toBeGreaterThan(0);
  expect(inner.height, description + ' height').toBeGreaterThan(0);
  expect(inner.x, description + ' left').toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y, description + ' top').toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.right, description + ' right').toBeLessThanOrEqual(outer.right + tolerance);
  expect(inner.bottom, description + ' bottom').toBeLessThanOrEqual(outer.bottom + tolerance);
}
function assertRail(geometry: Awaited<ReturnType<typeof railGeometry>>, label: string) {
  const { rail, footer, buttons, viewport, modules, scroll } = geometry;
  const frame = { x: 0, y: 0, width: viewport.width, height: viewport.height, right: viewport.width, bottom: viewport.height };
  expect(buttons.map(button => button.name), label).toEqual(['截图', '录屏', '设置']);
  inside(rail, frame, label + ' rail'); inside(footer, rail, label + ' footer');
  for (const button of buttons) {
    inside(button, rail, label + ' ' + button.name);
    inside(button, footer, label + ' footer ' + button.name);
    expect(Math.abs(button.x + button.width / 2 - (rail.x + rail.width / 2)), label + ' centered ' + button.name).toBeLessThanOrEqual(tolerance);
  }
  const vertical = [...buttons].sort((a, b) => a.y - b.y);
  for (let index = 1; index < vertical.length; index++) expect(vertical[index - 1]!.bottom, label + ' non-overlap').toBeLessThanOrEqual(vertical[index]!.y + tolerance);
  expect(modules.bottom, label + ' modules before footer').toBeLessThanOrEqual(footer.y + tolerance);
  expect(scroll.railScrollHeight, label + ' rail itself must not scroll').toBeLessThanOrEqual(scroll.railHeight + 1);
  expect(scroll.footerScrollHeight, label + ' footer itself must not scroll').toBeLessThanOrEqual(scroll.footerHeight + 1);
  expect(['auto', 'scroll']).toContain(scroll.modulesOverflowY);
  expect(scroll.pageX, label + ' page horizontal scroll').toBe(0);
  expect(scroll.pageY, label + ' page vertical scroll').toBe(0);
}
async function assertMenuInteraction(page: Page, viewport: { width: number; height: number }, label: string) {
  const menu = page.locator('.application-capture-menu');
  await expect(menu).toBeVisible(); await expect(menu.getByRole('menuitem')).toHaveCount(6);
  const bounds = await menu.boundingBox(); if (!bounds) throw Error('Missing global tools menu bounds');
  inside({ ...bounds, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height },
    { x: 0, y: 0, width: viewport.width, height: viewport.height, right: viewport.width, bottom: viewport.height }, label + ' menu viewport');
  for (const item of await menu.getByRole('menuitem').all()) {
    await item.scrollIntoViewIfNeeded();
    const hit = await item.evaluate(element => {
      const box = element.getBoundingClientRect(), top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { label: element.textContent, matched: !!top && element.contains(top), topTag: top?.tagName, topClass: top?.getAttribute('class') };
    });
    expect(hit.matched, label + ' topmost hit target: ' + JSON.stringify(hit)).toBe(true);
    await item.click({ trial: true });
  }
  return menu;
}

test('the application rail keeps capture, recording and settings aligned across native sizes, zoom and settings dialogs', async () => {
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-rail-layout-')), profile = path.join(root, 'profile');
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let failed = false, cleanupFailure: unknown;
  const measurements: unknown[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><title>Native browser rail overlay fixture</title></head><body style="margin:0;padding:35px;background:#e7efff;color:#23406b;font:24px/1.8 Segoe UI"><h1>Real native browser view</h1><p>This page must be hidden while the global tools menu is open, then restored.</p><div style="height:220px;background:#89a9ed;border-radius:20px"></div></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing rail browser fixture port');
  const browserUrl = 'http://127.0.0.1:' + address.port + '/rail';
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await application.firstWindow();
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    const native = await application.browserWindow(page);
    await native.evaluate(window => { window.unmaximize(); window.setMinimumSize(400, 300); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    // CDP screenshots apply page zoom twice on this Electron/Windows driver.
    // Native capturePage preserves the complete compositor bitmap at every zoom.
    const snapshot = async (filename: string) => {
      const encoded = await native.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(filename, Buffer.from(encoded, 'base64'));
    };
    const settings = page.locator('.application-navigation-settings');
    const more = page.locator('.application-capture-more');
    for (const size of sizes) for (const zoom of zooms) {
      const label = size.width + 'x' + size.height + ' @' + zoom;
      const physical = await native.evaluate((window, configuration) => {
        window.setContentSize(configuration.width, configuration.height); window.webContents.setZoomFactor(configuration.zoom);
        return window.getContentSize();
      }, { ...size, zoom });
      await expect.poll(() => page.evaluate(({ width, height, zoom }) => Math.abs(innerWidth - width / zoom) <= 2 && Math.abs(innerHeight - height / zoom) <= 2,
        { width: physical[0], height: physical[1], zoom }), { message: label + ' viewport settled' }).toBe(true);
      await settled(page);
      const geometry = await railGeometry(page); assertRail(geometry, label); measurements.push({ label, ...geometry });
      if (size.width === 1280 && zoom === 1) await snapshot('.tools/test-output/application-rail-normal.png');
      if (size.width === 960 && zoom === 1) await snapshot('.tools/test-output/application-rail-short.png');
      if (size.width === 960 && zoom === 2) await snapshot('.tools/test-output/application-rail-zoom.png');

      // Overflow belongs to the module list; scrolling it must not move any of
      // the three global controls or scroll the application document.
      await page.locator('.application-navigation-modules').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await settled(page);
      const scrolled = await railGeometry(page); assertRail(scrolled, label + ' modules scrolled');
      expect(scrolled.buttons).toEqual(geometry.buttons);
      if (geometry.scroll.modulesScrollHeight > geometry.scroll.modulesHeight + 1) expect(scrolled.scroll.modulesScrollTop).toBeGreaterThan(0);

      await settings.click(); await expect(settings).toHaveAttribute('aria-expanded', 'true');
      const dialog = page.locator('.app-settings-dialog'); await expect(dialog).toBeVisible();
      await settled(page);
      const settingsGeometry = await railGeometry(page); assertRail(settingsGeometry, label + ' settings open');
      expect(settingsGeometry.buttons).toEqual(geometry.buttons);
      if (size.width === 1280 && zoom === 1) await snapshot('.tools/test-output/application-rail-settings-open.png');
      await more.click(); const settingsMenu = await assertMenuInteraction(page, geometry.viewport, label + ' settings overlay');
      if (size.width === 1280 && zoom === 1) await snapshot('.tools/test-output/application-rail-expanded-settings.png');
      await page.keyboard.press('Escape'); await expect(settingsMenu).toHaveCount(0);
      await expect(dialog).toBeVisible(); await expect(settings).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(settings).toHaveAttribute('aria-expanded', 'false');

      await more.click(); const menu = await assertMenuInteraction(page, geometry.viewport, label + ' normal overlay');
      if (size.width === 1280 && zoom === 1) await snapshot('.tools/test-output/application-rail-expanded-normal.png');
      if (size.width === 960 && zoom === 2) await snapshot('.tools/test-output/application-rail-expanded-zoom.png');
      await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
    }

    // A native WebContentsView always draws above its owner's HTML. Verify its
    // actual visibility in Main rather than trusting only DOM hit testing.
    await native.evaluate(window => { window.setContentSize(1280, 800); window.webContents.setZoomFactor(1); }); await settled(page);
    await page.locator('[data-application-module="browser"]').click();
    const location = page.getByRole('textbox', { name: '搜索或输入网址' }); await location.fill(browserUrl); await location.press('Enter');
    await expect.poll(() => application!.context().pages().some(candidate => candidate.url() === browserUrl)).toBe(true);
    const browser = application.context().pages().find(candidate => candidate.url() === browserUrl)!;
    await expect(browser.getByRole('heading', { name: 'Real native browser view' })).toBeVisible();
    const browserViewState = () => native.evaluate((window, url) => {
      const view = window.contentView.children.find((view: Electron.View) => 'webContents' in view && (view as Electron.WebContentsView).webContents.getURL() === url);
      return { attached: !!view, visible: view?.getVisible() ?? false };
    }, browserUrl);
    await expect.poll(browserViewState).toEqual({ attached: true, visible: true });
    await more.click();
    await expect.poll(async () => { const view = await browserViewState(); return !view.attached || !view.visible; }).toBe(true);
    const browserMenu = await assertMenuInteraction(page, (await railGeometry(page)).viewport, 'native browser overlay');
    await snapshot('.tools/test-output/application-rail-expanded-browser.png');
    await page.keyboard.press('Escape'); await expect(browserMenu).toHaveCount(0);
    await expect.poll(browserViewState).toEqual({ attached: true, visible: true });
    await expect(browser.getByRole('heading', { name: 'Real native browser view' })).toBeVisible();

    // A real click must survive the portal's pointerdown outside-click handler.
    // Observe clipboard access without reading or replacing personal clipboard data.
    await application.evaluate(({ clipboard }) => {
      const probe = { reads: 0, original: clipboard.readText };
      (globalThis as typeof globalThis & { __railClipboardProbe?: typeof probe }).__railClipboardProbe = probe;
      clipboard.readText = () => { probe.reads++; return ''; };
    });
    try {
      await more.click();
      await page.locator('.application-capture-menu').getByRole('menuitem', { name: '划词助手', exact: true }).click();
      await expect(page.locator('.application-capture-menu')).toHaveCount(0);
      await expect.poll(() => application!.windows().some(candidate => candidate.url().includes('window=capture-tools')), { timeout: 15000 }).toBe(true);
      const tool = application.windows().find(candidate => candidate.url().includes('window=capture-tools'))!;
      const toolWindow = await application.browserWindow(tool);
      await toolWindow.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.showInactive(); });
      await expect(tool.locator('[data-selection-assistant]')).toBeVisible();
      const task = await tool.evaluate(async () => {
        const api = (globalThis as unknown as { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi } }).worldlinebox.captureTools;
        const context = await api.request({ type: 'context' });
        return context.ok ? context.state?.task : context.error;
      });
      expect(task).toBe('selection');
      expect(await application.evaluate(() => (globalThis as typeof globalThis & { __railClipboardProbe?: { reads: number } }).__railClipboardProbe?.reads)).toBe(0);
      await expect(tool.locator('.selection-messages article')).toHaveCount(0);
      await tool.getByRole('button', { name: '关闭', exact: true }).click();
      await expect.poll(() => tool.isClosed()).toBe(true);
      await expect.poll(browserViewState).toEqual({ attached: true, visible: true });
      await expect(browser.getByRole('heading', { name: 'Real native browser view' })).toBeVisible();
    } finally {
      await application.evaluate(({ clipboard }) => {
        const root = globalThis as typeof globalThis & { __railClipboardProbe?: { original: typeof clipboard.readText } };
        if (root.__railClipboardProbe) clipboard.readText = root.__railClipboardProbe.original;
        delete root.__railClipboardProbe;
      });
    }
    await test.info().attach('application-rail-measurements', { body: JSON.stringify(measurements), contentType: 'application/json' });
    console.log('APPLICATION_RAIL_LAYOUT_RESULT', JSON.stringify({ nativeSizes: sizes, zoomFactors: zooms, cases: measurements.length, alignedFooterButtons: ['screenshot', 'recording', 'settings'], settingsOpenAligned: true,
      menuItems: 6, menuInsideViewport: true, menuTopmostAndActionable: true, portalMenuRealClickOpensSelection: true, noImplicitClipboardRead: true,
      escapePreservesSettings: true, nativeBrowserViewHiddenAndRestored: true, moduleScrollingContained: true }));
  } catch (cause) { failed = true; throw cause; }
  finally {
    await application?.close().catch(cause => { if (!failed) cleanupFailure = cause; });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (failed) {
      const logs = path.join(profile, 'logs');
      if (existsSync(logs)) for (const file of readdirSync(logs)) if (file.endsWith('.log')) await test.info().attach(file, { body: readFileSync(path.join(logs, file)), contentType: 'text/plain' });
    }
    try { cleanup(root); } catch (cause) { if (!failed && !cleanupFailure) cleanupFailure = cause; }
  }
  if (cleanupFailure) throw cleanupFailure;
});
