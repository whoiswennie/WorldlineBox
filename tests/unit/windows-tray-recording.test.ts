import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createWindowsTray } from '../../src/main/windows-tray';

const mock = vi.hoisted(() => ({ menus: [] as Electron.MenuItemConstructorOptions[][], destroyed: false }));
vi.mock('../../src/main/app-icon', () => ({ appIconImage: () => ({ resize: () => ({}) }) }));
vi.mock('electron', () => ({
  app: { quit: vi.fn() }, Menu: { buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => template },
  Tray: class extends EventEmitter {
    setToolTip() {} setContextMenu(menu: Electron.MenuItemConstructorOptions[]) { mock.menus.push(menu); }
    destroy() { mock.destroyed = true; }
  },
}));

it.runIf(process.platform === 'win32')('provides a stop-and-save fallback for hidden full-screen recording without rebuilding on every chunk', () => {
  const stop = vi.fn();
  const tray = createWindowsTray({ locale: 'zh-CN', getMainWindow: () => undefined, onQuit: vi.fn(), onStopRecording: stop });
  expect(tray).toBeDefined();
  const stopItem = () => mock.menus.at(-1)!.find(item => item.label === '停止录屏并保存' || item.label === 'Stop recording and save')!;
  expect(stopItem().enabled).toBe(false);
  tray!.updateRecording(true); expect(stopItem().enabled).toBe(true);
  const count = mock.menus.length; tray!.updateRecording(true); expect(mock.menus).toHaveLength(count);
  (stopItem().click as () => void)(); expect(stop).toHaveBeenCalledOnce();
  tray!.updateLocale('en'); expect(stopItem().label).toBe('Stop recording and save'); expect(stopItem().enabled).toBe(true);
  tray!.updateRecording(false); expect(stopItem().enabled).toBe(false);
  tray!.destroy(); expect(mock.destroyed).toBe(true);
});
