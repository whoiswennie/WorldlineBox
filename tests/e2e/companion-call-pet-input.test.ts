import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import * as koffi from 'koffi';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';
import { removeOwnedDirectorySync } from '../helpers/remove-owned-test-directory';

// eslint-disable-next-line no-empty-pattern -- Uses the real desktop and native input.
test('desktop pet passes clicks through empty space and keeps its own controls interactive', async ({}) => {
  test.skip(process.platform !== 'win32', 'Windows desktop pet');
  test.setTimeout(150_000);
  const user32 = koffi.load('user32.dll');
  const setCursorPos = user32.func('int SetCursorPos(int x, int y)');
  const mouseEvent = user32.func('void mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t extra)');
  const windowFromPoint = user32.func('uintptr_t WindowFromPoint(int64_t point)');
  const getAncestor = user32.func('uintptr_t GetAncestor(uintptr_t window, uint32_t flags)');
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
    const avatar = floating.locator('.bot-call-portrait-frame img');
    await expect(avatar).toBeVisible();
    await expect(floating.locator('.bot-call-portrait-frame')).toHaveCSS('box-shadow', 'none');
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
    click(corner);
    await expect(probePage.locator('#under')).toHaveAttribute('data-clicks', '1');
    mouseEvent(0x0800, 0, 0, (-120) >>> 0, 0);
    await expect.poll(() => probePage.evaluate(() => scrollY)).toBeGreaterThan(0);
    const more = floating.getByRole('button', { name: '更多会面功能' });
    const box = (await more.boundingBox())!;
    const menuPoint = await nativeCoordinates({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await expect.poll(() => rootAt(menuPoint)).toBe(petHandle);
    click(menuPoint);
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(probePage.locator('#under')).toHaveAttribute('data-clicks', '1');
    const closeProbe = probePage.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), probe.id);
    await closeProbe;
    const grip = (await floating.locator('[data-pet-drag]').boundingBox())!;
    const start = await nativeCoordinates({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 });
    const startBounds = await nativePet.evaluate(native => native.getBounds());
    await pet.evaluate(() => document.addEventListener('pointerdown', event => {
      if ((event.target as Element).closest('[data-pet-drag]')) document.documentElement.dataset.gripPressed = 'true';
    }));
    await expect.poll(() => rootAt(start)).toBe(petHandle);
    expect(setCursorPos(start.x, start.y)).toBe(1);
    mouseEvent(2, 0, 0, 0, 0);
    try {
      await expect(pet.locator('html')).toHaveAttribute('data-grip-pressed', 'true');
      const moved = { x: start.x - 105, y: start.y - 30 };
      expect(setCursorPos(moved.x, moved.y)).toBe(1);
      await expect.poll(async () => (await nativePet.evaluate(native => native.getBounds())).x).toBeLessThan(startBounds.x - 30);
    } finally { mouseEvent(4, 0, 0, 0, 0); }
    expect(await nativePet.evaluate(native => native.getSize())).toEqual([startBounds.width, startBounds.height]);
    await nativePet.evaluate(native => native.setSize(1400, 1000));
    await expect.poll(async () => {
      const [width, height] = await nativePet.evaluate(native => native.getSize());
      return width! <= probe.limit.width + 1 && height! <= probe.limit.height + 1;
    }).toBe(true);
    expect((await floating.locator('.bot-call-dock').boundingBox())!.width).toBeLessThanOrEqual(446);
    await page.locator('.bot-conversation').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    await expect(page.locator('.bot-chat-title h2')).toHaveText('大肥鱼');
    await expect(avatar).toBeVisible();
    await page.locator('[data-application-module="dsh"]').click();
    await expect(page.locator('[data-application-view="dsh"]')).toBeVisible();
    await expect(avatar).toBeVisible();
    await floating.getByRole('button', { name: '返回会面场景' }).click().catch(error => { if (!pet.isClosed()) throw error; });
    await expect(gpt).toBeVisible();
    await expect(page.locator('[data-application-view="companions"]')).toBeVisible();
    await gpt.getByRole('button', { name: '挂断', exact: true }).click();
    await expect(gpt).toHaveCount(0);
    await expect(page.locator('.bot-workspace')).not.toHaveClass(/is-modal-open/u);
  } finally {
    await app?.close();
    if (previousDpi) setThreadDpiAwarenessContext(previousDpi);
    removeOwnedDirectorySync(profile);
  }
});
