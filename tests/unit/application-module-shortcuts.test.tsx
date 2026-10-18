// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApplicationModuleShortcuts } from '../../src/renderer/use-application-module-shortcuts';
import type { WorldlineBoxShellApi } from '../../src/shared/external-url';
import type { ApplicationMenuCommandEvent } from '../../src/shared/application-menu';
import { DEFAULT_SHORTCUT_BINDINGS, setShortcutOverride } from '../../src/shared/shortcut-bindings';
import { setShortcutRuntime } from '../../src/renderer/shortcut-runtime';

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
  document.querySelector('[data-shortcut-test-dialog]')?.remove();
  setShortcutRuntime('windows', DEFAULT_SHORTCUT_BINDINGS);
});

function Probe({ shell, active }: { shell: WorldlineBoxShellApi; active: boolean }) {
  useApplicationModuleShortcuts(shell, active);
  return createElement('input', { 'aria-label': 'Module text' });
}

describe('outer application module shortcut ownership', () => {
  it('owns fullscreen before Assets mounts, yields to text and dialogs, and cleans up on module changes', async () => {
    const listeners = new Set<(event: ApplicationMenuCommandEvent) => void>();
    const enable = vi.fn(); const fullscreen = vi.fn();
    const shell = { setBrowseShortcutAcceleratorsEnabled: vi.fn(), setApplicationShortcutAcceleratorsEnabled: enable,
      windowControl: fullscreen, onApplicationMenuCommand: (listener: (event: ApplicationMenuCommandEvent) => void) => {
        listeners.add(listener); return () => listeners.delete(listener);
      } } as unknown as WorldlineBoxShellApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    const render = async (active: boolean) => act(async () => root?.render(createElement(Probe, { shell, active })));
    await render(true); expect(enable).toHaveBeenLastCalledWith(true, true);
    for (const listener of listeners) listener({ command: 'window.toggle-fullscreen' });
    expect(fullscreen).toHaveBeenCalledTimes(1);
    await act(async () => container?.querySelector('input')?.focus());
    expect(enable).toHaveBeenLastCalledWith(false, true);
    for (const listener of listeners) listener({ command: 'window.toggle-fullscreen' });
    expect(fullscreen).toHaveBeenCalledTimes(1);
    await act(async () => { container?.querySelector('input')?.blur(); await Promise.resolve(); });
    const modal = document.createElement('div'); modal.dataset.shortcutTestDialog = ''; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    await act(async () => { document.body.append(modal); await new Promise(resolve => setTimeout(resolve, 0)); });
    for (const listener of listeners) listener({ command: 'window.toggle-fullscreen' });
    expect(fullscreen).toHaveBeenCalledTimes(1);
    await act(async () => { modal.remove(); await new Promise(resolve => setTimeout(resolve, 0)); });
    setShortcutRuntime('windows', setShortcutOverride(DEFAULT_SHORTCUT_BINDINGS, 'windows', 'window.toggle-fullscreen', { key: 'MouseBack', ctrlKey: true }));
    document.dispatchEvent(new MouseEvent('mousedown', { button: 3, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(fullscreen).toHaveBeenCalledTimes(2);
    await render(false); expect(listeners.size).toBe(0);
    document.dispatchEvent(new MouseEvent('mousedown', { button: 3, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(fullscreen).toHaveBeenCalledTimes(2);
    await render(true); expect(listeners.size).toBe(1);
    for (const listener of listeners) listener({ command: 'window.toggle-fullscreen' });
    expect(fullscreen).toHaveBeenCalledTimes(3);
  });
});
