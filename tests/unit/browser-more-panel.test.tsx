// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserMorePanel } from '../../src/renderer/browser/BrowserMorePanel';
import { browserEn, browserZh } from '../../src/renderer/browser/messages';
import { LocaleProvider } from '../../src/renderer/i18n';
import { browserRequestSchema, type BrowserTab } from '../../src/shared/browser';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
const tab = (overrides: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 'current-tab', url: 'https://example.test/resources', title: '参考资料', pinned: false, muted: false, zoom: 1,
  loading: false, canGoBack: false, canGoForward: false, ...overrides,
});
async function mount(currentTab: BrowserTab | undefined = tab(), english = false) {
  const run = vi.fn().mockResolvedValue({ ok: true }); const onFind = vi.fn();
  const labels = (english ? browserEn : browserZh) as unknown as Record<string, string>;
  const b = (key: string) => labels[key] ?? key;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (next: BrowserTab | undefined) => act(() => root.render(
    <LocaleProvider initialPreference={english ? 'en' : 'zh-CN'}><BrowserMorePanel tab={next} run={run} onFind={onFind} b={b} /></LocaleProvider>,
  ));
  await render(currentTab); return { run, onFind, render };
}
function button(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label
    || node.querySelector(':scope > span')?.textContent === label || node.textContent === label);
  if (!match) throw Error('Missing more-action button: ' + label); return match;
}

it('dispatches supported tab actions and opens find without duplicating the global network entry', async () => {
  const { run, onFind } = await mount();
  for (const [label, request] of [
    ['恢复关闭的标签页', { type: 'tab.restore' }], ['固定标签页', { type: 'tab.action', action: 'pin' }],
    ['静音此标签页', { type: 'tab.action', action: 'mute' }], ['全屏', { type: 'tab.action', action: 'fullscreen' }],
    ['开发者工具', { type: 'tab.action', action: 'devtools' }],
  ] as const) {
    await act(() => button(label).click()); expect(run).toHaveBeenLastCalledWith(request);
    expect(browserRequestSchema.safeParse(request).success).toBe(true);
  }
  await act(() => button('在页面中查找').click());
  expect(onFind).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledTimes(5);
  expect(host.textContent).not.toContain('全局网络设置');
  expect(host.querySelector('.browser-more-current strong')?.textContent).toBe('参考资料');
  expect(host.querySelector('.browser-more-current')?.getAttribute('title')).toBe('https://example.test/resources');
});

it('reflects actual pin/mute state in accessible pressed states and changed action labels', async () => {
  const { run, render } = await mount();
  expect(button('固定标签页').getAttribute('aria-pressed')).toBe('false');
  expect(button('静音此标签页').getAttribute('aria-pressed')).toBe('false');
  await render(tab({ pinned: true, muted: true, title: '<script>not markup</script>' }));
  expect(button('取消固定标签页').getAttribute('aria-pressed')).toBe('true');
  expect(button('恢复页面声音').getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('.browser-more-current strong')?.textContent).toBe('<script>not markup</script>');
  expect(host.querySelector('script')).toBeNull();
  await act(() => button('取消固定标签页').click()); expect(run).toHaveBeenLastCalledWith({ type: 'tab.action', action: 'pin' });
  await act(() => button('恢复页面声音').click()); expect(run).toHaveBeenLastCalledWith({ type: 'tab.action', action: 'mute' });
});

it('clamps zoom steps at protocol limits and avoids floating point drift', async () => {
  const { run, render } = await mount(tab({ zoom: .25 }));
  expect(button('缩小页面').disabled).toBe(true); await act(() => button('缩小页面').click()); expect(run).not.toHaveBeenCalled();
  await render(tab({ zoom: .26 })); await act(() => button('缩小页面').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'tab.zoom', factor: .25 });
  await render(tab({ zoom: 4.98 })); await act(() => button('放大页面').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'tab.zoom', factor: 5 });
  await render(tab({ zoom: 5 })); expect(button('放大页面').disabled).toBe(true);
  run.mockClear(); await act(() => button('放大页面').click()); expect(run).not.toHaveBeenCalled();
  await render(tab({ zoom: 1.2 }));
  await act(() => button('放大页面').click()); expect(run).toHaveBeenLastCalledWith({ type: 'tab.zoom', factor: 1.3 });
  await act(() => button('缩小页面').click()); expect(run).toHaveBeenLastCalledWith({ type: 'tab.zoom', factor: 1.1 });
  await render(tab({ zoom: 1.25 })); expect(button('重置为 100%').textContent).toBe('125%');
  await act(() => button('重置为 100%').click()); expect(run).toHaveBeenLastCalledWith({ type: 'tab.zoom', factor: 1 });
});

it('blocks all tab-dependent actions without an active tab while keeping restore usable', async () => {
  const { run, onFind, render } = await mount(); await render(undefined);
  expect(host.querySelector('.browser-more-current')).toBeNull();
  for (const label of ['固定标签页', '静音此标签页', '在页面中查找', '全屏', '开发者工具', '缩小页面', '放大页面', '重置为 100%']) {
    expect(button(label).disabled).toBe(true); await act(() => button(label).click());
  }
  expect(run).not.toHaveBeenCalled(); expect(onFind).not.toHaveBeenCalled();
  await act(() => button('恢复关闭的标签页').click()); expect(run).toHaveBeenCalledWith({ type: 'tab.restore' });
  expect(host.textContent).not.toContain('全局网络设置');
});

it('exposes English action labels and the same tab state/zoom behavior', async () => {
  const { run } = await mount(tab({ pinned: true, muted: true, zoom: 1.5 }), true);
  expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('More actions');
  expect(button('Unpin tab').getAttribute('aria-pressed')).toBe('true');
  expect(button('Unmute tab').getAttribute('aria-pressed')).toBe('true');
  expect(button('Reset to 100%').textContent).toBe('150%');
  await act(() => button('Zoom out').click()); expect(run).toHaveBeenLastCalledWith({ type: 'tab.zoom', factor: 1.4 });
  await act(() => button('Zoom in').click()); expect(run).toHaveBeenLastCalledWith({ type: 'tab.zoom', factor: 1.6 });
});
