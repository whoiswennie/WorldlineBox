import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { _electron as electron, expect, test } from '@playwright/test';
import type { BrowserRequest, WorldlineBoxBrowserApi } from '../../src/shared/browser';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Actual native popup, original WebContentsView and compositor.
test('keeps the browser live behind the real global tools popup and leaves other modules intact', async ({}) => {
  test.setTimeout(120000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-tools-menu-live-')), evidence = path.resolve('artifacts/tools-menu-live'); await mkdir(evidence, { recursive: true });
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>Live toolbar background</title><body style="margin:0;background:rgb(30,130,90);color:white;font:24px sans-serif"><header style="padding:24px"><h1>工具列表背后的实时网页</h1><p>打开工具列表时，网页保持显示并持续更新。</p><input id="draft" aria-label="保留的草稿"><p id="tick">0</p></header><div style="height:1600px"></div><script>window.ticks=0;setInterval(()=>document.querySelector("#tick").textContent=String(++window.ticks),100)</script>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port'); const url = `http://127.0.0.1:${address.port}/`;
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_DSH_SILENT: '1' }) });
  const page = await app.firstWindow(), report: Record<string, unknown> = { profile, actualNativePopup: true, productionIPC: true };
  const browser = async (input: BrowserRequest) => { const result = await page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { browser: WorldlineBoxBrowserApi }).browser.request(input), input); if (!result.ok) throw Error(result.error); return result; };
  const native = () => app.evaluate(async ({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows()[0]!, view = window.contentView.children.find(view => 'webContents' in view && (view as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView | undefined;
    if (!view) return undefined;
    return { id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds(), document: await view.webContents.executeJavaScript('({ticks:window.ticks,draft:document.querySelector("#draft").value,scrollY})') as { ticks: number; draft: string; scrollY: number } };
  }, url);
  try {
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0]!; window.setSize(1180, 800); window.webContents.setBackgroundThrottling(false); window.show();
      const original = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        if (!this.getMenuItemById('capture-tool-screenshot')) return original.call(this, options);
        Reflect.set(globalThis, 'liveToolsMenu', { menu: this, open: true, items: this.items.map(item => item.label) });
        return original.call(this, { ...options, callback: () => { const current = Reflect.get(globalThis, 'liveToolsMenu') as { open: boolean }; current.open = false; options?.callback?.(); } });
      };
    });
    await page.locator('[data-application-module="browser"]').click(); await browser({ type: 'tab.new', url });
    await expect.poll(native).toMatchObject({ visible: true });
    await app.evaluate(async ({ webContents }, url) => { const c = webContents.getAllWebContents().find(c => c.getURL() === url)!; await c.executeJavaScript('document.querySelector("#draft").value="保留的输入内容";window.scrollTo(0,320)'); }, url);
    const before = (await native())!; expect(before.document.scrollY).toBe(320);
    const more = page.locator('.application-capture-more'); await more.click();
    await expect.poll(() => app.evaluate(() => (Reflect.get(globalThis, 'liveToolsMenu') as { open?: boolean } | undefined)?.open)).toBe(true);
    await expect(more).toHaveAttribute('aria-expanded', 'true'); await expect(page.locator('.application-capture-menu')).toHaveCount(0);
    expect((await native())!.visible).toBe(true); expect((await native())!.bounds).toEqual(before.bounds);
    await expect.poll(async () => (await native())!.document.ticks).toBeGreaterThan(before.document.ticks + 3);
    const encoded = await app.evaluate(async ({ webContents }, url) => {
      const c = webContents.getAllWebContents().find(c => c.getURL() === url)!;
      await c.executeJavaScript('document.body.style.backgroundColor="rgb(30,90,170)";new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      return (await c.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64');
    }, url);
    const bytes = Buffer.from(encoded, 'base64'); await writeFile(path.join(evidence, 'live-browser-behind-menu.png'), bytes);
    expect([...await sharp(bytes).extract({ left: 15, top: 15, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]).toEqual([30, 90, 170]);
    const during = (await native())!; expect(during.visible).toBe(true); expect(during.id).toBe(before.id); expect(during.document.draft).toBe('保留的输入内容'); expect(during.document.scrollY).toBe(320);
    report.nativeBefore = before; report.nativeDuringMenu = during; report.livePixel = [30, 90, 170];
    await app.evaluate(({ BrowserWindow }) => (Reflect.get(globalThis, 'liveToolsMenu') as { menu: Electron.Menu }).menu.closePopup(BrowserWindow.getAllWindows()[0]));
    await expect(more).toHaveAttribute('aria-expanded', 'false'); expect((await native())!.visible).toBe(true);
    for (const module of ['dsh', 'network', 'companions']) {
      await page.locator(`[data-application-module="${module}"]`).click(); const view = page.locator(`[data-application-view="${module}"]`); await expect(view).toBeVisible();
      await view.evaluate(node => Reflect.set(window, 'toolsMenuOriginalView', node)); await more.click(); const menu = page.locator('.application-capture-menu'); await expect(menu).toBeVisible();
      expect(await view.evaluate(node => node === Reflect.get(window, 'toolsMenuOriginalView'))).toBe(true); await expect(view).toBeVisible(); await expect(menu.getByRole('menuitem')).toHaveCount(6);
      await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(view).toBeVisible();
    }
    await page.locator('[data-application-module="browser"]').click(); await expect.poll(native).toMatchObject({ visible: true, id: before.id, document: { draft: '保留的输入内容', scrollY: 320 } });
    report.otherModules = ['dsh', 'network', 'companions']; report.samePageAndViewport = true; report.passed = true; await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  } catch (error) { report.error = String(error); await writeFile(path.join(evidence, 'failure.json'), JSON.stringify(report, null, 2)); throw error; }
  finally { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
