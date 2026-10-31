// @vitest-environment happy-dom
import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionInstancePanel } from '../../src/renderer/companions/CompanionInstancePanel';
import { CompanionAssetNavigation } from '../../src/renderer/companions/companion-asset-navigation';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });
it('ignores progress notifications and clears private bodies before a full source revalidation', async () => {
  let changed: Parameters<WorldlineBoxCompanionsApi['onChanged']>[0] | undefined, resolve!: (result: { ok: false; error: string }) => void;
  const initial = { ok: true, companionAssets: { companionId: 'alice', root: 'isolated-owner', profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), prompts: [], profile: { name: 'Alice', description: '', persona: '仍然可以连续阅读的当前人格。' } } };
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>().mockResolvedValueOnce(initial)
    .mockImplementation(() => new Promise(done => { resolve = done; }));
  const api: WorldlineBoxCompanionsApi = { workspace, request: async () => ({ ok: true }), onChanged: callback => { changed = callback; return () => { changed = undefined; }; }, onReplyStream: () => () => undefined };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<CompanionInstancePanel companionId="alice" api={api} view="profile" onDirtyChange={vi.fn()} />));
  const dossier = host.querySelector('.companion-cognition-dossier'); expect(dossier).not.toBeNull();
  await act(async () => { for (let index = 0; index < 20; index++) changed?.({ kind: 'progress' }); });
  expect(workspace).toHaveBeenCalledOnce(); expect(host.querySelector('.companion-cognition-dossier')).toBe(dossier);
  expect(host.querySelector('.instance-loading')).toBeNull(); expect(host.textContent).toContain('仍然可以连续阅读');
  await act(async () => changed?.());
  expect(workspace).toHaveBeenCalledTimes(2); expect(host.textContent).not.toContain('仍然可以连续阅读');
  await act(async () => resolve({ ok: false, error: '准确来源已经撤回。' }));
  expect(host.querySelector('.companion-cognition-dossier')).toBeNull(); expect(host.textContent).not.toContain('仍然可以连续阅读');
  expect(host.textContent).toContain('准确来源已经撤回');
});

it('stops hidden profile subscriptions and discards late reads, then revalidates once on return', async () => {
  let resolve!: (value: Awaited<ReturnType<NonNullable<WorldlineBoxCompanionsApi['workspace']>>>) => void;
  const listeners = new Set<Parameters<WorldlineBoxCompanionsApi['onChanged']>[0]>();
  const snapshot = (persona: string) => ({ ok: true, companionAssets: { companionId: 'alice', root: 'isolated-owner', profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), prompts: [], profile: { name: 'Alice', description: '', persona } } });
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(snapshot('新鲜核对后的人格'));
  const api: WorldlineBoxCompanionsApi = { workspace, request: async () => ({ ok: true }), onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, onReplyStream: () => () => undefined };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const dirty = vi.fn(), view = (active: boolean) => <CompanionInstancePanel companionId="alice" api={api} view="profile" active={active} onDirtyChange={dirty} />;
  await act(async () => root!.render(view(true)));
  expect(workspace).toHaveBeenCalledOnce(); expect(listeners.size).toBe(1);
  await act(async () => root!.render(view(false)));
  expect(listeners.size).toBe(0);
  await act(async () => { resolve(snapshot('已经过期的正文')); for (const listener of listeners) listener(); });
  expect(workspace).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('已经过期的正文');
  await act(async () => root!.render(view(true)));
  expect(workspace).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('新鲜核对后的人格');
  await act(async () => { for (let index = 0; index < 20; index++) for (const listener of listeners) listener({ kind: 'progress' }); });
  expect(workspace).toHaveBeenCalledTimes(2);
});

it('shows existing appearance images without loading private role files or subscribing to progress', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(), onChanged = vi.fn(() => () => undefined);
  const api: WorldlineBoxCompanionsApi = { workspace, request: async () => ({ ok: true }), onChanged, onReplyStream: () => () => undefined };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<CompanionInstancePanel companionId="alice" api={api} view="appearance" onDirtyChange={vi.fn()} />));
  expect(host.textContent).toContain('伙伴形象'); expect(workspace).not.toHaveBeenCalled(); expect(onChanged).not.toHaveBeenCalled();
});

it('never exposes the former role on the first frame after React Activity resumes while a fresh read is pending', async () => {
  let resolve!: (value: Awaited<ReturnType<NonNullable<WorldlineBoxCompanionsApi['workspace']>>>) => void;
  const initial = { ok: true, companionAssets: { companionId: 'alice', profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), prompts: [], profile: { name: 'Alice', description: '', persona: 'BEFORE_HIDDEN_PRIVATE_ROLE' } } };
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>().mockResolvedValueOnce(initial).mockImplementation(() => new Promise(done => { resolve = done; }));
  const listeners = new Set<Parameters<WorldlineBoxCompanionsApi['onChanged']>[0]>();
  const api: WorldlineBoxCompanionsApi = { workspace, request: async () => ({ ok: true }), onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, onReplyStream: () => () => undefined };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const dirty = vi.fn(), view = (mode: 'visible' | 'hidden') => <Activity mode={mode}><CompanionInstancePanel companionId="alice" api={api} view="profile" onDirtyChange={dirty} /></Activity>;
  await act(async () => root!.render(view('visible')));
  expect(host.textContent).toContain('BEFORE_HIDDEN_PRIVATE_ROLE');
  await act(async () => root!.render(view('hidden'))); expect(listeners.size).toBe(0);
  await act(async () => root!.render(view('visible')));
  expect(workspace).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('BEFORE_HIDDEN_PRIVATE_ROLE'); expect(host.querySelector('.instance-loading')).not.toBeNull();
  await act(async () => resolve({ ok: false, error: '隐藏期间来源已撤回' }));
  expect(host.textContent).not.toContain('BEFORE_HIDDEN_PRIVATE_ROLE'); expect(host.textContent).toContain('隐藏期间来源已撤回');
});
it('shows exact current persona read-only, preserves custom sections and opens its asset location', async () => {
  const profile = { name: '小肥鱼', description: '当前简介', persona: '【表达】\n语气：需要时直说，先核实再下结论。\n\n【自定义约定】\n不确定的事保留未知。' };
  const location = { libraryId: 'library', libraryPath: 'D:/library', linkedFolderId: 'owner-files', relativePath: 'deepseek-flash' };
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => command.type === 'companion.assets.location' ? { ok: true, assetLocation: location } : command.type === 'cognition.context.list' ? { ok: true, contextSnapshots: [] } : { ok: true, companionAssets: { companionId: 'deepseek-flash', root: 'D:/library/伙伴记忆/deepseek-flash', profileRevision: 'a'.repeat(64), promptRevision: 'c'.repeat(64), prompts: [], profile } });
  const api: WorldlineBoxCompanionsApi = { workspace, request: async () => ({ ok: true }), onChanged: () => () => undefined, onReplyStream: () => () => undefined };
  const open = vi.fn(), dirty = vi.fn(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<CompanionAssetNavigation.Provider value={open}><CompanionInstancePanel companionId="deepseek-flash" api={api} view="profile" onDirtyChange={dirty} /></CompanionAssetNavigation.Provider>));
  expect(host.textContent).toContain('自定义约定'); expect(host.querySelector('pre')?.textContent).toBe(profile.persona);
  expect(host.querySelector('input, textarea, select')).toBeNull(); expect(dirty).toHaveBeenCalledWith(false);
  const click = async (label: string) => act(async () => [...host.querySelectorAll('button')].find(item => item.textContent === label)!.click());
  await click('表达与相处'); expect(host.textContent).toContain('需要时直说，先核实再下结论。');
  await click('经历档案'); await click('起点档案'); expect(host.textContent).toContain('不能用当前角色正文冒充创建原稿');
  await click('运行核对'); await click('本次实际上下文'); expect(host.textContent).toContain('尚无可核实的实际请求快照');
  expect(workspace.mock.calls.every(([command]) => command.type === 'companion.assets.read' || command.type === 'cognition.context.list')).toBe(true);
  await click('打开资产目录'); expect(open).toHaveBeenCalledWith(location);
});
