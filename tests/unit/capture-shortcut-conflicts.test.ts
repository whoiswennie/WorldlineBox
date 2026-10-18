import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE_TOOLS_SETTINGS } from '../../src/shared/capture-tools';
import { DEFAULT_SHORTCUT_BINDINGS, setShortcutOverride } from '../../src/shared/shortcut-bindings';
import { findCaptureShortcutConflict } from '../../src/shared/capture-shortcut-conflicts';

describe('custom shortcuts and global screen tools share conflict ownership', () => {
  it('keeps both shipped sets intact on Windows and macOS', () => {
    for (const platform of ['windows', 'mac'] as const) {
      expect(findCaptureShortcutConflict(DEFAULT_SHORTCUT_BINDINGS, platform, DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts)).toBeNull();
    }
  });

  it('recognizes reordered Electron aliases across every scope', () => {
    const bindings = setShortcutOverride(DEFAULT_SHORTCUT_BINDINGS, 'windows', 'asset.rename', {
      key: 's', code: 'KeyS', ctrlKey: true, altKey: true, shiftKey: true,
    });
    expect(findCaptureShortcutConflict(bindings, 'windows', DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts))
      .toEqual({ actionId: 'asset.rename', task: 'screenshot' });
    const settings = { ...DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts, screenshot: 'Shift+Alt+CmdOrCtrl+S' };
    expect(findCaptureShortcutConflict(bindings, 'windows', settings)).toEqual({ actionId: 'asset.rename', task: 'screenshot' });
    expect(findCaptureShortcutConflict(bindings, 'mac', settings)).toBeNull();
  });

  it('also blocks a new global tool binding that would steal a default app action', () => {
    const settings = { ...DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts, screenshot: 'Shift+Control+S' };
    expect(findCaptureShortcutConflict(DEFAULT_SHORTCUT_BINDINGS, 'windows', settings))
      .toEqual({ actionId: 'asset.reveal-in-folder', task: 'screenshot' });
    expect(findCaptureShortcutConflict(DEFAULT_SHORTCUT_BINDINGS, 'windows', { ...settings, screenshot: '' })).toBeNull();
  });

  it('does not treat modified side buttons as global keyboard accelerators', () => {
    const bindings = setShortcutOverride(DEFAULT_SHORTCUT_BINDINGS, 'windows', 'asset.rename', { key: 'MouseBack', ctrlKey: true });
    expect(findCaptureShortcutConflict(bindings, 'windows', DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts)).toBeNull();
  });
});
