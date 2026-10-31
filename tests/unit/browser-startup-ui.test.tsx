// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserPage } from '../../src/renderer/browser/BrowserPage';
import { LocaleProvider } from '../../src/renderer/i18n';
import { browserStateSchema, type BrowserRequest, type WorldlineBoxBrowserApi } from '../../src/shared/browser';

vi.mock('../../src/renderer/browser/BrowserCapturePanel', () => ({ BrowserCapturePanel: () => <div data-capture-panel /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });

it('shows the initial browser state from activate without duplicate reads or loading capture destinations', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const state = browserStateSchema.parse({ tabs: [{ id: 'tab', url: 'about:blank', title: '新标签页', pinned: false, muted: false,
    zoom: 1, loading: false, discarded: true, canGoBack: false, canGoForward: false }], activeTabId: 'tab',
    bookmarks: [{ id: 'bookmark', title: 'Ready bookmark', url: 'https://example.test', folder: '', createdAt: '2026-01-01T00:00:00Z' }],
    downloads: [], historyCount: 0, preferences: {}, permissions: [], fullscreen: false, revision: 1 });
  const request = vi.fn(async (command: BrowserRequest) => ({ ok: true, ...(command.type === 'layout' ? {} : { state }) }));
  const capture = vi.fn(async () => ({ ok: true }));
  const api = { request, capture, onChanged: () => () => undefined, onFocus: () => () => undefined } as unknown as WorldlineBoxBrowserApi;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = (active: boolean) => act(() => root.render(<LocaleProvider initialPreference="zh-CN"><BrowserPage api={api} active={active} onOpenNetwork={() => undefined} /></LocaleProvider>));
  await render(true);
  expect(request.mock.calls.filter(([command]) => command.type === 'activate')).toHaveLength(1);
  expect(request.mock.calls.filter(([command]) => command.type === 'state')).toHaveLength(0);
  expect(capture).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Ready bookmark');
  await render(false); await render(true);
  expect(request.mock.calls.filter(([command]) => command.type === 'activate')).toHaveLength(1);
  expect(request.mock.calls.filter(([command]) => command.type === 'state')).toHaveLength(1);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-controls="browser-capture-panel"]')!.click());
  expect(capture).toHaveBeenCalledExactlyOnceWith({ type: 'state' });
});
