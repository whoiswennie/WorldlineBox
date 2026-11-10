import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { CaptureToolsMenu } from '../../src/main/capture-tools/menu';
import { captureToolsRequestSchema, captureToolsResponseSchema } from '../../src/shared/capture-tools';

const mock = vi.hoisted(() => ({ options: undefined as Electron.PopupOptions | undefined, items: [] as Electron.MenuItemConstructorOptions[], fail: false, close: vi.fn() }));
vi.mock('electron', () => ({ Menu: { buildFromTemplate: (items: Electron.MenuItemConstructorOptions[]) => {
  mock.items = items; return { popup: (options: Electron.PopupOptions) => { mock.options = options; if (mock.fail) throw Error('native popup failed'); }, closePopup: () => { mock.close(); mock.options?.callback?.(); } };
} } }));
function owner() {
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ width: 960, height: 640 }),
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, getZoomFactor: () => 2 }), hide: vi.fn(), show: vi.fn() });
  return window as unknown as BrowserWindow;
}
beforeEach(() => { mock.options = undefined; mock.items = []; mock.fail = false; vi.clearAllMocks(); });
it('uses an actual native popup, bounds its anchor at zoom, and waits for close before returning a chosen task', async () => {
  const menu = new CaptureToolsMenu(), window = owner(); let settled = false;
  const response = menu.open(window, { locale: 'zh-CN', x: 48, y: 800 }).then(value => { settled = true; return value; });
  expect(mock.options).toMatchObject({ window, x: 96, y: 639 }); expect(mock.items.map(item => item.label)).toEqual(['截图', '录屏', '滚动长截图', '提取文字', '屏幕翻译', '划词助手']);
  mock.items[2]!.click?.({} as Electron.MenuItem, window, {} as Electron.KeyboardEvent); await Promise.resolve(); expect(settled).toBe(false);
  mock.options!.callback!(); expect(await response).toBe('long-screenshot'); expect(window.hide).not.toHaveBeenCalled(); expect(window.show).not.toHaveBeenCalled();
});
it('cancels on navigation, owner close and shutdown, releases listeners, and can reopen', async () => {
  const menu = new CaptureToolsMenu(), window = owner();
  const first = menu.open(window, { locale: 'en', x: 30, y: 40 });
  expect(() => menu.open(window, { locale: 'en', x: 30, y: 40 })).toThrow('已打开');
  window.webContents.emit('did-start-navigation', {}, 'https://new.example', false, true); expect(await first).toBeUndefined(); expect(window.listenerCount('closed')).toBe(0);
  const second = menu.open(window, { locale: 'en', x: 30, y: 40 }); window.emit('closed'); expect(await second).toBeUndefined();
  const third = menu.open(window, { locale: 'en', x: 30, y: 40 }); menu.close(); expect(await third).toBeUndefined();
  expect(window.webContents.listenerCount('did-start-navigation')).toBe(0); expect(mock.close).toHaveBeenCalledTimes(3);
});
it('reports native popup failures and validates request/response bounds', async () => {
  mock.fail = true; const menu = new CaptureToolsMenu(), window = owner();
  await expect(menu.open(window, { locale: 'en', x: 30, y: 40 })).rejects.toThrow('native popup failed'); expect(window.listenerCount('closed')).toBe(0);
  expect(captureToolsRequestSchema.safeParse({ type: 'menu.popup', locale: 'zh-CN', x: -1, y: 10 }).success).toBe(false);
  expect(captureToolsRequestSchema.safeParse({ type: 'menu.popup', locale: 'zh-CN', x: 20, y: Infinity }).success).toBe(false);
  expect(captureToolsResponseSchema.parse({ ok: true, menuTask: 'selection' })).toEqual({ ok: true, menuTask: 'selection' });
  expect(captureToolsResponseSchema.safeParse({ ok: true, menuTask: 'arbitrary-command' }).success).toBe(false);
});
