import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type * as Koffi from 'koffi';
import type * as Crypto from 'node:crypto';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionWorldWindowApi } from '../../src/shared/companion-world-window';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { shareWorldHomeAddress } from './companion-world-address-helpers';
type Bridge = Window & { worldlinebox: { companionWorld: CompanionWorldWindowApi; companions?: WorldlineBoxCompanionsApi; llm?: WorldlineBoxLlmApi } };
const finalText = '世界窗口开着时，我们的聊天仍可以完整回复。';
function cleanup(root: string) {
  const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-world-windows-')) throw new Error('Unexpected world observer fixture cleanup path.');
  rmSync(resolved, { recursive: true, force: true });
}
async function observer(application: ElectronApplication, main: Page, sceneId?: string) {
  const opened = application.waitForEvent('window');
  const opening = main.evaluate(target => (window as unknown as Bridge).worldlinebox.companionWorld.open(target ? { sceneId: target } : {}), sceneId);
  const page = await opened, native = await application.browserWindow(page);
  await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 900); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
  expect((await opening).ok).toBe(true); await expect(page.getByRole('region', { name: '伙伴世界', exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toHaveAttribute('data-world-ready', 'true'); return page;
}
async function observerTheme(page: Page, theme: string, sceneId?: string) {
  await page.evaluate(value => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: value })), theme);
  await page.reload(); await expect(page.locator('.companion-world-header time')).toBeVisible();
  if (sceneId) await page.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(sceneId);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function nativeWindowIcons(application: ElectronApplication, ids: number[]) {
  return application.evaluate(async ({ BrowserWindow }, input) => {
    if (process.platform !== 'win32') return [];
    const { createRequire } = process.getBuiltinModule('node:module');
    const repoRequire = createRequire(input.packageJson), koffi = repoRequire('koffi') as typeof Koffi;
    const { createHash } = repoRequire('node:crypto') as typeof Crypto;
    const user = koffi.load('user32.dll'), gdi = koffi.load('gdi32.dll');
    const message = user.func('intptr_t SendMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wp, intptr_t lp)');
    const menu = user.func('uintptr_t GetMenu(uintptr_t hwnd)'), iconInfo = user.func('int GetIconInfo(uintptr_t icon, _Out_ uint8_t *info)');
    const dc = user.func('uintptr_t GetDC(uintptr_t hwnd)'), release = user.func('int ReleaseDC(uintptr_t hwnd, uintptr_t dc)');
    const object = gdi.func('int GetObjectW(uintptr_t object, int size, _Out_ uint8_t *info)');
    const bits = gdi.func('int GetDIBits(uintptr_t dc, uintptr_t bitmap, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, _Inout_ uint8_t *info, uint32_t usage)');
    const dispose = gdi.func('int DeleteObject(uintptr_t object)');
    const pointer = (buffer: Buffer, offset: number) => process.arch === 'x64' || process.arch === 'arm64' ? buffer.readBigUInt64LE(offset) : BigInt(buffer.readUInt32LE(offset));
    const wide = process.arch === 'x64' || process.arch === 'arm64';
    return input.ids.map(id => {
      const window = BrowserWindow.fromId(id); if (!window) throw new Error('Missing native observer window.');
      const hwnd = pointer(window.getNativeWindowHandle(), 0);
      // WM_GETICON reads the icon assigned to the actual OS window caption.
      const icon = message(hwnd, 0x007f, 0, 0) || message(hwnd, 0x007f, 2, 0) || message(hwnd, 0x007f, 1, 0);
      if (!icon) throw new Error('Native window has no explicit project icon.');
      const info = Buffer.alloc(wide ? 32 : 20); if (!iconInfo(icon, info)) throw new Error('Native icon information unavailable.');
      const mask = pointer(info, wide ? 16 : 12), color = pointer(info, wide ? 24 : 16), context = dc(0);
      try {
        const bitmap = Buffer.alloc(wide ? 32 : 24); if (!object(color, bitmap.length, bitmap)) throw new Error('Native icon bitmap unavailable.');
        const width = bitmap.readInt32LE(4), height = bitmap.readInt32LE(8);
        if (width < 1 || width > 2048 || height < 1 || height > 2048) throw new Error('Unexpected native icon dimensions: ' + JSON.stringify({ width, height, bitmap: bitmap.toString('hex'), info: info.toString('hex') }));
        const header = Buffer.alloc(40), pixels = Buffer.alloc(width * height * 4);
        header.writeUInt32LE(40, 0); header.writeInt32LE(width, 4); header.writeInt32LE(-height, 8); header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
        if (bits(context, color, 0, height, pixels, header, 0) !== height) throw new Error('Native icon pixels unavailable.');
        return { id, title: window.getTitle(), width, height, sha256: createHash('sha256').update(pixels).digest('hex'), hasMenu: !!menu(hwnd), menuVisible: window.isMenuBarVisible(), nativeCaption: window.getBounds().height - window.getContentBounds().height > 20 };
      } finally { release(0, context); if (mask) dispose(mask); if (color) dispose(color); }
    });
  }, { ids, packageJson: path.resolve('package.json') });
}
// eslint-disable-next-line no-empty-pattern
test('native observer windows share one world, preserve independent cameras and leave chat usable when another observer closes', async ({}, testInfo) => {
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-windows-'));
  const visualOutput = path.resolve('.tools/test-output/world-window-qa'); mkdirSync(visualOutput, { recursive: true });
  let primaryRequests = 0, application: ElectronApplication | undefined;
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      const payload = JSON.parse(body), context = JSON.parse(payload.messages[1].content); let output: unknown;
      if (context.purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .98, evidence: [context.source.content], reason: '普通聊天无需打断休息。' };
      else if (context.purpose === 'world_decision') output = { action: null, reason: '保持当前生活计划。', appraisals: [] };
      else if (context.purpose === 'world_social') output = { text: null, reason: '地址已经送达，本例不继续新的话题。' };
      else if (context.purpose === 'memory_query') output = {};
      else if (context.purpose === 'memory_dream') output = { candidates: [], dream: null };
      else if (context.purpose?.startsWith('memory_')) output = { candidates: [] };
      else { if (context.taskRequest) primaryRequests++; output = { text: finalText, memories: [] }; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'software' }) });
    const main = await application.firstWindow(), nativeMain = await application.browserWindow(main);
    await nativeMain.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await main.evaluate(async baseUrl => {
      const bridge = (window as unknown as Bridge).worldlinebox;
      await bridge.llm!.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'window-fixture', apiKey: 'fixture-window-key' });
      await bridge.companions!.request({ type: 'conversation.open', companionId: 'deepseek-sister' });
      const world = (await bridge.companions!.request({ type: 'world.snapshot' })).world!;
      await bridge.companions!.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
      const routine = (await bridge.companions!.request({ type: 'routine.get', companionId: 'deepseek-sister', conversationId: 'private-deepseek-sister' })).routine!;
      const clock = (delta: number) => String((Math.floor(world.clock.hour) + delta + 24) % 24).padStart(2, '0') + ':00';
      await bridge.companions!.request({ type: 'routine.configure', companionId: 'deepseek-sister', conversationId: 'private-deepseek-sister', expectedRevision: routine.revision,
        patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
    }, 'http://127.0.0.1:' + address.port);
    await main.locator('[data-application-module="companions"]').click(); await main.locator('[data-companion-conversation="private-deepseek-sister"]').click();
    const a = await observer(application, main, 'home_deepseek-sister'), b = await observer(application, main, 'home_deepseek-flash');
    const nativeA = await application.browserWindow(a), nativeBIcon = await application.browserWindow(b);
    const nativeIds = await Promise.all([nativeMain, nativeA, nativeBIcon].map(window => window.evaluate(value => value.id)));
    const icons = await nativeWindowIcons(application, nativeIds);
    if (process.platform === 'win32') {
      expect(icons).toHaveLength(3);
      for (const icon of icons.slice(1)) { expect(icon.sha256).toBe(icons[0]!.sha256); expect(icon.hasMenu).toBe(false); expect(icon.menuVisible).toBe(false); expect(icon.nativeCaption).toBe(true); }
      await testInfo.attach('native-project-icons-and-menu', { body: JSON.stringify(icons), contentType: 'application/json' });
    }
    expect(await a.getByText('A LITTLE WORLD, TOGETHER', { exact: true }).count()).toBe(0);
    expect(await a.getByText('日子，在这里发生', { exact: true }).count()).toBe(0);
    await nativeA.evaluate(window => window.setSize(720, 760));
    for (const theme of ['light', 'dark']) {
      await observerTheme(a, theme);
      const header = a.locator('.companion-world-header');
      expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().height <= 84)).toBe(true);
      await expect(header.locator('time')).toBeVisible(); await expect(header).toContainText('室外');
      await a.screenshot({ path: path.join(visualOutput, 'world-header-' + theme + '.png') });
    }
    await nativeA.evaluate(window => window.setSize(1440, 900));
    await a.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('commons');
    await expect(a.getByRole('img', { name: '伙伴街区地图，家庭与真实出行路线', exact: true })).toBeVisible();
    await expect(a.locator('[data-world-map-garden]')).toContainText('公共花园');
    expect(await a.locator('.world-map-tree circle').count()).toBeGreaterThanOrEqual(9);
    expect(await a.locator('.world-map-bench').count()).toBe(2);
    expect(await a.locator('[data-world-map-home]').count()).toBeGreaterThanOrEqual(15);
    expect(await a.locator('.companion-world-view').evaluate(element => getComputedStyle(element).visibility)).toBe('hidden');
    await shareWorldHomeAddress(main, 'deepseek-flash', ['deepseek-sister']);
    const moved = await main.evaluate(async () => {
      const api = (window as unknown as Bridge).worldlinebox.companions!;
      const current = (await api.request({ type: 'world.snapshot' })).world!;
      const entrance = current.scenes.find(scene => scene.id === 'commons')!.objects.find(object => object.id === 'deepseek-flash_entrance')!;
      return api.request({ type: 'world.tool', companionId: 'deepseek-sister', conversationId: 'private-deepseek-sister', arguments: { action: 'move', destinationId: entrance.id } });
    });
    expect(moved.ok, moved.error).toBe(true);
    const mapActor = a.locator('[data-world-map-actor="deepseek-sister"]');
    await expect(mapActor).toBeVisible({ timeout: 20000 });
    await expect(a.locator('[data-world-map-route="deepseek-sister"]')).toHaveAttribute('points', /\S+ \S+/, { timeout: 10000 });
    await a.screenshot({ path: path.join(visualOutput, 'world-neighborhood-travel.png') });
    await expect.poll(async () => {
      const world = (await main.evaluate(() => (window as unknown as Bridge).worldlinebox.companions!.request({ type: 'world.snapshot' }))).world!;
      const actual = world.actors.find(actor => actor.companionId === 'deepseek-sister')!;
      if (actual.sceneId !== 'commons' || actual.route.length) return false;
      return await mapActor.getAttribute('data-world-position') === `${actual.position.x},${actual.position.y}`;
    }, { timeout: 50000, intervals: [500] }).toBe(true);
    for (const theme of ['light', 'dark']) {
      await observerTheme(a, theme, 'commons');
      await a.screenshot({ path: path.join(visualOutput, 'world-neighborhood-' + theme + '.png') });
    }
    const homeward = await main.evaluate(() => (window as unknown as Bridge).worldlinebox.companions!.request({ type: 'world.tool', companionId: 'deepseek-sister', conversationId: 'private-deepseek-sister', arguments: { action: 'move', destinationId: 'home_deepseek-sister' } }));
    expect(homeward.ok, homeward.error).toBe(true);
    await expect.poll(async () => (await main.evaluate(() => (window as unknown as Bridge).worldlinebox.companions!.request({ type: 'world.snapshot' }))).world!.actors.find(actor => actor.companionId === 'deepseek-sister')!.sceneId, { timeout: 20000 }).toBe('home_deepseek-sister');
    await a.getByRole('button', { name: '观察大肥鱼的小屋', exact: true }).click();
    await expect(a.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-sister');
    await expect(a.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
    const mainPortrait = await main.locator('[data-companion-conversation="private-deepseek-sister"] .companion-avatar').evaluate(element => {
      const style = getComputedStyle(element); return { size: style.backgroundSize, position: style.backgroundPosition, repeat: style.backgroundRepeat };
    });
    await expect(a.locator('[data-world-actor="deepseek-sister"] .companion-avatar')).toBeVisible();
    expect(await a.locator('[data-world-actor="deepseek-sister"] .companion-avatar').evaluate(element => {
      const style = getComputedStyle(element); return { size: style.backgroundSize, position: style.backgroundPosition, repeat: style.backgroundRepeat };
    })).toEqual(mainPortrait);
    expect(mainPortrait).toEqual({ size: 'cover', position: '50% 50%', repeat: 'no-repeat' });
    await a.getByRole('button', { name: '世界设置', exact: true }).click();
    expect(await a.getByRole('button', { name: '关闭世界设置', exact: true }).evaluate(element => {
      const style = getComputedStyle(element); return { border: style.borderTopWidth, radius: style.borderRadius, width: style.width };
    })).toEqual({ border: '0px', radius: '8px', width: '32px' });
    for (const title of ['保存世界设置', '再想想']) expect(await a.getByRole('button', { name: title, exact: true }).evaluate(element => {
      const style = getComputedStyle(element); return { height: style.minHeight, radius: style.borderRadius, horizontalPadding: style.paddingLeft, font: style.fontFamily };
    })).toEqual({ height: '36px', radius: '8px', horizontalPadding: '20px', font: await a.locator('.companion-world').evaluate(element => getComputedStyle(element).fontFamily) });
    await a.getByRole('button', { name: '关闭世界设置', exact: true }).click();
    for (const page of [a, b]) {
      expect(await page.evaluate(() => Object.keys((window as unknown as Bridge).worldlinebox))).toEqual(['companionWorld']);
      expect(await page.evaluate(async () => { try { await (window as unknown as Bridge).worldlinebox.companionWorld.request({ type: 'message.send' } as never); return false; } catch { return true; } })).toBe(true);
    }
    const ca = await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context()), cb = await b.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context());
    expect(ca.context!.observerKey).not.toBe(cb.context!.observerKey); expect(cb.context!.visibleWindowCount).toBe(2);
    expect(Object.keys(ca.context!.companions[0]!)).toEqual(expect.arrayContaining(['id', 'name', 'avatar'])); expect(ca.context!.companions.every(contact => !('persona' in contact) && !('llm' in contact))).toBe(true);
    await expect(a.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-sister');
    await expect(b.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-flash');
    const first = await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.request({ type: 'world.snapshot' }));
    await main.waitForTimeout(1400); const second = await b.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.request({ type: 'world.snapshot' }));
    expect(Math.abs((Date.parse(second.world!.clock.virtualNow) - Date.parse(first.world!.clock.virtualNow)) - (Date.parse(second.world!.clock.realNow) - Date.parse(first.world!.clock.realNow)))).toBeLessThan(200);
    await main.getByRole('textbox', { name: '输入消息', exact: true }).fill('两个独立世界窗口打开时，聊天应该仍然正常。');
    await main.getByRole('button', { name: '发送', exact: true }).click();
    await expect(main.locator('[data-companion-messages]')).toContainText(finalText, { timeout: 30000 }); expect(primaryRequests).toBe(1);
    expect(await application.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.type === 'Utility' && (metric.name === 'WorldlineBox Companion Storage' || metric.serviceName === 'WorldlineBox Companion Storage')).length)).toBe(1);
    const nativeB = await application.browserWindow(b);
    await nativeB.evaluate(window => window.minimize());
    await expect.poll(async () => (await b.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context?.visible).toBe(false);
    expect((await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context!.visibleWindowCount).toBe(1);
    await nativeB.evaluate(window => { window.restore(); window.showInactive(); });
    await expect.poll(async () => (await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context?.visibleWindowCount).toBe(2);
    await expect.poll(() => a.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').sceneId, ca.context!.observerKey)).toBe('home_deepseek-sister');
    await a.close(); expect(main.isClosed()).toBe(false); expect(b.isClosed()).toBe(false);
    expect((await b.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.request({ type: 'world.snapshot' }))).ok).toBe(true);
    const restored = await observer(application, main);
    expect((await restored.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context!.observerKey).toBe(ca.context!.observerKey);
    await expect(restored.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-sister');
    await expect(b.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-flash');
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true }); await restored.screenshot({ path: path.join(artifacts, 'verified-world-native-window.png') });
    await testInfo.attach('observer-identity', { body: JSON.stringify({ a: ca.context, b: cb.context, primaryRequests }), contentType: 'application/json' });
  } finally {
    await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    cleanup(root);
  }
});
