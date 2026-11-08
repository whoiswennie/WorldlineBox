// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DshLauncherRequest, DshLauncherResponse, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { LocaleProvider } from '../../src/renderer/i18n';
import { CompanionCapabilities } from '../../src/renderer/launcher/CompanionCapabilities';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });
const companion = { id: 'fish', name: '大肥鱼', enabled: true };
function fixture(status: 'running' | 'stopped' = 'running', privateMode = true) {
  const base = { id: 'shared', name: '共享执行器', runtimeId: 'runtime-a', profile: 'web' as const, status, homePath: 'C:/private/home', agentsPath: 'C:/private/agents', workspacePath: 'C:/private/work', browserPartition: 'private', isDefault: true, createdAt: '', updatedAt: '' };
  const own = { ...base, id: 'fish-environment', name: '大肥鱼 · 专属环境', isDefault: false, companionId: companion.id };
  const state: DshLauncherState = { supported: true, rootPath: 'C:/managed', instances: privateMode ? [base, own] : [base], snapshots: [], operations: [], packs: [],
    runtimes: [{ id: 'runtime-a', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64', adapter: 'node-cli-web-v1', source: '', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: '', fileCount: 1, byteLength: 1 }] };
  const changed = new Set<(value: DshLauncherState) => void>();
  const request = vi.fn(async (input: DshLauncherRequest): Promise<DshLauncherResponse> => {
    const instance = base;
    if (input.type === 'state') return { ok: true, state };
    if (input.type === 'companion.environment.capabilities') return { ok: true, taskCapabilities: { instanceId: instance.id, runtimeId: 'runtime-a', runtimeVersion: '0.2.2-rc.1', capturedAt: '2026-11-06T12:00:00Z', modes: ['native'], preset: 'native', workspacePath: '', toolRestrictions: true, skillSelection: true,
      tools: [], skills: [], toolsTotal: 1, skillsTotal: 0, catalog: { kind: 'catalog', category: 'all', offset: input.query?.offset ?? 0, limit: 30, total: 1, items: [{ kind: 'tool', name: 'native_actual_tool', description: '实际注册的工具' }], source: 'native-agent-scope', trust: 'capability_reference_data' } } };
    if (input.type === 'instance.plugins') return { ok: true, installedPlugins: [{ name: '@fixture/skin', spec: '@fixture/skin', description: '皮肤插件，没有登记工具', enabled: true, bundle: true, core: false, scope: 'instance' }] };
    if (input.type === 'skill.list') return { ok: true, installedSkills: [] };
    if (input.type === 'companion.environment.open') return { ok: true, state };
    throw new Error(`Unexpected capability mutation: ${input.type}`);
  });
  const api: WorldlineBoxDshLauncherApi = { request, onChanged: listener => { changed.add(listener); return () => changed.delete(listener); } };
  return { api, request, state, emit: () => changed.forEach(listener => listener({ ...state })) };
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 12)); }); }
async function mount(f: ReturnType<typeof fixture>, selected = companion) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><CompanionCapabilities api={f.api} companion={selected} /></LocaleProvider>)); await settle();
}
function button(text: string) { const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text || button.getAttribute('aria-label') === text); if (!found) throw Error(`Missing ${text}`); return found; }
async function click(text: string) { await act(() => button(text).click()); await settle(); }
const observations = new Set(['state', 'companion.environment.capabilities', 'instance.plugins', 'skill.list']);

it('shows the actual native catalog without allocating environments, starting hosts or exposing management actions', async () => {
  const f = fixture(); await mount(f);
  expect(container!.textContent).toContain('共享 DSH'); expect(container!.textContent).toContain('native_actual_tool');
  expect(container!.querySelectorAll('[data-callable-capability]')).toHaveLength(1);
  expect(container!.textContent).not.toMatch(/安装插件|插件市场|技能市场|关闭伙伴|保持连接|应用待更新能力/);
  expect(f.request.mock.calls.every(([input]) => observations.has(input.type))).toBe(true);
  expect(f.request.mock.calls.some(([input]) => input.type === 'instance.plugins')).toBe(false);
  await click('打开共享工作台'); expect(f.request).toHaveBeenCalledWith({ type: 'companion.environment.open', companionId: 'fish', name: '大肥鱼' });
});

it.each([true, false])('never wakes a stopped or disabled environment while reading (disabled=%s)', async disabled => {
  const f = fixture(disabled ? 'running' : 'stopped'); await mount(f, { ...companion, enabled: !disabled });
  expect(f.request.mock.calls.map(([input]) => input.type)).toEqual(['state']);
  expect(container!.querySelector('.capability-archive-empty')?.textContent).toContain('查看档案不会启动或更改执行环境');
  expect(container!.querySelector('.capability-archive-metrics')?.textContent).toContain('—');
  await click('刷新档案'); expect(f.request.mock.calls.map(([input]) => input.type)).toEqual(['state', 'state']);
});

it('shows the common executor for any companion while ignoring old private environments', async () => {
  const f = fixture('running', false); f.state.instances.push({ ...f.state.instances[0]!, id: 'other', isDefault: false, companionId: 'other', name: '其他角色旧环境' }); await mount(f, { ...companion, id: 'new-companion', name: '新伙伴' });
  expect(container!.textContent).toContain('共享 DSH'); expect(container!.textContent).toContain('共享执行器'); expect(container!.textContent).not.toContain('其他角色旧环境');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.environment.capabilities', companionId: 'new-companion' }));
  expect(f.request.mock.calls.every(([input]) => observations.has(input.type))).toBe(true);
});

it('keeps plugin records separate from actual capabilities and contains no package mutations', async () => {
  const f = fixture(); await mount(f); await click('装载来源');
  expect(container!.textContent).toContain('@fixture/skin'); expect(container!.textContent).toContain('装载记录不代表新增了可调用能力');
  expect(container!.querySelector('[data-callable-capability="@fixture/skin"]')).toBeNull();
  expect(container!.querySelector('[data-capability-source="@fixture/skin"]')).not.toBeNull();
  expect(f.request.mock.calls.every(([input]) => observations.has(input.type))).toBe(true);
  expect(container!.textContent).not.toMatch(/卸载|安装插件|^启用$|^停用$/);
});

it('pages a large native catalog in bounded requests rather than loading all tools at once', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => { const result = await original(input);
    if (input.type !== 'companion.environment.capabilities' || !result.ok || !result.taskCapabilities?.catalog) return result;
    const offset = input.query?.offset ?? 0;
    return { ...result, taskCapabilities: { ...result.taskCapabilities, toolsTotal: 65, catalog: { ...result.taskCapabilities.catalog, total: 65, offset,
      items: Array.from({ length: Math.min(30, 65 - offset) }, (_, index) => ({ kind: 'tool' as const, name: `tool_${offset + index}`, description: '已注册能力' })), nextOffset: offset < 60 ? offset + 30 : undefined } } };
  });
  await mount(f); expect(container!.querySelectorAll('[data-callable-capability]')).toHaveLength(30); await click('下一页');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ query: { kind: 'catalog', category: 'all', query: '', offset: 30, limit: 30 } }));
  expect(container!.textContent).toContain('tool_30'); await click('下一页'); expect(container!.querySelectorAll('[data-callable-capability]')).toHaveLength(5); expect(button('下一页').disabled).toBe(true);
});

it('reads skill details progressively with exact native source fields', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => { const response = await original(input); if (input.type !== 'companion.environment.capabilities' || !response.ok || !response.taskCapabilities) return response;
    return { ...response, taskCapabilities: { ...response.taskCapabilities,
      ...(input.query?.kind === 'skill' ? { detail: { kind: 'skill' as const, name: 'paper-reading', available: true, source: 'native-agent-scope' as const, trust: 'capability_reference_data' as const,
        skill: { name: 'paper-reading', description: '论文阅读', provider: 'native-skill-provider', source: 'approved/research-skills', path: 'C:/native/paper-reading/SKILL.md', content: input.query.textOffset ? '下一段原文' : '第一段原文', textOffset: input.query.textOffset ?? 0, totalChars: 8000, truncated: true, nextTextOffset: input.query.textOffset ? undefined : 4000 } } }
      : { catalog: { kind: 'catalog' as const, category: 'all' as const, offset: 0, limit: 30, total: 1, source: 'native-agent-scope' as const, trust: 'capability_reference_data' as const, items: [{ kind: 'skill' as const, name: 'paper-reading', description: '论文阅读' }] } }) } };
  });
  await mount(f); await act(() => container!.querySelector<HTMLButtonElement>('[data-callable-capability]')!.click()); await settle();
  expect(container!.textContent).toContain('native-skill-provider'); expect(container!.textContent).toContain('第一段原文');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ query: { kind: 'skill', name: 'paper-reading', textOffset: 0, maxChars: 4000 } }));
  await click('继续读取技能'); expect(container!.textContent).toContain('下一段原文'); expect(container!.textContent).not.toContain('第一段原文');
});

it('marks deferred native changes as pending without a management action or claiming they are effective', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => { const result = await original(input); return input.type === 'companion.environment.capabilities' && result.ok && result.taskCapabilities ? { ...result, taskCapabilities: { ...result.taskCapabilities, scope: { kind: 'companion-worker', revision: 'old', sourceRevision: 'new', pending: true, deferredActiveWorkers: 1, deferredWorkers: 1, reason: '原生会话仍在执行' } } } : result; });
  await mount(f); expect(container!.textContent).toContain('能力配置待生效'); expect(container!.textContent).toContain('原生会话仍在执行'); expect(container!.textContent).not.toContain('应用待更新能力');
});

it('rejects another environment’s capability response and removes live entries when the bound host closes', async () => {
  const f = fixture(); await mount(f); expect(container!.textContent).toContain('native_actual_tool');
  f.state.instances = f.state.instances.map(instance => ({ ...instance, status: 'stopped' })); await act(() => f.emit());
  expect(container!.querySelector('[data-callable-capability]')).toBeNull(); expect(container!.querySelector('.capability-archive-metrics')?.textContent).toContain('—');
  const second = fixture(), original = second.request.getMockImplementation()!;
  second.request.mockImplementation(async input => { const result = await original(input); return input.type === 'companion.environment.capabilities' && result.ok && result.taskCapabilities ? { ...result, taskCapabilities: { ...result.taskCapabilities, instanceId: 'another-owner' } } : result; });
  await act(() => root?.unmount()); container?.remove(); root = undefined; await mount(second);
  expect(container!.querySelector('[role="alert"]')?.textContent).toContain('当前执行环境不匹配'); expect(container!.querySelector('[data-callable-capability]')).toBeNull();
});

it('refreshes only this environment’s registry revision and hides an obsolete summary until new evidence arrives', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.state.companionCapabilityRevisions = { shared: 0, other: 0 };
  await mount(f); const reads = f.request.mock.calls.filter(([input]) => input.type === 'companion.environment.capabilities').length;
  f.state.companionCapabilityRevisions.other = 1; await act(() => f.emit()); await settle();
  expect(f.request.mock.calls.filter(([input]) => input.type === 'companion.environment.capabilities')).toHaveLength(reads);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.request.mockImplementation(async input => { const result = await original(input); if (input.type === 'companion.environment.capabilities' && result.ok && result.taskCapabilities) {
    await pending; return { ...result, taskCapabilities: { ...result.taskCapabilities, toolsTotal: 2 } }; } return result;
  });
  f.state.companionCapabilityRevisions.shared = 1; await act(() => f.emit()); await settle();
  expect(container!.querySelector('.capability-archive-metrics')?.textContent).toContain('—');
  expect(container!.querySelector('[data-callable-capability]')).toBeNull();
  await act(async () => { release(); await pending; }); await settle();
  expect(container!.querySelector('.capability-archive-metrics')?.textContent).not.toContain('—');
  expect(f.request.mock.calls.filter(([input]) => input.type === 'companion.environment.capabilities')).toHaveLength(reads + 1);
});
