import { useSyncExternalStore } from 'react';
import {
  DEFAULT_SHELL_LAYOUT,
  SHELL_LAYOUT_PREF_KEY,
  loadShellLayout,
  saveShellLayout,
  type ShellLayout,
} from '../shell-layout-preferences';

let current: ShellLayout | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === window.localStorage
      && (event.key === SHELL_LAYOUT_PREF_KEY || event.key === null)) {
      current = loadShellLayout();
      notify();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setShellLayout(layout: ShellLayout) {
  current = layout;
  saveShellLayout(layout);
  notify();
}

/** Shared by the main shell and every independently mounted overlay root. */
export function useShellLayout(): ShellLayout {
  return useSyncExternalStore(
    subscribe,
    () => current ??= loadShellLayout(),
    () => DEFAULT_SHELL_LAYOUT,
  );
}
