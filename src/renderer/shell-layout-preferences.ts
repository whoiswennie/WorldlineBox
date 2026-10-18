export type ShellLayout = 'islands' | 'legacy';
export const SHELL_LAYOUT_PREF_KEY = 'worldlinebox.shell-layout.v1';
export const DEFAULT_SHELL_LAYOUT: ShellLayout = 'islands';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function parseShellLayout(value: string | null): ShellLayout {
  return value === 'legacy' ? 'legacy' : DEFAULT_SHELL_LAYOUT;
}

export function loadShellLayout(storage?: Storage): ShellLayout {
  try {
    return parseShellLayout((storage ?? window.localStorage).getItem(SHELL_LAYOUT_PREF_KEY));
  } catch {
    return DEFAULT_SHELL_LAYOUT;
  }
}

export function saveShellLayout(layout: ShellLayout, storage?: Storage): void {
  try {
    (storage ?? window.localStorage).setItem(SHELL_LAYOUT_PREF_KEY, layout);
  } catch {
    // Keep the current session usable when preferences cannot be written.
  }
}
