// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserBookmarks } from '../../src/renderer/browser/BrowserBookmarks';
import { LocaleProvider } from '../../src/renderer/i18n';
import { BROWSER_DEFAULT_BOOKMARKS, type BrowserBookmark, type BrowserTab } from '../../src/shared/browser';

let host: HTMLDivElement; let root: Root;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
const favorites = (): BrowserBookmark[] => BROWSER_DEFAULT_BOOKMARKS.map((item, index) => ({ ...item, id: String(index), folder: index === 2 ? '开发' : '', createdAt: '' }));
const blank: BrowserTab = { id: 'blank', url: 'about:blank', title: '新标签页', pinned: false, muted: false, zoom: 1, loading: false, canGoBack: false, canGoForward: false };
async function mount() {
  const run = vi.fn().mockResolvedValue({ ok: true }); const navigate = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<LocaleProvider initialPreference="zh-CN"><BrowserBookmarks bookmarks={favorites()} tab={blank} run={run} navigate={navigate} /></LocaleProvider>));
  return { run, navigate };
}
function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!; }
it('shows compact preset cards and opens sites without displaying a permanent editor', async () => {
  const { navigate } = await mount(); expect(host.querySelector('form')).toBeNull();
  expect(host.querySelectorAll('.browser-bookmark-list li')).toHaveLength(4);
  expect(button('添加当前网页').disabled).toBe(true);
  await act(() => host.querySelectorAll<HTMLButtonElement>('.browser-bookmark-link')[1]!.click());
  expect(navigate).toHaveBeenCalledWith('https://www.pixiv.net/');
});
it('edits an existing bookmark by identity while the current tab is blank', async () => {
  const { run } = await mount(); await act(() => button('编辑收藏 GitHub').click());
  expect(host.querySelector('form')).not.toBeNull();
  await act(() => button('保存').click());
  expect(run).toHaveBeenCalledWith({ type: 'bookmark.save', id: '2', title: 'GitHub', folder: '开发' });
  expect(host.querySelector('form')).toBeNull();
});
it('filters folders without changing the underlying saved bookmarks', async () => {
  const { run } = await mount(); await act(() => button('开发').click());
  expect(host.querySelectorAll('.browser-bookmark-list li')).toHaveLength(1); expect(host.textContent).toContain('github.com');
  await act(() => button('全部').click()); expect(host.querySelectorAll('.browser-bookmark-list li')).toHaveLength(4); expect(run).not.toHaveBeenCalled();
});
