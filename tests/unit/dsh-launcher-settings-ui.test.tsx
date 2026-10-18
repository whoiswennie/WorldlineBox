// @vitest-environment happy-dom
import { act, useState } from 'react';
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

function control<T extends HTMLInputElement | HTMLSelectElement>(label: string): T {
  const field = [...container!.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === label);
  if (!field) throw Error('Missing field ' + label);
  return document.getElementById(field.htmlFor) as T;
}
async function select(label: string, value: string) {
  const field = control<HTMLSelectElement>(label);
  await act(() => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function mountNetwork(initial = network(), rejectSave = false) {
  let applied: DshLauncherState = { ...base(), network: { settings: initial, revision: 0 } };
  const request = vi.fn<LauncherRunRequest>();
  function Harness() {
    const [value, setValue] = useState(applied);
    request.mockImplementation(async input => {
      if (input.type === 'network.save') {
        if (rejectSave) return { ok: false, error: 'Invalid proxy URL' };
        applied = { ...applied, network: { settings: input.settings, revision: applied.network!.revision + 1 } };
        setValue(applied); return { ok: true, state: applied };
      }
      if (input.type === 'network.test') return { ok: true, text: 'GitHub: OK\nnpm: OK' };
      return { ok: true, state: applied };
    });
    return <LauncherNetworkSettings state={value} run={request} />;
  }
  await mount(<Harness />); return request;
}

it('keeps the applied summary unchanged while editing and applies new proxy profiles immediately', async () => {
  const request = await mountNetwork();
  await select('代理模式', 'custom');
  await fill(control('代理地址'), 'http://127.0.0.1:7890');
  expect(container!.querySelector('[data-network-active]')!.textContent).toContain('跟随系统代理');
  expect(container!.querySelector('[data-network-active]')!.textContent).toContain('有未应用的修改');
  await fill(control('代理名称'), '家里');
  await fill(control('新增代理地址'), 'http://127.0.0.1:7890');
  await act(() => button('添加并启用', container!.querySelector('.launcher-network-profile-add')!).click());
  const saved = request.mock.calls.find(([input]) => input.type === 'network.save')![0];
  expect(saved).toMatchObject({ type: 'network.save', settings: { proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890', proxyProfiles: [{ name: '家里', url: 'http://127.0.0.1:7890' }] } });
  expect(container!.querySelector('[data-network-active]')!.textContent).toContain('家里');
  expect(container!.querySelectorAll('[data-profile-active="true"]')).toHaveLength(1);
  expect(control<HTMLInputElement>('新增代理地址').value).toBe('');
  await act(() => button('测试连接').click());
  expect(request.mock.calls.at(-1)![0]).toEqual({ type: 'network.test' });
  expect(container!.querySelector('pre')!.textContent).toBe('GitHub: OK\nnpm: OK');
});

it('shows only the enabled proxy and saves switching without a second save action', async () => {
  const settings = { ...network(), proxyMode: 'custom' as const, proxyUrl: 'http://127.0.0.1:7897', proxyProfiles: [
    { id: 'one', name: 'A', url: 'http://127.0.0.1:7897' }, { id: 'two', name: 'B', url: 'http://127.0.0.1:7890' },
  ] };
  const request = await mountNetwork(settings);
  expect(container!.querySelectorAll('[data-profile-active="true"]')).toHaveLength(1);
  const second = container!.querySelectorAll('.launcher-proxy-profile-list li')[1]!;
  expect(second.textContent).toContain('已保存 · 未启用');
  await act(() => button('保存并启用', second).click());
  expect(request.mock.calls.filter(([input]) => input.type === 'network.save')).toHaveLength(1);
  expect(container!.querySelector('[data-network-active]')!.textContent).toContain('B');
  expect(container!.querySelector('[data-profile-active="true"] strong')!.textContent).toBe('B');
});

it('allows adding a proxy while system mode is active and editing its address without stale activation', async () => {
  await mountNetwork();
  expect(control<HTMLInputElement>('代理地址').disabled).toBe(true);
  expect(control<HTMLInputElement>('新增代理地址').disabled).toBe(false);
  await fill(control('代理名称'), '自定义');
  await fill(control('新增代理地址'), 'http://localhost:7897');
  await act(() => button('添加并启用', container!.querySelector('.launcher-network-profile-add')!).click());
  await act(() => button('编辑', container!.querySelector('.launcher-proxy-profile-list li')!).click());
  await fill(control('新增代理地址'), 'http://localhost:7890');
  await act(() => button('保存并启用', container!.querySelector('.launcher-network-profile-add')!).click());
  expect(container!.querySelector('[data-network-active]')!.textContent).toContain('http://localhost:7890');
  expect(container!.querySelectorAll('.launcher-proxy-profile-list li')).toHaveLength(1);
});

it('adds and activates a custom mirror and removes a saved profile without changing the active endpoint', async () => {
  const request = await mountNetwork();
  await fill(control('方案名称'), '公司源');
  await fill(control('来源地址'), 'https://packages.example/npm');
  await act(() => button('添加并启用', container!.querySelector('.launcher-source-profile-add')!).click());
  expect(request.mock.calls.find(([input]) => input.type === 'network.save')![0]).toMatchObject({ settings: {
    npmRegistry: 'https://packages.example/npm', npmDownloadRoute: 'registry', sourceProfiles: [{ name: '公司源', kind: 'npm', url: 'https://packages.example/npm' }],
  } });
  expect(container!.querySelector('[data-active-source="npm"]')!.textContent).toContain('https://packages.example/npm');
  expect(control<HTMLSelectElement>('依赖解析与下载线路').disabled).toBe(true);
  await act(() => button('移除来源方案 公司源').click());
  expect(container!.querySelector('[data-active-source="npm"]')!.textContent).toContain('https://packages.example/npm');
  expect(request.mock.calls.at(-2)![0]).toMatchObject({ settings: { sourceProfiles: [] } });
});

it('retains an unsaved draft and active route when saving fails, and does not test it', async () => {
  const request = await mountNetwork(network(), true);
  await select('代理模式', 'custom');
  await fill(control('代理地址'), 'invalid address');
  await act(() => button('保存并测试').click());
  expect(request.mock.calls.filter(([input]) => input.type === 'network.save')).toHaveLength(1);
  expect(request.mock.calls.some(([input]) => input.type === 'network.test')).toBe(false);
  expect(control<HTMLInputElement>('代理地址').value).toBe('invalid address');
  expect(container!.querySelector('[data-network-active]')!.textContent).toContain('跟随系统代理');
  expect(container!.querySelector('[role="alert"]')!.textContent).toBe('Invalid proxy URL');
});

it('shows actual per-source proxy routes and bounded diagnostic failures without claiming all sources passed', async () => {
  const state: DshLauncherState = { ...base(), network: { settings: network(), revision: 2,
    inspection: { revision: 2, inspectedAt: '', routes: [
      { kind: 'npm', url: officialNpmForTest, proxy: 'http://127.0.0.1:7897' },
      { kind: 'python', url: 'https://pypi.org/simple', proxy: 'DIRECT' },
    ], npmSelection: { registry: 'https://registry.npmmirror.com', checkedAt: '', elapsedMs: 20, probed: true } },
    checks: { revision: 2, checkedAt: new Date().toISOString(), results: [
      { kind: 'npm', ok: true, attempts: [{ url: 'https://registry.npmmirror.com/zod/latest', proxy: 'DIRECT', ok: true, elapsedMs: 12, status: 200 }] },
      { kind: 'github', ok: false, attempts: [{ url: 'https://api.github.com/releases', proxy: 'http://127.0.0.1:7897', ok: false, elapsedMs: 80, status: 403, error: 'HTTP 403' }] },
    ] } } };
  await mount(<LauncherNetworkSettings state={state} run={vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true })} />);
  expect(container!.querySelector('[data-active-source="npm"]')!.textContent).toContain('http://127.0.0.1:7897');
  expect(container!.querySelector('[data-active-source="python"]')!.textContent).toContain('直接连接');
  expect(container!.querySelectorAll('[data-check-ok="true"]')).toHaveLength(1);
  expect(container!.querySelector('[data-check-ok="false"]')!.textContent).toContain('HTTP 403');
});
const officialNpmForTest = 'https://registry.npmjs.org';
