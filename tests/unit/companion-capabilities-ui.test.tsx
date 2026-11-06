// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { BotCompanion, BotSnapshot, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { DshCompanionEnvironment, DshLauncherRequest, DshLauncherResponse, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { LocaleProvider } from '../../src/renderer/i18n';
import { CompanionCapabilities } from '../../src/renderer/launcher/CompanionCapabilities';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });
const companion: BotCompanion = { id: 'fish', name: '大肥鱼', persona: '', createdAt: '', enabled: true };
function fixture(privateMode = false) {
  const base = { id: 'shared', name: '我的 DSH', runtimeId: 'runtime-a', profile: 'web' as const, status: 'stopped' as const, homePath: 'C:/private/home', agentsPath: 'C:/private/agents', workspacePath: 'C:/private/work', browserPartition: 'private', isDefault: true, createdAt: '', updatedAt: '' };
  const owned = { ...base, id: 'fish-environment', name: '大肥鱼 · 原生能力', isDefault: false, companionId: companion.id, companionName: companion.name };
  let environment: DshCompanionEnvironment = { mode: privateMode ? 'private' : 'shared', instance: privateMode ? owned : base };
  let enabled = true, pluginEnabled = true;
  const state: DshLauncherState = { supported: true, rootPath: 'C:/managed', instances: privateMode ? [base, owned] : [base], snapshots: [], operations: [], packs: [],
    runtimes: [{ id: 'runtime-a', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64', adapter: 'node-cli-web-v1', source: '', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: '', fileCount: 1, byteLength: 1 }],
    marketplace: { plugins: { kind: 'plugin', query: '', page: 1, pageSize: 24, total: 1, fetchedAt: new Date().toISOString(), stale: false,
      entries: [{ kind: 'plugin', id: 'fixture-plugin', npmName: '@fixture/native', name: 'Fixture', description: '原生插件', category: '', stars: 0, downloads: 0, riskLabels: [], sourceUrl: '' }] } } };
  const request = vi.fn(async (input: DshLauncherRequest): Promise<DshLauncherResponse> => {
    if (input.type === 'state') return { ok: true, state };
    if (input.type === 'companion.environment.ensure') { environment = { mode: 'private', instance: owned }; state.instances = [base, owned]; return { ok: true, companionEnvironment: environment }; }
    if (input.type === 'companion.environment.state') return { ok: true, companionEnvironment: environment };
    if (input.type === 'companion.environment.configure') { environment.instance = { ...environment.instance, keepAlive: input.keepAlive }; state.instances = [base, environment.instance]; return { ok: true, companionEnvironment: environment }; }
    if (input.type === 'companion.environment.capabilities') return { ok: true, taskCapabilities: { instanceId: environment.instance.id, runtimeId: 'runtime-a', runtimeVersion: '0.2.2-rc.1', capturedAt: '', modes: ['native'], preset: 'native', workspacePath: '', toolRestrictions: true, skillSelection: true,
      tools: [], skills: [], toolsTotal: 1, skillsTotal: 0, catalog: { kind: 'catalog', category: 'all', offset: input.query?.offset ?? 0, limit: 30, total: 1, items: [{ kind: 'tool', name: 'native_actual_tool', description: '实际注册的工具' }], source: 'native-agent-scope', trust: 'capability_reference_data' } } };
    if (input.type === 'instance.plugins') return { ok: true, installedPlugins: [{ name: '@fixture/skin', spec: '@fixture/skin', description: '皮肤插件', enabled: pluginEnabled, bundle: true, core: false, removable: true, scope: 'instance' }] };
    if (input.type === 'skill.list') return { ok: true, installedSkills: [] };
    if (input.type === 'instance.plugin-toggle') pluginEnabled = input.enabled;
    return { ok: true };
  });
  const api: WorldlineBoxDshLauncherApi = { request, onChanged: vi.fn(() => () => undefined) };
  const snapshot = (): BotSnapshot => ({ companions: [{ ...companion, enabled }], conversations: [], messages: [], tasks: [], hasMore: false, runtime: { engine: 'worldlinebox', memory: 'vcp-memory', embedding: '', activeLanes: 0, ready: true, dataRoot: '' } });
  const botRequest = vi.fn<WorldlineBoxBotApi['request']>(async input => { if (input.type === 'companion.runtime') enabled = input.operation === 'start'; return { ok: true, snapshot: snapshot() }; });
  const botApi: WorldlineBoxBotApi = { request: botRequest, onEvent: vi.fn(() => () => undefined) };
  return { api, botApi, request, botRequest, state };
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function mount(f: ReturnType<typeof fixture>, selected = companion) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><CompanionCapabilities api={f.api} botApi={f.botApi} companion={selected} /></LocaleProvider>)); await settle();
}
function button(text: string) { const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text || button.getAttribute('aria-label') === text); if (!found) throw Error(`Missing ${text}`); return found; }
async function click(text: string) { await act(() => button(text).click()); await settle(); }

it('reads shared native capability registrations without creating a private environment or listing package tools', async () => {
  const f = fixture(); await mount(f);
  expect(container!.textContent).toContain('使用共享能力');
  expect(container!.textContent).toContain('native_actual_tool');
  expect(f.request.mock.calls.some(([input]) => input.type === 'companion.environment.ensure' || input.type === 'instance.plugins')).toBe(false);
  await click('配置独立能力');
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.environment.ensure', companionId: 'fish', name: '大肥鱼' });
  expect(container!.textContent).toContain('独立能力环境');
  expect(f.request.mock.calls.filter(([input]) => input.type === 'companion.environment.capabilities')).toHaveLength(2);
});

it('keeps native package management separate and restricts marketplace installs to this companion environment', async () => {
  const f = fixture(true); await mount(f);
  expect(container!.querySelector('[data-installed-plugins]')).toBeNull();
  await click('原生插件与技能');
  expect(container!.textContent).toContain('皮肤插件');
  expect(container!.textContent).not.toContain('原生工具 1');
  await click('停用');
  expect(f.request).toHaveBeenCalledWith({ type: 'instance.plugin-toggle', instanceId: 'fish-environment', name: '@fixture/skin', enabled: false });
  await click('插件市场');
  expect(container!.querySelector('[role="combobox"]')).toBeNull();
  await click('安装到实例');
  expect(f.request).toHaveBeenCalledWith({ type: 'market.plugin.install', instanceId: 'fish-environment', entryId: 'fixture-plugin' });
});

it('turns the companion off through the shared runtime command and avoids waking native inventory while disabled', async () => {
  const f = fixture(true); await mount(f); await click('关闭伙伴');
  expect(f.botRequest).toHaveBeenCalledWith({ type: 'companion.runtime', companionId: 'fish', operation: 'stop' });
  expect(container!.textContent).toContain('伙伴已关闭');
  expect(container!.querySelector('[data-installed-plugins]')).toBeNull();
  expect(container!.querySelector('.companion-native-capabilities')).toBeNull();
  await click('启用伙伴');
  expect(f.botRequest).toHaveBeenCalledWith({ type: 'companion.runtime', companionId: 'fish', operation: 'start' });
  expect(container!.textContent).toContain('伙伴已启用');
});

it('does not query or start native capabilities for a disabled companion', async () => {
  const f = fixture(true); await mount(f, { ...companion, enabled: false });
  expect(f.request.mock.calls.some(([input]) => input.type === 'companion.environment.capabilities' || input.type === 'instance.plugins' || input.type === 'skill.list')).toBe(false);
  expect(container!.textContent).toContain('这位伙伴已关闭');
});

it('configures keepalive independently from enabling the companion', async () => {
  const f = fixture(true); await mount(f); await click('运行环境');
  await act(() => container!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await settle();
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.environment.configure', companionId: 'fish', name: '大肥鱼', keepAlive: true });
  expect(f.botRequest).not.toHaveBeenCalled();
  expect(container!.textContent).toContain('已创建独立环境后会一直保留');
});

it('pages the native callable catalog without loading the complete plugin ecosystem', async () => {
  const f = fixture(true), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => {
    const result = await original(input);
    if (input.type === 'companion.environment.capabilities' && result.ok && result.taskCapabilities?.catalog) {
      const offset = input.query?.offset ?? 0;
      return { ...result, taskCapabilities: { ...result.taskCapabilities, toolsTotal: 65, catalog: { ...result.taskCapabilities.catalog, total: 65, offset,
        items: Array.from({ length: Math.min(30, 65 - offset) }, (_, index) => ({ kind: 'tool' as const, name: `native_tool_${offset + index}`, description: '真实工具' })),
        ...(offset < 60 ? { nextOffset: offset + 30 } : { nextOffset: undefined }) } } };
    }
    return result;
  });
  await mount(f); await click('可调用能力');
  expect(container!.querySelectorAll('[data-callable-capability]')).toHaveLength(30);
  expect(container!.textContent).not.toContain('native_tool_30');
  await click('下一页');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.environment.capabilities', query: { kind: 'catalog', category: 'all', query: '', offset: 30, limit: 30 } }));
  expect(container!.textContent).toContain('native_tool_30');
  await click('下一页');
  expect(container!.querySelectorAll('[data-callable-capability]')).toHaveLength(5);
  expect(button('下一页').disabled).toBe(true);
});

it('searches and pages a large native package inventory without treating skin packages as callable tools', async () => {
  const f = fixture(true), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => input.type === 'instance.plugins' ? { ok: true, installedPlugins: Array.from({ length: 65 }, (_, index) => ({ name: `skin-${index}`, spec: `skin-${index}`, description: '界面皮肤', enabled: true, bundle: true, core: false, removable: true, scope: 'instance' as const })) } : original(input));
  await mount(f); await click('原生插件与技能');
  expect(container!.querySelectorAll('[data-installed-plugin]')).toHaveLength(30);
  await click('下一页');
  expect(container!.querySelector('[data-installed-plugin="skin-30"]')).not.toBeNull();
  await act(() => { const field = container!.querySelector<HTMLInputElement>('[aria-label="搜索已装原生插件"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'skin-64'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container!.querySelectorAll('[data-installed-plugin]')).toHaveLength(1);
  expect(container!.querySelector('[data-installed-plugin="skin-64"]')).not.toBeNull();
  expect(container!.querySelector('[data-callable-capability="skin-64"]')).toBeNull();
});

it('retains native installation failure details across environment and package inventory refreshes', async () => {
  const f = fixture(true), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => {
    if (input.type === 'instance.plugin' && input.action === 'add') {
      f.state.operations = [{ id: 'broken-install', kind: 'instance.plugin', label: 'Native install', instanceId: 'fish-environment', phase: 'failed', status: 'failed', startedAt: '', error: 'NATIVE_INSTALL_REJECTED' }];
      return { ok: true, operationId: 'broken-install' };
    }
    return original(input);
  });
  await mount(f); await click('原生插件与技能');
  await act(() => { const field = container!.querySelector<HTMLInputElement>('[aria-label="插件地址"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '@fixture/broken'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('安装插件');
  expect(container!.querySelector('[role="alert"]')?.textContent).toContain('NATIVE_INSTALL_REJECTED');
});

it('presents deferred native composition changes as pending safe application rather than installation failure', async () => {
  const f = fixture(true), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => {
    const result = await original(input);
    return input.type === 'companion.environment.capabilities' && result.ok && result.taskCapabilities ? { ...result, taskCapabilities: { ...result.taskCapabilities,
      scope: { kind: 'companion-worker', revision: 'old', sourceRevision: 'new', pending: true, deferredActiveWorkers: 1, deferredWorkers: 2, reason: 'NATIVE_OLD_SCOPE_RETAINED' } } } : result;
  });
  await mount(f);
  expect(container!.textContent).toContain('已有任务保留原能力，新任务使用新配置。');
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  expect(container!.textContent).toContain('NATIVE_OLD_SCOPE_RETAINED');
  await click('应用待更新能力');
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.environment.refresh', companionId: 'fish', name: '大肥鱼' });
});

it.each([true, false])('shows a pending keepalive choice immediately and settles the native result (accepted=%s)', async accepted => {
  const f = fixture(true), original = f.request.getMockImplementation()!;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.request.mockImplementation(async input => {
    if (input.type === 'companion.environment.configure') { await pending; if (!accepted) return { ok: false, error: 'CONNECTION_NOT_SAVED' }; }
    return original(input);
  });
  await mount(f); await click('运行环境');
  const checkbox = container!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(() => checkbox.click());
  expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(true);
  await act(async () => { finish(); await pending; }); await settle();
  expect(checkbox.checked).toBe(accepted); expect(checkbox.disabled).toBe(false);
  if (!accepted) expect(container!.querySelector('[role="alert"]')?.textContent).toContain('CONNECTION_NOT_SAVED');
});
