// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DshLauncherState, DshNetworkSettings, DshRuntime } from '../../src/shared/dsh-launcher';
import { LocaleProvider } from '../../src/renderer/i18n';
import { OfficialVersionPicker } from '../../src/renderer/launcher/OfficialVersionPicker';
import { LauncherNetworkSettings } from '../../src/renderer/launcher/LauncherNetworkSettings';
import type { LauncherRunRequest } from '../../src/renderer/launcher/DshLauncher';

let root: Root | undefined; let container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });
const base = (): DshLauncherState => ({ supported: true, rootPath: 'C:\\managed', runtimes: [], instances: [], snapshots: [], packs: [], operations: [] });
const network = (): DshNetworkSettings => ({ proxyMode: 'system', proxyUrl: '', proxyProfiles: [], npmRegistry: 'https://registry.npmjs.org', npmDownloadRoute:'auto', pythonIndex: 'https://pypi.org/simple', githubMirror: 'auto', githubMirrorUrl: '' });
const runtime = (adapter: DshRuntime['adapter'], version: string): DshRuntime => ({ id: 'runtime-one', version, adapter, nodeVersion: '24.15.0', platform: 'win32-x64', source: 'official', sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), installedAt: '', fileCount: 2, byteLength: 10 });

async function mount(element: React.ReactNode) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN">{element}</LocaleProvider>));
}
function button(label: string, scope: ParentNode = container!): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing button ${label}`); return found;
}
async function fill(field: HTMLInputElement, text: string) {
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

it('installs the native release even when the same desktop version exists and bounds version DOM size', async () => {
  const request = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true });
  const state = { ...base(), runtimes: [runtime('desktop-cli-web-v1', '0.2.0-rc.2')], versions: { source: 'github-npm' as const, stale: false, entries: Array.from({ length: 14 }, (_, index) => ({ version: index === 0 ? '0.2.0-rc.2' : `0.2.1-alpha.${index}`, channel: 'alpha' as const, recommended: index === 0, nodeRange: '>=24', integrity: 'sha512-fixture', releaseUrl: 'https://github.com/deepseek-ai/deepseek-harness/releases', notes: '<script>never execute</script>' })) } };
  await mount(<OfficialVersionPicker state={state} run={request} />);
  expect(container!.querySelectorAll('[data-dsh-version]')).toHaveLength(12);
  const release = container!.querySelector('[data-dsh-version="0.2.0-rc.2"]')!;
  expect(button('安装版本', release).disabled).toBe(false);
  await act(() => button('安装版本', release).click());
  expect(request).toHaveBeenCalledWith({ type: 'runtime.install', version: '0.2.0-rc.2' });
  expect(container!.querySelector('script')).toBeNull();
  await act(() => button('下一页').click()); expect(container!.querySelectorAll('[data-dsh-version]')).toHaveLength(2);
  await fill(container!.querySelector<HTMLInputElement>('[aria-label="查找版本"]')!, 'alpha.2');
  expect(container!.querySelectorAll('[data-dsh-version]')).toHaveLength(1);
});

it('shows a cached release offline and does not refetch or reinstall an already installed native version', async () => {
  const request = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true });
  const state: DshLauncherState = { ...base(), runtimes: [runtime('node-cli-web-v1', '0.2.1-alpha.2')], versions: { source: 'cache', stale: true, error: 'HTTP 403', entries: [{ version: '0.2.1-alpha.2', channel: 'alpha', recommended: true, nodeRange: '>=24', integrity: 'sha512-fixture', releaseUrl: 'https://github.com/deepseek-ai/deepseek-harness/releases' }] } };
  await mount(<OfficialVersionPicker state={state} run={request} />);
  expect(button('已安装').disabled).toBe(true); expect(container!.textContent).toContain('缓存待刷新');
  expect(request).not.toHaveBeenCalled();
  await act(() => button('刷新版本').click()); expect(request).toHaveBeenCalledWith({ type: 'versions.refresh' });
});

it('formats release headings, lists, code and tables while keeping anchors local and untrusted HTML inert', async () => {
  const request = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true });
  const notes = [
    '[中文](#cn-v0.2.0-rc.2-community) | [English](#en-v0.2.0-rc.2-community)', '',
    '<h3 id="cn-v0.2.0-rc.2-community" onclick="window.bad = true">✨ 新增功能</h3>', '',
    '- **版本管理**：支持 `dsh` 命令。', '- 阅读[发行文档](/deepseek-ai/deepseek-harness/releases)。', '',
    '### 🐛 问题修复', '', '- 修复终端窗口的问题。', '',
    '```sh', 'dsh --version', '<h3 id="not-an-anchor">literal code</h3>', '```', '',
    '| 功能 | 状态 |', '| --- | --- |', '| 启动器 | 已更新 |', '',
    '<script>window.bad = true</script>', '[不安全链接](javascript:alert(1))', '<img src="x" onerror="window.bad = true">', '',
    '<h3 id="en-v0.2.0-rc.2-community">✨ Features</h3>', '', '- Native Web workbench.',
  ].join('\n');
  const entry = { version: '0.2.0-rc.2', channel: 'rc' as const, recommended: true, nodeRange: '>=24', integrity: 'sha512-fixture', releaseUrl: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2', notes };
  await mount(<OfficialVersionPicker state={{ ...base(), versions: { source: 'cache', stale: false, entries: [entry, { ...entry, version: '0.2.0-rc.1' }] } }} run={request} />);
  const article = container!.querySelector('[data-dsh-version="0.2.0-rc.2"]')!;
  expect(article.querySelectorAll('h6')).toHaveLength(3);
  expect(article.querySelector('h6')!.textContent).toBe('✨ 新增功能');
  expect(article.querySelector('ul strong')!.textContent).toBe('版本管理');
  expect(article.querySelector('pre code')!.textContent).toContain('<h3 id="not-an-anchor">literal code</h3>');
  expect(article.querySelector('table tbody td')!.textContent).toBe('启动器');
  expect(container!.querySelector('script, img, [onclick], [onerror]')).toBeNull();
  expect([...article.querySelectorAll('button')].some(node => node.textContent === '不安全链接')).toBe(false);
  expect(article.querySelector('.launcher-release-notes-navigation')!.textContent).toBe('中文English');
  const ids = [...container!.querySelectorAll('[id]')].map(node => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  const panel = article.querySelector<HTMLDivElement>('.launcher-release-notes-body')!;
  const scroll = vi.fn(); panel.scrollTo = scroll;
  await act(() => button('English', article).click());
  expect(scroll).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
});

it('saves custom proxy profiles and download sources before a connection test', async () => {
  const request = vi.fn<LauncherRunRequest>().mockImplementation(async input => input.type === 'network.test' ? { ok: true, text: 'GitHub: OK\nnpm: OK' } : { ok: true });
  const state: DshLauncherState = { ...base(), network: { settings: network(), revision: 0 } };
  await mount(<LauncherNetworkSettings state={state} run={request} />);
  const proxyMode = container!.querySelector<HTMLSelectElement>('select')!;
  await act(() => { proxyMode.value = 'custom'; proxyMode.dispatchEvent(new Event('change', { bubbles: true })); });
  const inputs = [...container!.querySelectorAll<HTMLInputElement>('input')];
  await fill(inputs[0]!, 'http://127.0.0.1:7890');
  await fill(container!.querySelector<HTMLInputElement>('[aria-label="代理名称"]')!, '家里');
  await act(() => button('添加到常用代理').click());
  expect(request).not.toHaveBeenCalled();
  expect(container!.querySelectorAll('.launcher-proxy-profile-list li')).toHaveLength(1);
  await act(() => button('保存并测试').click());
  expect(request.mock.calls[0]![0]).toMatchObject({ type: 'network.save', settings: { proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890', proxyProfiles: [{ name: '家里', url: 'http://127.0.0.1:7890' }] } });
  expect(request.mock.calls[1]![0]).toEqual({ type: 'network.test' });
  expect(container!.querySelector('pre')!.textContent).toBe('GitHub: OK\nnpm: OK');
});

it('retains the unsaved network draft when a save fails and does not test a route that was not accepted', async () => {
  const request = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: false, error: 'Invalid proxy URL' });
  await mount(<LauncherNetworkSettings state={{ ...base(), network: { settings: network(), revision: 0 } }} run={request} />);
  const input = container!.querySelector<HTMLInputElement>('input')!;
  await fill(input, 'invalid address');
  await act(() => button('保存并测试').click());
  expect(request).toHaveBeenCalledTimes(1); expect(input.value).toBe('invalid address');
  expect(container!.textContent).toContain('未保存');
});
