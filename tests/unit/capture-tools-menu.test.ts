import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent, WebContentsView } from 'electron';
import { CaptureToolsMenu } from '../../src/main/capture-tools/menu';
const mock = vi.hoisted(() => ({ views: [] as unknown[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { WebContentsView: class {
    visible = false; destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => this.destroyed, close: () => { this.destroyed = true; this.webContents.emit('destroyed'); }, focus: vi.fn(), setZoomFactor: vi.fn(), setWindowOpenHandler: vi.fn(), capturePage: vi.fn(async () => ({})) });
    constructor(readonly options: unknown) { mock.views.push(this); }
    setVisible = vi.fn((value: boolean) => { this.visible = value; }); setBackgroundColor = vi.fn(); setBounds = vi.fn();
  } };
});
function owner() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ width: 960, height: 640 }),
    webContents: Object.assign(new EventEmitter(), { session: {}, isDestroyed: () => false, getZoomFactor: () => 2, focus: vi.fn() }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, hide: vi.fn() }) as unknown as BrowserWindow;
}
function current() { const view = mock.views.at(-1) as WebContentsView; return { view, event: { sender: view.webContents, senderFrame: view.webContents.mainFrame } as IpcMainInvokeEvent }; }
beforeEach(() => { mock.views = []; });
it('uses a transparent native layer at owner zoom, shows only after render readiness and returns its selected task', async () => {
  const load = vi.fn(async () => undefined), menu = new CaptureToolsMenu({ preloadPath: 'minimal.js', load }), window = owner();
  const response = menu.open(window, { locale: 'zh-CN' }), { view, event } = current();
  expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000'); expect(view.setVisible).toHaveBeenLastCalledWith(false);
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 960, height: 640 }); expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(2);
  expect(await menu.handle(event, { type: 'menu.context' })).toEqual({ ok: true, menuContext: { locale: 'zh-CN' } });
  expect((await menu.handle(event, { type: 'menu.ready' })).ok).toBe(true); expect(view.setVisible).toHaveBeenLastCalledWith(true);
  expect((await menu.handle(event, { type: 'open', task: 'screenshot' })).ok).toBe(false);
  expect((await menu.handle(event, { type: 'menu.choose', task: 'long-screenshot' })).ok).toBe(true);
  expect(await response).toBe('long-screenshot'); expect(window.hide).not.toHaveBeenCalled(); expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
});
it('denies stale and iframe commands, cancels on navigation and shutdown, and releases its owner listeners', async () => {
  const menu = new CaptureToolsMenu({ preloadPath: 'minimal.js', load: async () => undefined }), window = owner();
  const first = menu.open(window, { locale: 'en' }), { event } = current();
  expect(menu.owns({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toBe(false);
  expect(() => menu.open(window, { locale: 'en' })).toThrow('已打开');
  window.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }); expect(menu.owns(event)).toBe(true);
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }); expect(menu.owns(event)).toBe(true);
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); expect(await first).toBeUndefined(); expect(menu.owns(event)).toBe(false);
  const second = menu.open(window, { locale: 'en' }); menu.close(); expect(await second).toBeUndefined(); expect(window.listenerCount('resize')).toBe(0); expect(window.listenerCount('closed')).toBe(0);
});
it('reports load failures without leaving an attached native overlay', async () => {
  const menu = new CaptureToolsMenu({ preloadPath: 'minimal.js', load: async () => { throw Error('menu load failed'); } }), window = owner();
  await expect(menu.open(window, { locale: 'en' })).rejects.toThrow('menu load failed'); expect(window.contentView.removeChildView).toHaveBeenCalledOnce();
});
