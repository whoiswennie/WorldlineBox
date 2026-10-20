// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserTabStrip } from '../../src/renderer/browser/BrowserTabStrip';
import { LocaleProvider } from '../../src/renderer/i18n';
import { browserZh } from '../../src/renderer/browser/messages';
import { browserRequestSchema, type BrowserTab } from '../../src/shared/browser';
import { browserTabShortcut } from '../../src/shared/browser-shortcuts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const tabs: BrowserTab[] = ['first', 'background', 'sleeping'].map((id, index) => ({ id, title: id, url: 'https://example.test/' + id,
  loading: false, pinned: false, muted: index === 2, audible: index === 1, discarded: index === 2, zoom: 1, canGoBack: false, canGoForward: false }));
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
async function mount() {
  const run = vi.fn(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<LocaleProvider initialPreference="zh-CN"><BrowserTabStrip tabs={tabs} activeId="first" run={run}
    b={key => (browserZh as unknown as Record<string, string>)[key] ?? key} /></LocaleProvider>));
  return run;
}

it('mutes a background tab by ID using a separate accessible button, without selecting it', async () => {
  const run = await mount();
  const audio = host.querySelector<HTMLButtonElement>('[aria-label="静音此标签页 · background"]')!;
  expect(audio.closest('[role="tab"]')).toBeNull(); expect(audio.getAttribute('aria-pressed')).toBe('false');
  await act(() => audio.click());
  expect(run.mock.calls).toEqual([[{ type: 'tab.mute', id: 'background', muted: true }]]);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="恢复页面声音 · sleeping"]')!.click());
  expect(run).toHaveBeenLastCalledWith({ type: 'tab.mute', id: 'sleeping', muted: false });
});

it('targets the right-clicked and middle-clicked tab rather than the active tab', async () => {
  const run = await mount(); const target = host.querySelector('[data-tab-id="background"]')!;
  await act(() => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  expect(run).toHaveBeenLastCalledWith({ type: 'tab.contextMenu', id: 'background', locale: 'zh-CN' });
  await act(() => target.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })));
  expect(run).toHaveBeenLastCalledWith({ type: 'tab.close', id: 'background' });
});

it('supports roving focus and keyboard navigation across the tab strip', async () => {
  const run = await mount(); const buttons = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  expect([...buttons].map(button => button.tabIndex)).toEqual([0, -1, -1]);
  await act(() => buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' })));
  expect(document.activeElement).toBe(buttons[2]); expect(run).toHaveBeenLastCalledWith({ type: 'tab.select', id: 'sleeping' });
});

it('resolves mute, tab switching, print and save shortcuts equally in native and shell focus', () => {
  expect(browserTabShortcut('m', true, false, false, tabs, 'background')).toEqual({ type: 'tab.mute', id: 'background', muted: true });
  expect(browserTabShortcut('Tab', true, true, false, tabs, 'first')).toEqual({ type: 'tab.select', id: 'sleeping' });
  expect(browserTabShortcut('PageDown', true, false, false, tabs, 'sleeping')).toEqual({ type: 'tab.select', id: 'first' });
  expect(browserTabShortcut('9', true, false, false, tabs, 'first')).toEqual({ type: 'tab.select', id: 'sleeping' });
  expect(browserTabShortcut('p', true, false, false, tabs, 'first')).toEqual({ type: 'page.print' });
  expect(browserTabShortcut('s', true, false, false, tabs, 'first')).toEqual({ type: 'page.save' });
  expect(browserTabShortcut('m', true, false, true, tabs, 'first')).toBeUndefined();
  expect(browserTabShortcut('m', true, false, false, tabs, 'closed')).toBeUndefined();
});

it('rejects ambiguous audio requests and unexpected control fields at the IPC boundary', () => {
  expect(browserRequestSchema.safeParse({ type: 'tab.mute', id: 'first', muted: true }).success).toBe(true);
  for (const request of [{ type: 'tab.mute', muted: true }, { type: 'tab.mute', id: 'first', muted: 'true' },
    { type: 'tab.mute', id: 'first', muted: true, all: true }, { type: 'tab.command', id: 'first', command: 'destroyAll' },
    { type: 'page.print', silent: true }, { type: 'page.save', path: 'C:/arbitrary' }]) expect(browserRequestSchema.safeParse(request).success).toBe(false);
});
