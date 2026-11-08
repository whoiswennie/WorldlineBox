// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DshInstance, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { BotDshBindingDialog } from '../../src/renderer/companion-bot/BotDshBindingDialog';
import { hasSharedDshBinding } from '../../src/renderer/companion-bot/useBotDshBindings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const people = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const runtime = { id: 'runtime-a', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64' as const, adapter: 'node-cli-web-v1' as const,
  source: '', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: '', fileCount: 1, byteLength: 1 };
const instance = (id: string, status: DshInstance['status'] = 'stopped'): DshInstance => ({ id, name: id, runtimeId: runtime.id, profile: 'web', status, isDefault: false, homePath: '', agentsPath: '', workspacePath: '', browserPartition: id, createdAt: '', updatedAt: '' });
const state = (): DshLauncherState => ({ supported: true, rootPath: 'fixture', runtimes: [runtime], instances: [], snapshots: [], packs: [], operations: [] });
let root: Root | undefined, host: HTMLDivElement;

afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
async function mount(initial = state(), companions = people.slice(0, 1), failFirst = false) {
  let live = initial;
  const request = vi.fn<WorldlineBoxDshLauncherApi['request']>(async input => {
    if (failFirst) { failFirst = false; return { ok: false, error: '执行实例正在切换，请稍后重试' }; }
    if (input.type === 'companion.environment.create') live = { ...live, instances: [...live.instances.map(value => ({ ...value, isDefault: false })), { ...instance('shared-new'), name: input.name, isDefault: true }] };
    if (input.type === 'companion.environment.bind') live = { ...live, instances: live.instances.map(value => ({ ...value, isDefault: value.id === input.instanceId })) };
    return { ok: true, state: live };
  });
  const close = vi.fn(), open = vi.fn();
  const api: WorldlineBoxDshLauncherApi = { request, onChanged: () => () => undefined };
  function Harness() { const [value, setValue] = useState(initial); return <BotDshBindingDialog api={api} state={value} companions={companions} locale="zh-CN" onState={setValue} onClose={close} onOpenLauncher={open} />; }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<Harness />));
  return { request, close, open };
}
function button(label: string) { const value = [...host.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === label || value.getAttribute('aria-label') === label); expect(value, label).toBeDefined(); return value!; }
async function click(label: string) { await act(() => button(label).click()); }
async function choose(label: string, value: string) { const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; await act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }

it('requires deliberate runtime confirmation for one shared setup, without allocating on open or cancel', async () => {
  const f = await mount();
  expect(f.request).not.toHaveBeenCalled(); expect(button('创建并共享').disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('共享 DSH');
  expect(host.querySelector<HTMLInputElement>('input')?.readOnly).toBe(true);
  await click('稍后设置'); expect(f.close).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
  await choose('选择 DSH 版本', runtime.id); expect(button('创建并共享').disabled).toBe(false);
  await click('创建并共享');
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'companion.environment.create', companionId: 'alice', name: '共享 DSH', runtimeId: runtime.id });
  expect(host.querySelector('[role=dialog]')).toBeNull();
});

it('guides an empty installation to the launcher and never downloads a version implicitly', async () => {
  const f = await mount({ ...state(), runtimes: [] });
  expect(host.textContent).toContain('先安装一个 DSH 版本'); expect(button('创建并共享').disabled).toBe(true);
  await click('前往启动器'); expect(f.close).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
});

it('allows selecting running and previously private instances without assigning exclusive ownership', async () => {
  const initial = { ...state(), instances: [instance('manual'), instance('running', 'running'), { ...instance('legacy'), companionId: 'other' }] };
  const f = await mount(initial);
  const select = host.querySelector<HTMLSelectElement>('select')!;
  expect([...select.options].map(value => value.value)).toEqual(['', 'manual', 'running', 'legacy']);
  await choose('选择已有实例', 'legacy'); await click('确认使用');
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'companion.environment.bind', companionId: 'alice', name: '共享 DSH', instanceId: 'legacy' });
  expect(host.querySelector('[role=dialog]')).toBeNull();
});

it('unblocks every member of a large group with exactly one shared confirmation', async () => {
  const f = await mount(state(), Array.from({ length: 1000 }, (_, index) => ({ id: `person-${index}`, name: `角色${index}` })));
  expect(host.textContent).toContain('只需设置一次'); expect(host.textContent).not.toContain('还需绑定');
  expect(host.querySelectorAll('.bot-binding-members')).toHaveLength(0);
  await choose('选择 DSH 版本', runtime.id); await click('创建并共享');
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'companion.environment.create', companionId: 'person-0', name: '共享 DSH', runtimeId: runtime.id });
  expect(host.querySelector('[role=dialog]')).toBeNull();
});

it('preserves the selected version on a rejected setup and retries only by explicit confirmation', async () => {
  const f = await mount(state(), people, true);
  await choose('选择 DSH 版本', runtime.id); await click('创建并共享');
  expect(host.querySelector('[role=alert]')?.textContent).toBe('执行实例正在切换，请稍后重试');
  expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe(runtime.id); expect(f.request).toHaveBeenCalledOnce();
  await click('创建并共享'); expect(f.request).toHaveBeenCalledTimes(2); expect(host.querySelector('[role=dialog]')).toBeNull();
});

it('uses one installed default for all companions and ignores unrelated legacy owners', async () => {
  const initial = { ...state(), instances: [{ ...instance('default', 'running'), isDefault: true }, { ...instance('alice-own'), companionId: 'alice' }] };
  expect(hasSharedDshBinding(initial)).toBe(true);
  const f = await mount(initial, people); expect(host.querySelector('[role=dialog]')).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  expect(hasSharedDshBinding({ ...initial, instances: [{ ...instance('legacy'), companionId: 'alice' }] })).toBe(false);
});

it('does not mistake CLI selection for a shared executor and provides repair for a missing selected runtime', async () => {
  const initial = { ...state(), runtimes: [], instances: [{ ...instance('broken'), isDefault: true }], cli: { selectedInstanceId: 'broken', commandPath: '', binPath: '', pathEnabled: false, output: '' } };
  expect(hasSharedDshBinding(initial)).toBe(false);
  const f = await mount(initial); expect(host.textContent).toContain('运行版本不可用');
  expect(button('创建并共享').disabled).toBe(true); await click('前往启动器'); expect(f.request).not.toHaveBeenCalled();
});
