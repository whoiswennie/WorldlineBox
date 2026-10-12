const STORAGE_KEY = 'worldlinebox.show-missing-linked-files';

export interface LinkedMissingPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Missing linked files stay visible until the user turns the menu item off. */
export function readShowMissingLinkedFiles(
  storage: LinkedMissingPreferenceStorage | undefined,
): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeShowMissingLinkedFiles(
  show: boolean,
  storage: LinkedMissingPreferenceStorage | undefined,
): void {
  try {
    storage?.setItem(STORAGE_KEY, show ? '1' : '0');
  } catch {
    // The menu state still applies for this session when storage is unavailable.
  }
}
