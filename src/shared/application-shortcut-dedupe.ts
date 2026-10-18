/** Deduplicate two delivery paths without throttling distinct physical presses. */
export type ApplicationShortcutSource = 'menu' | 'before-input';

let lastForwarded: { windowId: number; action: string; source: ApplicationShortcutSource; at: number } | null = null;

export function shouldForwardApplicationShortcut(input: {
  readonly windowId: number;
  readonly action: string;
  readonly source: ApplicationShortcutSource;
}, now = Date.now()): boolean {
  if (lastForwarded && lastForwarded.windowId === input.windowId && lastForwarded.action === input.action
    && lastForwarded.source !== input.source && now >= lastForwarded.at && now - lastForwarded.at < 50) {
    return false;
  }
  // A second keydown from the same path is a separate press. Auto-repeat is
  // filtered before this function; a menu/before-input duplicate uses the other path.
  lastForwarded = { ...input, at: now };
  return true;
}

export function resetApplicationShortcutForwardForTests(): void {
  lastForwarded = null;
}
