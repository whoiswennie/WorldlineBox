// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotApps } from '../../src/renderer/companion-bot/BotApps';
import type { BrowserState, WorldlineBoxBrowserApi } from '../../src/shared/browser';
import type { BrowserPageContext } from '../../src/shared/browser-page-context';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
async function render(onAssets: () => Promise<void>, onBrowser: (context: BrowserPageContext) => Promise<void> = vi.fn(async () => undefined), browserApi?: WorldlineBoxBrowserApi, browserContext?: BrowserPageContext) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<BotApps locale="zh-CN" browserAvailable browserApi={browserApi} browserContext={browserContext} assetAttached={false} onAssets={onAssets} onBrowser={onBrowser} />));
}
it('uses a single Apps entry and only activates the explicitly chosen app', async () => {
  const assets = vi.fn(async () => undefined), browser = vi.fn(async () => undefined); await render(assets, browser);
  expect(host.querySelector('[aria-label="应用"]')?.textContent).toContain('应用'); expect(assets).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="应用"]')!.click());
  const choices = host.querySelectorAll<HTMLButtonElement>('.bot-app-choice'); expect(choices).toHaveLength(2);
  expect(host.querySelector('.bot-app-artwork,.bot-app-tile')).toBeNull(); expect(choices[0]?.querySelector('svg.bot-icon')).not.toBeNull();
  await act(() => choices[1]!.click()); expect(assets).toHaveBeenCalledOnce(); expect(browser).not.toHaveBeenCalled(); expect(host.querySelector('[role="dialog"]')).toBeNull();
});

function browserFixture() {
  let changed: ((state: BrowserState) => void) | undefined;
  const tabs = ['Alpha', 'Beta'].map((title, i) => ({ id: `tab-${i}`, title, url: `https://example.com/${i}`, loading: false, pinned: false, muted: false, zoom: 1, canGoBack: false, canGoForward: false }));
  const state: BrowserState = { tabs: [...tabs, { ...tabs[0]!, id: 'blank', url: 'about:blank' }], activeTabId: tabs[1]!.id, bookmarks: [], downloads: [], historyCount: 0, preferences: { homepage: 'about:blank', restoreSession: true, searchEngine: 'bing', askDownloadLocation: false }, permissions: [], fullscreen: false, revision: 1 };
  const context = (id: string): BrowserPageContext => ({ referenceId: crypto.randomUUID(), tabId: id, title: tabs.find(tab => tab.id === id)!.title, url: tabs.find(tab => tab.id === id)!.url, selection: '', capturedAt: new Date().toISOString() });
  const request = vi.fn<WorldlineBoxBrowserApi['request']>(async input => input.type === 'state' ? { ok: true, state } : input.type === 'page.context' ? { ok: true, pageContext: context(input.id!) } : { ok: false, error: 'Unexpected browser mutation' });
  const unsubscribe = vi.fn();
  const api: WorldlineBoxBrowserApi = { request, onChanged: listener => { changed = listener; return unsubscribe; }, capture: async () => ({ ok: false, error: 'Not used' }), onCaptureOpenAssets: () => unsubscribe, onFocus: () => unsubscribe };
  return { state, tabs, context, request, api, unsubscribe, update: (value: BrowserState) => changed?.(value) };
}
const click = async (label: string) => { await act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()); };

it('lists available tabs and attaches the explicitly chosen background page without selecting or navigating it', async () => {
  const browser = browserFixture(), selected = vi.fn(async () => undefined);
  await render(async () => undefined, selected, browser.api);
  await click('应用'); await click('内置浏览器');
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2); expect(selected).not.toHaveBeenCalled();
  await act(() => host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(selected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tabId: 'tab-0', title: 'Alpha' }));
  expect(browser.request.mock.calls.map(([input]) => input)).toEqual([{ type: 'state' }, { type: 'page.context', id: 'tab-0' }]);
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(browser.unsubscribe).toHaveBeenCalled();
});
it('marks the current attachment and replaces it with exactly one selected page', async () => {
  const browser = browserFixture(), selected = vi.fn(async () => undefined);
  await render(async () => undefined, selected, browser.api, browser.context('tab-0'));
  await click('应用'); await click('内置浏览器');
  expect(host.querySelector('[role="option"][aria-selected=true]')?.textContent).toContain('Alpha');
  await act(() => host.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click());
  expect(selected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tabId: 'tab-1' }));
});
it('updates the tab list when a page closes and supports filtering without altering the native browser', async () => {
  const browser = browserFixture(); await render(async () => undefined, async () => undefined, browser.api);
  await click('应用'); await click('内置浏览器');
  await act(() => browser.update({ ...browser.state, tabs: [browser.tabs[1]!], revision: 2 }));
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1); expect(host.textContent).not.toContain('Alpha');
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索标签页"]')!;
  await act(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(input, 'missing'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(0); expect(browser.request).toHaveBeenCalledOnce();
});
it('retains the picker after a closed or redirected page fails and lets another page succeed', async () => {
  const browser = browserFixture(), selected = vi.fn(async () => undefined);
  browser.request.mockImplementation(async input => input.type === 'state' ? { ok: true, state: browser.state } : input.type === 'page.context' && input.id === 'tab-0' ? { ok: false, error: '网页已关闭' } : { ok: true, pageContext: browser.context('tab-1') });
  await render(async () => undefined, selected, browser.api); await click('应用'); await click('内置浏览器');
  await act(() => host.querySelectorAll<HTMLButtonElement>('[role="option"]')[0]!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('网页已关闭'); expect(selected).not.toHaveBeenCalled();
  await act(() => host.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click()); expect(selected).toHaveBeenCalledOnce();
});
it('ignores a context result after the picker was closed', async () => {
  const browser = browserFixture(), selected = vi.fn(async () => undefined); let resolve!: (value: Awaited<ReturnType<WorldlineBoxBrowserApi['request']>>) => void;
  browser.request.mockImplementation(async input => input.type === 'state' ? { ok: true, state: browser.state } : new Promise(done => { resolve = done; }));
  await render(async () => undefined, selected, browser.api); await click('应用'); await click('内置浏览器');
  await act(() => host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await act(() => resolve({ ok: true, pageContext: browser.context('tab-0') }));
  expect(selected).not.toHaveBeenCalled(); expect(host.querySelector('[role="dialog"]')).toBeNull();
});
it('keeps connection errors in the app picker and allows another attempt', async () => {
  await render(async () => { throw Error('服务端口被占用，请更换端口。'); });
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="应用"]')!.click());
  await act(() => host.querySelectorAll<HTMLButtonElement>('.bot-app-choice')[1]!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('端口被占用'); expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});
