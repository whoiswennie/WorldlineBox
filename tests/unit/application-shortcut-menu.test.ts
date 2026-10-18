import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUT_BINDINGS, setShortcutOverride } from '../../src/shared/shortcut-bindings';
import { Menu } from 'electron';
import {
  installWindowsHiddenAcceleratorMenu, matchWindowsApplicationShortcut,
  resetViewerVideoShortcutMenuForTests, setWindowsApplicationShortcutAcceleratorsEnabled,
} from '../../src/main/viewer-video-shortcut-menu';

vi.mock('electron', () => {
  type Item = { id?: string; enabled?: boolean; accelerator?: string; submenu?: Item[] };
  let current: { items: Item[]; getMenuItemById(id: string): Item | undefined } | null = null;
  const find = (items: Item[], id: string): Item | undefined => {
    for (const item of items) { if (item.id === id) return item; const nested = find(item.submenu ?? [], id); if (nested) return nested; }
    return undefined;
  };
  return { BrowserWindow: { getAllWindows: () => [] }, Menu: {
    getApplicationMenu: () => current,
    setApplicationMenu: (menu: typeof current) => { current = menu; },
    buildFromTemplate: (items: Item[]) => ({ items, getMenuItemById: (id: string) => find(items, id) }),
  } };
});

afterEach(() => resetViewerVideoShortcutMenuForTests());

describe.skipIf(process.platform === 'darwin')('application hidden accelerator ownership', () => {
  it('retains custom fullscreen alone outside Assets, and restores app actions when Assets resumes', () => {
    const bindings = setShortcutOverride(DEFAULT_SHORTCUT_BINDINGS, 'windows', 'window.toggle-fullscreen', { key: 'F12', code: 'F12', ctrlKey: true, shiftKey: true });
    installWindowsHiddenAcceleratorMenu(bindings);
    setWindowsApplicationShortcutAcceleratorsEnabled(true, true);
    expect(Menu.getApplicationMenu()?.getMenuItemById('shortcut.window.toggle-fullscreen.0')).toMatchObject({ enabled: true, accelerator: 'Ctrl+Shift+F12' });
    expect(Menu.getApplicationMenu()?.getMenuItemById('shortcut.asset.copy.0')).toMatchObject({ enabled: false });
    expect(matchWindowsApplicationShortcut({ key: 'F12', code: 'F12', control: true, shift: true })).toBe('window.toggle-fullscreen');
    expect(matchWindowsApplicationShortcut({ key: 'F11', code: 'F11' })).toBeNull();
    expect(matchWindowsApplicationShortcut({ key: 'c', code: 'KeyC', control: true })).toBeNull();
    expect(matchWindowsApplicationShortcut({ key: 'F12', code: 'F12', control: true, shift: true, isAutoRepeat: true })).toBeNull();
    // Rebuilding on a bindings update keeps the current module ownership.
    installWindowsHiddenAcceleratorMenu(bindings);
    expect(Menu.getApplicationMenu()?.getMenuItemById('shortcut.asset.copy.0')).toMatchObject({ enabled: false });
    setWindowsApplicationShortcutAcceleratorsEnabled(true);
    expect(Menu.getApplicationMenu()?.getMenuItemById('shortcut.asset.copy.0')).toMatchObject({ enabled: true });
    expect(matchWindowsApplicationShortcut({ key: 'c', code: 'KeyC', control: true })).toBe('asset.copy');
    setWindowsApplicationShortcutAcceleratorsEnabled(false);
    expect(matchWindowsApplicationShortcut({ key: 'F12', code: 'F12', control: true, shift: true })).toBeNull();
  });
});
