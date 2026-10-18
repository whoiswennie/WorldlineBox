import { beforeEach, describe, expect, it } from 'vitest';
import { resetApplicationShortcutForwardForTests, shouldForwardApplicationShortcut } from '../../src/shared/application-shortcut-dedupe';

beforeEach(() => resetApplicationShortcutForwardForTests());
const input = { windowId: 1, action: 'window.toggle-fullscreen' };

describe('application shortcut path deduplication', () => {
  it('keeps a second independent key press 14 ms later', () => {
    expect(shouldForwardApplicationShortcut({ ...input, source: 'before-input' }, 1000)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, source: 'before-input' }, 1014)).toBe(true);
  });

  it('suppresses the opposite path of each press in either delivery order', () => {
    expect(shouldForwardApplicationShortcut({ ...input, source: 'before-input' }, 1000)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, source: 'menu' }, 1005)).toBe(false);
    expect(shouldForwardApplicationShortcut({ ...input, source: 'before-input' }, 1014)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, source: 'menu' }, 1018)).toBe(false);
    resetApplicationShortcutForwardForTests();
    expect(shouldForwardApplicationShortcut({ ...input, source: 'menu' }, 1000)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, source: 'before-input' }, 1005)).toBe(false);
    expect(shouldForwardApplicationShortcut({ ...input, source: 'menu' }, 1014)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, source: 'before-input' }, 1018)).toBe(false);
  });

  it('allows another window or action and handles elapsed/adjusted wall clocks', () => {
    expect(shouldForwardApplicationShortcut({ ...input, source: 'menu' }, 1000)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, windowId: 2, source: 'before-input' }, 1001)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, windowId: 2, action: 'edit.undo', source: 'menu' }, 1002)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, windowId: 2, action: 'edit.undo', source: 'before-input' }, 1052)).toBe(true);
    expect(shouldForwardApplicationShortcut({ ...input, windowId: 2, action: 'edit.undo', source: 'menu' }, 900)).toBe(true);
  });
});
