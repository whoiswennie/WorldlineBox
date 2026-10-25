import type { ShortcutSpec } from './command-types';

/** Shared by single-asset, multi-selection, and folder commands. */
export const DELETE_FROM_DISK_SHORTCUT: ShortcutSpec = {
  mac: {
    label: '⌥⌘Delete',
    key: 'Delete',
    metaKey: true,
    altKey: true,
  },
  windows: { label: 'Shift+Delete', key: 'Delete', shiftKey: true },
};
