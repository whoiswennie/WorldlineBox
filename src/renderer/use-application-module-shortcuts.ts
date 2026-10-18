import { useEffect } from 'react';
import type { WorldlineBoxShellApi } from '../shared/external-url';
import { listenForMouseShortcutInputs, matchesRuntimeShortcut, getShortcutRuntimePlatform } from './shortcut-runtime';
import { hasActiveModalDialog } from './use-dialog-focus-trap';

function textOwnsInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/** The outer shell owns fullscreen while the lazily loaded asset module is inactive. */
export function useApplicationModuleShortcuts(shell: WorldlineBoxShellApi | undefined, active: boolean): void {
  useEffect(() => {
    if (!active || !shell) return;
    let listening = true;
    let lastAllowed: boolean | undefined;
    const allowed = () => !textOwnsInput(document.activeElement) && !hasActiveModalDialog();
    const sync = () => {
      const enabled = allowed();
      if (enabled === lastAllowed) return;
      lastAllowed = enabled;
      // No browse/edit accelerators may capture launcher/partner/browser text.
      shell.setBrowseShortcutAcceleratorsEnabled?.(false);
      shell.setApplicationShortcutAcceleratorsEnabled?.(enabled, true);
    };
    const onFocusIn = () => sync();
    const onFocusOut = () => queueMicrotask(() => { if (listening) sync(); });
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'aria-modal'], childList: true });
    sync();
    const removeCommands = shell.onApplicationMenuCommand(({ command }) => {
      if (command !== 'window.toggle-fullscreen' || !allowed()) return;
      void shell.windowControl('fullscreen-toggle');
    });
    const removeMouse = listenForMouseShortcutInputs(document, (input, event) => {
      if (!allowed() || textOwnsInput(event.target)) return;
      if (matchesRuntimeShortcut('window.toggle-fullscreen', input, getShortcutRuntimePlatform()) !== true) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void shell.windowControl('fullscreen-toggle');
    });
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      listening = false; observer.disconnect(); removeCommands(); removeMouse();
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
    };
  }, [active, shell]);
}
