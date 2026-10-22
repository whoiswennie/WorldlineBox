// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApplicationNetworkRequest, ApplicationNetworkResponse, ApplicationNetworkState, WorldlineBoxApplicationNetworkApi } from '../../src/shared/application-network';
import { ApplicationNetworkPage } from '../../src/renderer/network/ApplicationNetworkPage';
import { LocaleProvider } from '../../src/renderer/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.unstubAllGlobals(); });
const initial = (): ApplicationNetworkState => ({ settings: { proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7896', proxyProfiles: [], npmRegistry: 'https://registry.npmjs.org', npmDownloadRoute: 'auto', pythonIndex: 'https://pypi.org/simple', githubMirror: 'auto', githubMirrorUrl: '' }, revision: 1, recentFailures: [] });
function fixture(value = initial()) {
  let state = value;
  let listener: ((value: ApplicationNetworkState) => void) | undefined;
  const unsubscribe = vi.fn();
  const request = vi.fn(async (input: ApplicationNetworkRequest): Promise<ApplicationNetworkResponse> => {
    if (input.type === 'network.proxy.toggle') state = { ...state, revision: state.revision + 1, settings: { ...state.settings, proxyMode: input.enabled ? 'custom' : 'direct' } };
    if (input.type === 'network.patch') state = { ...state, revision: state.revision + 1, settings: { ...state.settings, ...input.patch } };
    if (input.type === 'network.diagnostics.clear') state = { ...state, recentFailures: [] };
    return { ok: true, state };
  });
  const api: WorldlineBoxApplicationNetworkApi = { request, onChanged: value => { listener = value; return unsubscribe; } };
  return { api, request, unsubscribe, async publish(value: ApplicationNetworkState) { state = value; await act(() => listener?.(value)); } };
}
async function mount(api?: WorldlineBoxApplicationNetworkApi, locale: 'zh-CN' | 'en' = 'zh-CN') {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<LocaleProvider initialPreference={locale}><ApplicationNetworkPage api={api} /></LocaleProvider>));
}
function button(label: string) { return [...container!.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!; }

it('loads and switches the application network directly without accessing the launcher API', async () => {
  const launcherRequest = vi.fn();
  vi.stubGlobal('worldlinebox', { dshLauncher: { request: launcherRequest } });
  const subject = fixture();
  await mount(subject.api);
  expect(subject.request.mock.calls.map(([value]) => value.type)).toEqual(['state', 'network.inspect']);
  expect(container!.querySelector('[data-application-network]')!.getAttribute('aria-label')).toBe('全局网络');
  expect(container!.querySelector('[data-dsh-launcher]')).toBeNull();
  await act(() => button('关闭代理').click());
  expect(subject.request).toHaveBeenCalledWith({ type: 'network.proxy.toggle', enabled: false });
  expect(container!.querySelector('[data-proxy-enabled="false"]')).not.toBeNull();
  expect(launcherRequest).not.toHaveBeenCalled();
  await act(() => root!.unmount()); root = undefined;
  expect(subject.unsubscribe).toHaveBeenCalledOnce();
});
it('switches smart/global immediately, retains unrelated drafts and displays individual Pixiv failures', async () => {
  const subject = fixture({ ...initial(), pixivCheck: { checkedAt: new Date().toISOString(), results: [
    { kind: 'page', url: 'https://www.pixiv.net/', proxy: 'http://127.0.0.1:7896', elapsedMs: 120, ok: true, status: 200 },
    { kind: 'image', url: 'https://i.pximg.net/art.jpg', proxy: 'http://127.0.0.1:7896', elapsedMs: 12000, ok: false, error: 'CDN timed out' },
  ] } });
  await mount(subject.api);
  const draftAddress = container!.querySelector<HTMLInputElement>('input[placeholder="http://127.0.0.1:7897"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(draftAddress, 'http://127.0.0.1:9999'); draftAddress.dispatchEvent(new Event('input', { bubbles: true })); });
  const select = [...container!.querySelectorAll<HTMLSelectElement>('select')].find(value => value.options[0]?.value === 'smart')!;
  await act(() => { select.value = 'smart'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(subject.request).toHaveBeenCalledWith({ type: 'network.patch', patch: { proxyMode: 'custom', proxyRouting: 'smart' } });
  expect(draftAddress.value).toBe('http://127.0.0.1:9999');
  expect(container!.querySelector('[data-network-active]')!.textContent).toContain('智能代理');
  await act(() => { select.value = 'global'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(subject.request).toHaveBeenCalledWith({ type: 'network.patch', patch: { proxyMode: 'custom', proxyRouting: 'global' } });
  expect(container!.querySelector('[data-pixiv-check="page"]')!.getAttribute('data-check-ok')).toBe('true');
  expect(container!.querySelector('[data-pixiv-check="image"]')!.textContent).toContain('CDN timed out');
});
it('runs the separate Pixiv check without starting the package registry checks', async () => {
  const subject = fixture(); await mount(subject.api);
  await act(() => button('检查 Pixiv').click());
  expect(subject.request).toHaveBeenCalledWith({ type: 'network.pixiv.test' });
  expect(subject.request).not.toHaveBeenCalledWith({ type: 'network.test' });
});

it('keeps diagnostics bounded and supports paging, searching and clearing failures', async () => {
  const subject = fixture({ ...initial(), recentFailures: Array.from({ length: 24 }, (_, index) => ({ id: `failure-${index}`, origin: `https://host-${index}.example`, error: index === 22 ? 'net::ERR_CONNECTION_CLOSED' : 'net::ERR_NAME_NOT_RESOLVED', resourceType: index === 0 ? 'mainFrame' : 'image', count: 2, occurredAt: '2026-10-18T10:00:00Z' })) });
  await mount(subject.api);
  expect(container!.querySelectorAll('[data-network-failures] li')).toHaveLength(10);
  expect(container!.querySelector('[data-network-failures] li')!.textContent).toContain('页面加载');
  await act(() => button('下一页').click());
  expect(container!.querySelector('[data-network-failures] li code')!.textContent).toBe('https://host-10.example');
  const search = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'CONNECTION_CLOSED'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container!.querySelectorAll('[data-network-failures] li')).toHaveLength(1);
  expect(container!.querySelector('[data-network-failures] li')!.textContent).toContain('host-22.example');
  await act(() => button('清空记录').click());
  expect(subject.request).toHaveBeenCalledWith({ type: 'network.diagnostics.clear' });
  expect(container!.querySelectorAll('[data-network-failures] li')).toHaveLength(0);
});

it('does not roll back a newer live policy when an older state request finishes late', async () => {
  const subject = fixture();
  let complete!: (value: ApplicationNetworkResponse) => void;
  subject.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await mount(subject.api);
  await subject.publish({ ...initial(), revision: 3, settings: { ...initial().settings, proxyMode: 'direct' } });
  await act(() => complete({ ok: true, state: initial() }));
  expect(container!.querySelector('[data-proxy-enabled="false"]')).not.toBeNull();
});

it('shows an English service failure and recovers through refresh', async () => {
  const subject = fixture(); subject.request.mockRejectedValueOnce(new Error('Network temporarily unavailable'));
  await mount(subject.api, 'en');
  expect(container!.querySelector('[role="alert"]')!.textContent).toBe('Network temporarily unavailable');
  expect(container!.querySelector('[data-application-network]')!.getAttribute('aria-label')).toBe('Global network');
  await act(() => button('Refresh').click());
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  expect(container!.querySelector('[data-network-active]')).not.toBeNull();
});

it('handles a missing application network bridge without displaying a launcher loading screen', async () => {
  await mount();
  expect(container!.querySelector('[role="status"]')!.textContent).toContain('全局网络服务暂不可用');
  expect(container!.querySelector('[data-dsh-launcher]')).toBeNull();
});
