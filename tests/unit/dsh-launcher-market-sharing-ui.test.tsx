// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DshLauncherState, DshPack } from '../../src/shared/dsh-launcher';
import type { DshMarketEntry, DshMarketPage, DshSkillTarget } from '../../src/shared/dsh-marketplace';
import type { DshPackDistribution } from '../../src/shared/dsh-pack-distribution';
import { LocaleProvider } from '../../src/renderer/i18n';
import { LauncherMarketplace } from '../../src/renderer/launcher/LauncherMarketplace';
import { InstancePluginControls } from '../../src/renderer/launcher/InstancePluginControls';
import { PackSharing, PackUrlImport } from '../../src/renderer/launcher/PackSharing';
import type { LauncherRunRequest } from '../../src/renderer/launcher/DshLauncher';

let root: Root | undefined; let container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); });
const state = (): DshLauncherState => ({ supported: true, rootPath: 'C:\\managed', runtimes: [], snapshots: [], packs: [], operations: [], instances: ['a', 'b'].map(id => ({ id: `instance-${id}`, name: `环境 ${id.toUpperCase()}`, runtimeId: 'runtime-a', profile: 'web', status: id === 'a' ? 'stopped' : 'running', homePath: '', agentsPath: '', workspacePath: '', browserPartition: '', isDefault: id === 'a', createdAt: '', updatedAt: '' })) });
const entry = (kind: 'plugin' | 'skill', id: string, npmName?: string): DshMarketEntry => ({ kind, id, name: id, description: '<script>plain catalog description</script>', repository: 'test-owner/test-repository', sourceUrl: 'https://github.com/test-owner/test-repository', npmName, category: 'Utilities', stars: 1, downloads: 5, riskLabels: [] });
const catalog = (kind: 'plugin' | 'skill', entries: DshMarketEntry[], total = entries.length): DshMarketPage => ({ kind, query: '', page: 1, pageSize: 24, total, entries, fetchedAt: '', stale: false });
const pack: DshPack = { id: 'pack-a', name: '创作包', version: '1.0.0', runtimeId: 'runtime-a', runtimeVersion: '0.2.1-alpha.2', contentSha256: 'a'.repeat(64), fileCount: 2, byteLength: 10, createdAt: '' };
const distribution = (): DshPackDistribution => ({ format: 'worldlinebox-dshpack-distribution-v2', name: pack.name, version: pack.version, createdAt: '', archive: { fileName: 'pack.dshpack', byteLength: 100, sha256: 'b'.repeat(64), url: 'https://example.com/pack.dshpack' }, runtime: { adapter: 'node-cli-web-v1', version: pack.runtimeVersion, platform: 'win32-x64', contentSha256: 'a'.repeat(64), sourceSha256: 'c'.repeat(64), npmIntegrity: `sha512-${'A'.repeat(86)}==`, dependencyLockSha256: 'd'.repeat(64), nodeVersion: '24.15.0', npmVersion: '11.9.0', nodeExecutableSha256: 'e'.repeat(64), payloadSha256: 'f'.repeat(64) }, lock: { contentSha256: 'a'.repeat(64), byteLength: 10, fileCount: 2, files: [] } });
async function mount(element: React.ReactNode) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await render(element); await settle();
}
async function render(element: React.ReactNode) { await act(() => root!.render(<LocaleProvider initialPreference="zh-CN">{element}</LocaleProvider>)); }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
function button(label: string, scope: ParentNode = container!): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing button ${label}`); return found;
}
async function fill(field: HTMLInputElement, value: string) {
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
function field(label: string): HTMLInputElement {
  const labelElement = [...container!.querySelectorAll('label')].find(item => item.textContent === label);
  return labelElement!.querySelector('input') ?? container!.querySelector<HTMLInputElement>(`#${labelElement!.htmlFor}`)!;
}

it('uses cached plugin entries, keeps source-only resources read-only and installs only into the chosen stopped instance', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true, installedPlugins: [] });
  const value = { ...state(), marketplace: { plugins: catalog('plugin', [entry('plugin', 'npm-plugin', '@test/plugin'), entry('plugin', 'source-only')]) } };
  await mount(<LauncherMarketplace kind="plugin" state={value} run={run} />);
  expect(run.mock.calls.some(([request]) => request.type === 'market.search')).toBe(false);
  expect(container!.querySelector('script')).toBeNull(); expect(container!.textContent).toContain('<script>plain catalog description</script>');
  expect(button('仅浏览源码').disabled).toBe(true);
  await act(() => button('安装到实例').click());
  expect(run).toHaveBeenCalledWith({ type: 'market.plugin.install', instanceId: 'instance-a', entryId: 'npm-plugin' });
  const select = container!.querySelector<HTMLSelectElement>('select')!;
  await act(() => { select.value = 'instance-b'; select.dispatchEvent(new Event('change', { bubbles: true })); }); await settle();
  expect(button('安装到实例').disabled).toBe(true);
  expect(container!.textContent).toContain('停止所选实例');
});

it('requests a paged catalog without repeating the accepted page on unrelated state changes', async () => {
  const first = catalog('plugin', [entry('plugin', 'page-one', '@test/one')], 25);
  const second = { ...first, page: 2, entries: [entry('plugin', 'page-two', '@test/two')] };
  const run = vi.fn<LauncherRunRequest>().mockImplementation(async request => request.type === 'market.search' ? { ok: true, marketPage: second } : { ok: true, installedPlugins: [] });
  const value = { ...state(), marketplace: { plugins: first } };
  await mount(<LauncherMarketplace kind="plugin" state={value} run={run} />);
  await act(() => button('下一页').click()); await settle();
  expect(run).toHaveBeenCalledWith({ type: 'market.search', kind: 'plugin', query: '', page: 2, pageSize: 24, refresh: false });
  expect(container!.querySelector('[data-market-entry="page-two"]')).not.toBeNull();
  await render(<LauncherMarketplace kind="plugin" state={{ ...value, operations: [] }} run={run} />); await settle();
  expect(run.mock.calls.filter(([request]) => request.type === 'market.search')).toHaveLength(1);
});

it('pins the selected repository skill to its inspected commit and reloads installed skills when the operation completes', async () => {
  const target: DshSkillTarget = { name: 'writer', description: 'write', sourcePath: 'skills/writer', repository: 'test-owner/test-repository', commit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64) };
  const run = vi.fn<LauncherRunRequest>().mockImplementation(async request => {
    if (request.type === 'skill.inspect') return { ok: true, skillInspection: { repository: target.repository, commit: target.commit, archiveSha256: target.archiveSha256, targets: [target] } };
    if (request.type === 'skill.list') return { ok: true, installedSkills: [] };
    return { ok: true, operationId: 'skill-install' };
  });
  const value = { ...state(), marketplace: { skills: catalog('skill', [entry('skill', 'writing')]) } };
  await mount(<LauncherMarketplace kind="skill" state={value} run={run} />);
  await act(() => button('查看技能').click());
  expect(container!.textContent).toContain(target.commit.slice(0, 12));
  await act(() => button('安装技能').click());
  expect(run).toHaveBeenCalledWith({ type: 'skill.install', instanceId: 'instance-a', target });
  const before = run.mock.calls.filter(([request]) => request.type === 'skill.list').length;
  await render(<LauncherMarketplace kind="skill" state={{ ...value, operations: [{ id: 'skill-install', kind: 'skill.install', instanceId: 'instance-a', status: 'succeeded', phase: 'completed', startedAt: '', label: 'install' }] }} run={run} />); await settle();
  expect(run.mock.calls.filter(([request]) => request.type === 'skill.list')).toHaveLength(before + 1);
});

it('offers third-party bundle toggles while protecting core components and avoiding meaningless dependency switches', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true, installedPlugins: [
    { name: 'dsh', spec: '0.2.1-alpha.2', description: 'Core', enabled: true, bundle: true, core: true },
    { name: '@test/bundle', spec: '1.0.0', description: 'Third-party', enabled: true, bundle: true, core: false },
    { name: '@test/dependency', spec: '1.0.0', description: 'Library', enabled: false, bundle: false, core: false },
  ] });
  await mount(<InstancePluginControls state={state()} instanceId="instance-a" run={run} />);
  const core = container!.querySelector('[data-installed-plugin="dsh"]')!;
  const dependency = container!.querySelector('[data-installed-plugin="@test/dependency"]')!;
  expect(core.querySelector('button')).toBeNull(); expect(dependency.textContent).not.toContain('停用'); expect(dependency.textContent).not.toContain('启用');
  await act(() => button('停用').click());
  expect(run).toHaveBeenCalledWith({ type: 'instance.plugin-toggle', instanceId: 'instance-a', name: '@test/bundle', enabled: false });
  await render(<InstancePluginControls state={{ ...state(), instances: state().instances.map(item => ({ ...item, status: 'running' })) }} instanceId="instance-a" run={run} />);
  expect(button('停用').disabled).toBe(true);
});

it('requires manifest inspection before URL import and discards an inspection from a changed URL', async () => {
  let finish: ((value: Awaited<ReturnType<LauncherRunRequest>>) => void) | undefined;
  const run = vi.fn<LauncherRunRequest>().mockImplementation(request => request.type === 'pack.inspect-url' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
  await mount(<PackUrlImport run={run} disabled={false} />);
  expect(container!.textContent).not.toContain('下载并导入');
  await fill(field('整合包清单链接'), 'https://example.com/one.json');
  await act(() => button('检查链接').click());
  await fill(field('整合包清单链接'), 'https://example.com/two.json');
  await act(() => finish!({ ok: true, packDistribution: distribution() }));
  expect(container!.querySelector('[data-pack-url-review]')).toBeNull();
  await act(() => button('检查链接').click());
  await act(() => finish!({ ok: true, packDistribution: distribution() }));
  expect(container!.textContent).toContain('DSH 0.2.1-alpha.2'); expect(container!.textContent).toContain('b'.repeat(64));
  await act(() => button('下载并导入').click());
  expect(run).toHaveBeenCalledWith({ type: 'pack.import-url', manifestUrl: 'https://example.com/two.json' });
});

it('publishes a draft by default and clears the transient token when the operation is accepted', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true, operationId: 'publish-a' });
  await mount(<PackSharing pack={pack} state={state()} run={run} disabled={false} />);
  await act(() => button('发布到 GitHub').click());
  const token = field('GitHub Token'); expect(token.type).toBe('password'); expect(token.autocomplete).toBe('off');
  await fill(field('GitHub 仓库'), 'test-owner/test-repository'); await fill(token, 'fake-test-token');
  await act(() => button('创建 Release 草稿').click());
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ type: 'pack.publish', packId: 'pack-a', repository: 'test-owner/test-repository', token: 'fake-test-token', draft: true }));
  expect(token.value).toBe('');
  const select = container!.querySelector<HTMLSelectElement>('select')!;
  await act(() => { select.value = 'published'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(button('公开发布 Release').disabled).toBe(true);
});

it('exports a standalone sharing manifest only with the archive URL that the user entered', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true });
  await mount(<PackSharing pack={pack} state={state()} run={run} disabled={false} />);
  await act(() => button('导出分享文件').click());
  await fill(field('归档下载地址（可选）'), 'https://example.com/pinned.dshpack');
  await act(() => button('选择分享文件位置').click());
  expect(run).toHaveBeenCalledWith({ type: 'pack.distribute', packId: 'pack-a', downloadUrl: 'https://example.com/pinned.dshpack' });
});
