import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import * as koffi from 'koffi';
import { BOT_MEDIA_CHANNEL, type BotPresenceStatus } from '../../src/shared/companion-bot-media';
import type { CallPetApi } from '../../src/shared/companion-call-window';
import type { WorldlineBoxBrowserApi } from '../../src/shared/browser';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';
import { removeOwnedDirectorySync } from '../helpers/remove-owned-test-directory';

// eslint-disable-next-line no-empty-pattern -- Launches an isolated real Electron application.
test('shares the complete Apps menu and attachments between chat, video and desktop pet', async ({}) => {
  test.skip(process.platform !== 'win32', 'Windows desktop pet');
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-pet-apps-'));
  const site = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Apps sync fixture</title>'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
    const address = site.address() as { port: number };
    app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
    }) });
    const page = await app.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    const bindingDialog = page.locator('.bot-binding-backdrop');
    await expect(bindingDialog).toBeVisible();
    await enableCallVisualFixture(app, page);
    await expect(bindingDialog).toBeHidden();
    await page.getByRole('tab', { name: /联系人/u }).click();
    await page.locator('.bot-contact').filter({ has: page.getByText('GPT', { exact: true }) }).click();
    await page.evaluate(async url => {
      const browser = (Reflect.get(window, 'worldlinebox') as { browser: WorldlineBoxBrowserApi }).browser;
      const result = await browser.request({ type: 'tab.new', url });
      if (!result.ok) throw Error(result.error);
    }, 'http://127.0.0.1:' + address.port);

    const openApps = async (surface: Locator) => {
      await surface.getByRole('button', { name: '应用', exact: true }).click();
      const picker = surface.getByRole('dialog', { name: '连接应用', exact: true });
      for (const name of ['内置浏览器', '资产管理器', '小屋世界', '音乐', '哔哩哔哩视频']) {
        await expect(picker.getByRole('button', { name, exact: true })).toBeVisible();
      }
      return picker;
    };
    const chat = page.locator('.bot-main');
    await (await openApps(chat)).getByRole('button', { name: '音乐', exact: true }).click();
    await expect(chat.getByRole('button', { name: '移除音乐', exact: true })).toBeVisible();
    await chat.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与GPT会面' });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await meeting.getByRole('button', { name: '展开会面输入', exact: true }).click();
    const menu = await openApps(meeting);
    await expect(menu.getByRole('button', { name: '音乐', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await menu.press('Escape');
    await expect(menu).toBeHidden();
    await expect(meeting.getByRole('button', { name: '应用', exact: true })).toBeVisible();

    const opening = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为桌宠', exact: true }).click();
    const pet = await opening;
    const floating = pet.getByRole('dialog', { name: '与GPT会面' });
    const nativePet = await app.browserWindow(pet);
    await nativePet.evaluate(win => {
      const setShape = win.setShape.bind(win);
      win.setShape = (rectangles: Electron.Rectangle[]) => {
        Reflect.set(win, 'testDockShape', rectangles);
        setShape(rectangles);
      };
    });
    await floating.locator('.bot-call-status-row').evaluate(row => {
      const progress = row.ownerDocument.createElement('div');
      progress.className = 'bot-call-pet-progress';
      progress.textContent = '等待模型响应';
      row.append(progress);
    });
    const dock = floating.locator('.bot-call-dock');
    const edges = await dock.evaluate(element => {
      const { left, right, top } = element.getBoundingClientRect();
      return { points: [left + 2, right - 2].map(x => ({ x, y: top + 18 })), width: innerWidth, height: innerHeight };
    });
    await expect.poll(() => nativePet.evaluate((win, { points, width, height }) => {
      const shape = Reflect.get(win, 'testDockShape') as Electron.Rectangle[] | undefined;
      const bounds = win.getContentBounds();
      return points.map(point => {
        const x = point.x * bounds.width / width;
        const y = point.y * bounds.height / height;
        return shape?.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) ?? false;
      });
    }, edges)).toEqual([true, true]);
    await dock.locator('.bot-call-pet-progress').evaluate(pill => pill.remove());
    await floating.getByRole('button', { name: '更多会面功能', exact: true }).click();
    await floating.getByRole('button', { name: '移除音乐', exact: true }).click();
    await expect(chat.getByRole('button', { name: '移除音乐', exact: true })).toHaveCount(0);
    const picker = await openApps(floating);
    await picker.getByRole('button', { name: '内置浏览器', exact: true }).click();
    const tab = picker.getByRole('option', { name: /Apps sync fixture/u });
    await expect(tab).toBeVisible();
    expect(await picker.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
    })).toBe(true);
    await tab.click();
    const removeBrowser = '移除网页上下文';
    await expect(floating.getByRole('button', { name: removeBrowser })).toBeVisible();
    await chat.getByRole('button', { name: removeBrowser }).click();
    await expect(floating.getByRole('button', { name: removeBrowser })).toHaveCount(0);
    await expect(floating.getByRole('button', { name: '会面聊天记录', exact: true })).toHaveCount(0);
    await floating.getByRole('button', { name: '场景与互动', exact: true }).click();
    const interactions = floating.getByRole('complementary', { name: '场景与形象互动' });
    await expect(interactions).toBeVisible();
    await interactions.getByRole('button', { name: '收起会面面板' }).click();
    await expect(interactions).toBeHidden();
  } finally {
    await app?.close();
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
    removeOwnedDirectorySync(profile);
  }
});

// eslint-disable-next-line no-empty-pattern -- Uses the real desktop and native input.
test('desktop pet passes clicks through empty space and keeps its own controls interactive', async ({}) => {
  test.skip(process.platform !== 'win32', 'Windows desktop pet');
  test.setTimeout(150_000);
  const user32 = koffi.load('user32.dll');
  const setCursorPos = user32.func('int SetCursorPos(int x, int y)');
  const mouseEvent = user32.func('void mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t extra)');
  const windowFromPoint = user32.func('uintptr_t WindowFromPoint(int64_t point)');
  const getAncestor = user32.func('uintptr_t GetAncestor(uintptr_t window, uint32_t flags)');
  const getWindowRect = user32.func('int GetWindowRect(uintptr_t window, uint8_t *rect)');
  const setThreadDpiAwarenessContext = user32.func('intptr_t SetThreadDpiAwarenessContext(intptr_t value)');
  const previousDpi = setThreadDpiAwarenessContext(-4);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-pet-input-'));
  const launch = resolveElectronLaunchOptions();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ ...launch, env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
    }) });
    const page = await app.firstWindow();
    const companions = page.locator('[data-application-module="companions"]');
    await companions.click();
    await expect(page.getByRole('button', { name: '拨打伙伴电话', exact: true })).toBeDisabled();
    await enableCallVisualFixture(app, page);
    const tabs = page.locator('.bot-sidebar-tabs');
    await tabs.getByRole('tab', { name: /联系人/u }).click();
    await page.locator('.bot-contact').filter({ has: page.getByText('GPT', { exact: true }) }).click();
    const owner = await app.browserWindow(page);
    await owner.evaluate(native => { native.show(); native.maximize(); native.webContents.setAudioMuted(true); });
    const gpt = page.getByRole('dialog', { name: '与GPT会面' });
    const connect = async (meeting: Locator) => {
      await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
      await meeting.getByRole('button', { name: '接通', exact: true }).click();
    };
    await connect(gpt);
    const opening = app.waitForEvent('window');
    await gpt.getByRole('button', { name: '切换为桌宠' }).click();
    const pet = await opening;
    const nativePet = await app.browserWindow(pet);
    const floating = pet.getByRole('dialog', { name: '与GPT会面' });
    const anchor = floating.locator('.bot-call-compact-anchor');
    const avatar = anchor.locator('img');
    await expect(avatar).toBeVisible();
    await expect(floating.locator('.bot-call-portrait-frame, .bot-call-live2d')).toHaveCount(0);
    await expect(floating).toHaveAttribute('aria-modal', 'false');
    await expect(page.locator('.bot-workspace')).not.toHaveClass(/is-modal-open/u);
    await expect(page.locator('.bot-main').getByRole('textbox', { name: '发送消息…' })).toBeVisible();
    const probe = await app.evaluate(async ({ BrowserWindow, screen }, petId) => {
      const petWindow = BrowserWindow.fromId(petId)!;
      const bounds = petWindow.getContentBounds();
      const overlay = new BrowserWindow({ title: 'Desktop pet input test', frame: false, show: false, alwaysOnTop: true, ...bounds });
      const html = '<button id="under" style="position:fixed;inset:0" onclick="this.dataset.clicks=(+this.dataset.clicks||0)+1">Behind the pet</button><div style="height:200vh"></div>';
      await overlay.loadURL('data:text/html,' + encodeURIComponent(html));
      overlay.showInactive();
      petWindow.moveTop();
      const workArea = screen.getDisplayMatching(bounds).workArea;
      return { id: overlay.id, limit: { width: Math.min(470, workArea.width), height: Math.min(630, workArea.height) },
        handle: overlay.getNativeWindowHandle().toString('hex') };
    }, await nativePet.evaluate(native => native.id));
    const probePage = app.windows().find(window => window.url().startsWith('data:text/html'))!;
    const petId = await nativePet.evaluate(native => native.id);
    const nativeCoordinates = (point: { x: number; y: number }) => app!.evaluate(({ BrowserWindow, screen }, { id, point }) => {
      const { x, y } = BrowserWindow.fromId(id)!.getContentBounds();
      return screen.dipToScreenPoint({ x: Math.round(x + point.x), y: Math.round(y + point.y) });
    }, { id: petId, point });
    const rootAt = ({ x, y }: { x: number; y: number }) => {
      const handle = getAncestor(windowFromPoint(BigInt.asIntN(64, BigInt(x >>> 0) | BigInt(y >>> 0) << 32n)), 2);
      return BigInt(handle);
    };
    const nativeHandle = (hex: string) => {
      const buffer = Buffer.from(hex, 'hex');
      return buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
    };
    const petHandle = nativeHandle(await nativePet.evaluate(native => native.getNativeWindowHandle().toString('hex')));
    const underHandle = nativeHandle(probe.handle);
    const click = (point: { x: number; y: number }) => {
      expect(setCursorPos(point.x, point.y)).toBe(1);
      mouseEvent(2, 0, 0, 0, 0);
      mouseEvent(4, 0, 0, 0, 0);
    };
    const corner = await nativeCoordinates({ x: 26, y: 30 });
    await expect.poll(() => rootAt(corner)).toBe(underHandle);
    const orb = floating.getByRole('button', { name: '展开会面输入', exact: true });
    await expect(orb).toHaveCSS('clip-path', 'circle(50%)');
    const orbBox = (await orb.boundingBox())!;
    const avatarCorner = await nativeCoordinates({ x: orbBox.x + 2, y: orbBox.y + 2 });
    await expect.poll(() => rootAt(avatarCorner)).toBe(underHandle);
    click(corner);
    await expect(probePage.locator('#under')).toHaveAttribute('data-clicks', '1');
    // Wheel delivery depends on Windows' inactive-scroll preference. Keep
    // the application below focused while the pet stays topmost.
    await app.evaluate(({ BrowserWindow }, { probeId, petId }) => {
      BrowserWindow.fromId(probeId)?.focus();
      BrowserWindow.fromId(petId)?.moveTop();
    }, { probeId: probe.id, petId });
    await expect.poll(() => app!.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(), probe.id)).toBe(true);
    await expect(async () => {
      expect(setCursorPos(corner.x, corner.y)).toBe(1);
      expect(rootAt(corner)).toBe(underHandle);
      mouseEvent(0x0800, 0, 0, (-120) >>> 0, 0);
      await expect.poll(() => probePage.evaluate(() => scrollY), { timeout: 400 }).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });
    await expect(probePage.locator('#under')).toHaveAttribute('data-clicks', '1');
    const closeProbe = probePage.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), probe.id);
    await closeProbe;
    await nativePet.evaluate(native => { native.focus(); native.moveTop(); });
    expect(orbBox.width).toBe(42);
    await expect(avatar).toBeVisible();
    const orbPoint = await nativeCoordinates({ x: orbBox.x + orbBox.width / 2, y: orbBox.y + orbBox.height / 2 });
    await expect.poll(() => rootAt(orbPoint)).toBe(petHandle);
    const more = floating.getByRole('button', { name: '更多会面功能' });
    await expect(async () => {
      if (await orb.isVisible()) click(orbPoint);
      await expect(more).toBeVisible({ timeout: 450 });
    }).toPass({ timeout: 5000 });
    await expect.poll(() => anchor.boundingBox()).toEqual(orbBox);
    await expect(floating.locator('.bot-call-dock .bot-call-compact-anchor')).toHaveCount(0);
    await nativePet.evaluate(native => native.moveTop());
    const box = (await more.boundingBox())!;
    const menuPoint = await nativeCoordinates({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await expect.poll(() => rootAt(menuPoint)).toBe(petHandle);
    click(menuPoint);
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => anchor.boundingBox()).toEqual(orbBox);
    await anchor.click();
    await expect(orb).toBeVisible();
    // Exercise the recording status's layout without capturing the real desktop.
    await pet.locator('.bot-call-status-row').evaluate(row => {
      const pill = row.ownerDocument.createElement('div');
      pill.className = 'bot-presence-status';
      pill.setAttribute('data-recording-fixture', '');
      pill.textContent = '大肥鱼正在观察你 · 我在录下这段画面';
      row.append(pill);
    });
    const recording = floating.locator('[data-recording-fixture]');
    await expect(recording).toBeVisible();
    await expect.poll(() => anchor.boundingBox()).toEqual(orbBox);
    const pill = (await recording.boundingBox())!;
    expect(pill.x + pill.width).toBeLessThan(orbBox.x);
    await recording.evaluate(element => element.remove());
    const startBounds = await nativePet.evaluate(native => native.getBounds());
    const physicalSize = () => {
      const rect = Buffer.alloc(16);
      expect(getWindowRect(petHandle, rect)).toBe(1);
      return [rect.readInt32LE(8) - rect.readInt32LE(0), rect.readInt32LE(12) - rect.readInt32LE(4)];
    };
    const startSize = physicalSize();
    await pet.evaluate(() => document.addEventListener('pointerdown', event => {
      if ((event.target as Element).closest('[data-pet-drag]')) document.documentElement.dataset.gripPressed = 'true';
    }));
    const dragAvatar = async (move: (point: { x: number; y: number }) => { x: number; y: number }, verify: () => Promise<void>) => {
      const grip = (await anchor.boundingBox())!;
      const start = await nativeCoordinates({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 });
      await pet.evaluate(() => { delete document.documentElement.dataset.gripPressed; });
      await expect.poll(() => rootAt(start)).toBe(petHandle);
      expect(setCursorPos(start.x, start.y)).toBe(1);
      mouseEvent(2, 0, 0, 0, 0);
      try {
        await expect(pet.locator('html')).toHaveAttribute('data-grip-pressed', 'true');
        const moved = move(start);
        expect(setCursorPos(Math.round((start.x + moved.x) / 2), Math.round((start.y + moved.y) / 2))).toBe(1);
        await pet.evaluate(() => new Promise(requestAnimationFrame));
        expect(setCursorPos(moved.x, moved.y)).toBe(1);
        await verify();
      } finally { mouseEvent(4, 0, 0, 0, 0); }
    };
    await dragAvatar(start => ({ x: start.x - 105, y: start.y - 30 }), async () => {
      await expect.poll(async () => (await nativePet.evaluate(native => native.getBounds())).x).toBeLessThan(startBounds.x - 30);
    });
    // Electron's DIP rounding can change by one depending on the new pixel origin.
    expect(physicalSize()).toEqual(startSize);
    await expect(orb).toBeVisible();
    await nativePet.evaluate(native => native.setSize(1400, 1000));
    await expect.poll(async () => {
      const [width, height] = await nativePet.evaluate(native => native.getSize());
      return width! <= probe.limit.width + 1 && height! <= probe.limit.height + 1;
    }).toBe(true);
    expect((await floating.locator('.bot-call-dock').boundingBox())!.width).toBeLessThanOrEqual(446);
    const { workArea, topLeft, bottomRight, midpoint } = await app.evaluate(({ BrowserWindow, screen }, id) => {
      const bounds = BrowserWindow.fromId(id)!.getBounds();
      const { workArea } = screen.getDisplayMatching(bounds);
      return {
        workArea,
        topLeft: screen.dipToScreenPoint({ x: workArea.x + 2, y: workArea.y + 2 }),
        bottomRight: screen.dipToScreenPoint({ x: workArea.x + workArea.width - 2, y: workArea.y + workArea.height - 2 }),
        midpoint: screen.dipToScreenPoint({ x: workArea.x + Math.round(workArea.width / 2), y: workArea.y + Math.round(workArea.height / 2) }),
      };
    }, petId);
    const anchorOnScreen = async () => {
      const { x, y } = await nativePet.evaluate(native => native.getContentBounds());
      const local = (await anchor.boundingBox())!;
      return { x: x + local.x, y: y + local.y, width: local.width, height: local.height };
    };
    const checkEdges = async (side: 'left' | 'right', edge: 'top' | 'bottom') => {
      await expect(pet.locator('html')).toHaveAttribute('data-call-pet-side', side);
      await expect(pet.locator('html')).toHaveAttribute('data-call-pet-edge', edge);
      await expect.poll(async () => {
        const { x, y, width, height } = await anchorOnScreen();
        const horizontal = side === 'left' ? x - workArea.x : workArea.x + workArea.width - x - width;
        const vertical = edge === 'top' ? y - workArea.y : workArea.y + workArea.height - y - height;
        return Math.max(Math.abs(horizontal - 4), Math.abs(vertical - 4));
      }).toBeLessThanOrEqual(2);
    };
    await dragAvatar(() => topLeft, () => checkEdges('left', 'top'));
    const leftPlacement = await anchorOnScreen();
    await orb.click();
    await more.click();
    const topMenu = floating.locator('.bot-call-pet-options');
    await expect(topMenu).toBeVisible();
    await expect.poll(anchorOnScreen).toEqual(leftPlacement);
    const topDock = (await floating.locator('.bot-call-dock').boundingBox())!;
    const leftAnchor = (await anchor.boundingBox())!;
    expect(topDock.x).toBeGreaterThan(leftAnchor.x + leftAnchor.width);
    expect((await topMenu.boundingBox())!.y).toBeGreaterThan(topDock.y);
    await anchor.click();
    await expect(orb).toBeVisible();
    await dragAvatar(() => midpoint, async () => {
      await expect(async () => {
        const { x, y, width, height } = await anchorOnScreen();
        expect(Math.abs(x + width / 2 - workArea.x - workArea.width / 2)).toBeLessThanOrEqual(2);
        expect(Math.abs(y + height / 2 - workArea.y - workArea.height / 2)).toBeLessThanOrEqual(2);
      }).toPass({ timeout: 5000 });
    });
    await dragAvatar(() => bottomRight, () => checkEdges('right', 'bottom'));
    await dragAvatar(() => ({ x: topLeft.x, y: bottomRight.y }), () => checkEdges('left', 'bottom'));
    await dragAvatar(() => ({ x: bottomRight.x, y: topLeft.y }), () => checkEdges('right', 'top'));
    await dragAvatar(() => bottomRight, () => checkEdges('right', 'bottom'));
    const placed = await anchorOnScreen();
    await page.locator('.bot-conversation').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    await expect(page.locator('.bot-chat-title h2')).toHaveText('大肥鱼');
    await expect(avatar).toBeVisible();
    await page.locator('[data-application-module="dsh"]').click();
    await expect(page.locator('[data-application-view="dsh"]')).toBeVisible();
    await expect(avatar).toBeVisible();
    await orb.click();
    await more.click();
    await floating.getByRole('button', { name: '返回会面场景' }).click().catch(error => { if (!pet.isClosed()) throw error; });
    await expect(gpt).toBeVisible();
    await expect(page.locator('[data-application-view="companions"]')).toBeVisible();
    const reopening = app.waitForEvent('window');
    await gpt.getByRole('button', { name: '切换为桌宠', exact: true }).click();
    const reopened = await reopening;
    const reopenedNative = await app.browserWindow(reopened);
    const reopenedAnchor = reopened.locator('.bot-call-compact-anchor');
    await expect(reopenedAnchor).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => {
      const { x, y } = await reopenedNative.evaluate(native => native.getContentBounds());
      const local = (await reopenedAnchor.boundingBox())!;
      return Math.max(Math.abs(x + local.x - placed.x), Math.abs(y + local.y - placed.y));
    }).toBeLessThanOrEqual(2);
    await reopened.getByRole('button', { name: '更多会面功能', exact: true }).click();
    await reopened.getByRole('button', { name: '返回会面场景' }).click().catch(error => { if (!reopened.isClosed()) throw error; });
    await gpt.getByRole('button', { name: '挂断', exact: true }).click();
    await expect(gpt).toHaveCount(0);
    await expect(page.locator('.bot-workspace')).not.toHaveClass(/is-modal-open/u);
  } finally {
    await app?.close();
    if (previousDpi) setThreadDpiAwarenessContext(previousDpi);
    removeOwnedDirectorySync(profile);
  }
});

test('desktop pet bounds long companion errors and keeps the diagnostics reachable', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop pet');
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-pet-error-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    const call = page.getByRole('button', { name: '拨打伙伴电话', exact: true });
    await expect(call).toBeDisabled();
    await enableCallVisualFixture(app, page);
    await page.locator('.bot-sidebar-tabs').getByRole('tab', { name: /联系人/u }).click();
    await page.locator('.bot-contact').filter({ has: page.getByText('GPT', { exact: true }) }).click();
    await call.click();
    const meeting = page.getByRole('dialog', { name: '与GPT会面' });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    const opening = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为桌宠' }).click();
    const pet = await opening;
    const anchor = pet.locator('.bot-call-compact-anchor');
    await expect(anchor).toBeVisible();
    const nativePet = await app.browserWindow(pet);
    await expect.poll(() => nativePet.evaluate(win => win.isVisible())).toBe(true);
    const avatar = (await anchor.boundingBox())!;
    const drag = await app.evaluate(({ BrowserWindow, screen }, { id, x, y }) => {
      const bounds = BrowserWindow.fromId(id)!.getContentBounds();
      const { workArea } = screen.getDisplayMatching(bounds);
      return { start: { x: bounds.x + x, y: bounds.y + y },
        end: { x: workArea.x + 2, y: workArea.y + workArea.height - 2 } };
    }, { id: await nativePet.evaluate(win => win.id), x: avatar.x + avatar.width / 2, y: avatar.y + avatar.height / 2 });
    await page.evaluate(({ start, end }) => {
      const { companionCallPet } = Reflect.get(window, 'worldlinebox') as { companionCallPet: CallPetApi };
      companionCallPet.command({ type: 'drag-start', ...start });
      companionCallPet.command({ type: 'drag-move', ...end });
      companionCallPet.command('drag-end');
    }, drag);
    await expect(pet.locator('html')).toHaveAttribute('data-call-pet-side', 'left');
    await expect(pet.locator('html')).toHaveAttribute('data-call-pet-edge', 'bottom');
    await anchor.click();
    const rawError = `Provider response failed\n${'UnbrokenProviderOutput'.repeat(120)}\n${'Nested diagnostic detail\n'.repeat(120)}END`;
    await app.evaluate(({ ipcMain }, { channel, error }) => {
      const presence: BotPresenceStatus = { cycle: 1, capture: 'screen', vision: true, thinking: false, error };
      let started = false;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, input: { type: string }) => {
        if (input.type === 'desktop.presence.start') {
          if (started) return { ok: false, error: 'LlmError: Request timed out. (UND_ERR_CONNECT_TIMEOUT)' };
          started = true;
        }
        return { ok: true, presence };
      });
    }, { channel: BOT_MEDIA_CHANNEL, error: rawError });
    const controls = pet.getByRole('button', { name: '更多会面功能', exact: true });
    const startPresence = async () => {
      if (await controls.getAttribute('aria-expanded') === 'false') await controls.click();
      await pet.getByRole('button', { name: '陪伴设置', exact: true }).click();
      await pet.getByRole('combobox', { name: '精力值', exact: true }).selectOption('low');
      await pet.getByRole('button', { name: '开始陪伴', exact: true }).click();
      await anchor.click();
    };
    const error = pet.locator('.bot-presence-error');
    const status = pet.locator('.bot-call-status-row .bot-presence-status');
    await startPresence();
    await expect(status.getByRole('button', { name: '暂停陪伴' })).toBeVisible();
    const preview = error.locator('.bot-error-notice > p');
    await expect(preview).toHaveCSS('-webkit-line-clamp', '2');
    expect(await preview.evaluate(node => node.scrollHeight > node.clientHeight && node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await error.evaluate(node => {
      const box = node.getBoundingClientRect();
      const status = node.closest('.bot-call-status-row')!.querySelector('.bot-presence-status')!.getBoundingClientRect();
      return { fits: box.width <= 340 && box.top >= 0 && box.left >= 0 && box.right <= innerWidth, aboveStatus: box.bottom <= status.top };
    })).toEqual({ fits: true, aboveStatus: true });
    await error.getByRole('button', { name: '查看当前实例日志' }).click();
    const logs = pet.getByRole('dialog', { name: '实例日志', exact: true });
    await expect(logs).toBeVisible();
    await logs.getByRole('button', { name: '关闭', exact: true }).click();
    await error.getByRole('button', { name: '错误详情' }).click();
    const detail = pet.getByRole('dialog', { name: '错误详情', exact: true });
    await expect(detail.locator('pre')).toHaveJSProperty('textContent', rawError);
    expect(await detail.evaluate(node => {
      const box = node.getBoundingClientRect();
      const pre = node.querySelector('pre')!;
      return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
        && pre.scrollHeight > pre.clientHeight && pre.scrollWidth <= pre.clientWidth;
    })).toBe(true);
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await status.getByRole('button', { name: '结束陪伴' }).click();
    await expect(error).toHaveCount(0);
    await anchor.click();
    await startPresence();
    await expect(error.getByRole('alert')).toContainText('模型请求超时');
    await expect(status).toHaveCount(0);
    await error.getByRole('button', { name: '关闭错误提示' }).click();
    await expect(error).toHaveCount(0);
  } finally {
    await app.close();
    removeOwnedDirectorySync(profile);
  }
});
