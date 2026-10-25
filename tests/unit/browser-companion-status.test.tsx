// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BrowserCompanionStatus } from '../../src/renderer/browser/BrowserCompanionStatus';
import { BrowserTabStrip } from '../../src/renderer/browser/BrowserTabStrip';
import { browserStateSchema } from '../../src/shared/browser';
import { browserZh } from '../../src/renderer/browser/messages';
import { LocaleProvider } from '../../src/renderer/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('shows multiple viewers on their actual tab; removing activity leaves the page and close controls', async () => {
  const state = browserStateSchema.parse({ tabs: [{ id: 'one', url: 'https://example.test/', title: '页面一', loading: false, pinned: false, muted: false, zoom: 1, canGoBack: false, canGoForward: false }],
    activeTabId: 'one', bookmarks: [], downloads: [], historyCount: 0, preferences: {}, permissions: [], fullscreen: false, revision: 1,
    companions: { activities: ['小爱', '小贝'].map((companionName, index) => ({ id: 'call' + index, companionId: 'p' + index, companionName, tabId: 'one', action: 'read', startedAt: new Date().toISOString() })), paused: false, pausedTabIds: [] } });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), run = vi.fn();
  const b = (key: string) => (browserZh as unknown as Record<string, string>)[key] ?? key;
  const render = () => root.render(<LocaleProvider initialPreference="zh-CN"><BrowserTabStrip tabs={state.tabs} activeId="one" activities={state.companions!.activities} run={run} b={b} /><BrowserCompanionStatus state={state} run={run} b={b} /></LocaleProvider>);
  try {
    await act(render);
    expect(host.querySelector('[aria-label="正在查看 · 小爱、小贝"]')).not.toBeNull();
    expect(host.textContent).toContain('小爱、小贝 · 页面一');
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="暂停此页的伙伴 · 页面一"]')!.click());
    expect(run).toHaveBeenLastCalledWith({ type: 'companion.pause', paused: true, tabId: 'one' });
    state.companions!.activities = []; await act(render);
    expect(host.querySelector('.browser-companion-status')).toBeNull();
    expect(host.querySelector('.browser-tab-companions')).toBeNull();
    expect(host.querySelector('[data-tab-id="one"]')).not.toBeNull();
    state.companions!.paused = true; await act(render);
    expect(host.textContent).toContain('恢复伙伴浏览');
  } finally { await act(() => root.unmount()); host.remove(); }
});
