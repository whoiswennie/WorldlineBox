import type { BrowserRequest, BrowserTab } from './browser';

/** Shared by the shell and native page: shortcuts behave the same in either focus. */
export function browserTabShortcut(key: string, command: boolean, shift: boolean, alt: boolean,
  tabs: readonly BrowserTab[], activeId?: string): BrowserRequest | undefined {
  if (!command || alt || !tabs.length || !activeId) return;
  const index = tabs.findIndex(tab => tab.id === activeId);
  if (index < 0) return;
  if (key === 'Tab' || key === 'PageUp' || key === 'PageDown') {
    const backwards = key === 'PageUp' || key === 'Tab' && shift;
    return { type: 'tab.select', id: tabs[(index + (backwards ? tabs.length - 1 : 1)) % tabs.length]!.id };
  }
  if (!shift && /^[1-9]$/.test(key)) return { type: 'tab.select', id: tabs[key === '9' ? tabs.length - 1 : Math.min(Number(key) - 1, tabs.length - 1)]!.id };
  if (!shift && key.toLowerCase() === 'm') return { type: 'tab.mute', id: activeId, muted: !tabs[index]!.muted };
  if (!shift && key.toLowerCase() === 'p') return { type: 'page.print' };
  if (!shift && key.toLowerCase() === 's') return { type: 'page.save' };
}
