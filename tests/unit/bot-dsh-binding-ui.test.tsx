// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DshInstance, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { BotDshBindingDialog } from '../../src/renderer/companion-bot/BotDshBindingDialog';
import { hasCompanionDshBinding } from '../../src/renderer/companion-bot/useBotDshBindings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const people = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const runtime = { id: 'runtime-a', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64' as const, adapter: 'node-cli-web-v1' as const,
  source: '', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: '', fileCount: 1, byteLength: 1 };
const instance = (id: string, status: DshInstance['status'] = 'stopped'): DshInstance => ({ id, name: id, runtimeId: runtime.id, profile: 'web', status, isDefault: true, homePath: '', agentsPath: '', workspacePath: '', browserPartition: id, createdAt: '', updatedAt: '' });
const state = (): DshLauncherState => ({ supported: true, rootPath: 'fixture', runtimes: [runtime], instances: [], snapshots: [], packs: [], operations: [] });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
async function mount(initial = state(), companions = people.slice(0, 1), failFirst = false) {
  let live = initial;
  const request = vi.fn<WorldlineBoxDshLauncherApi['request']>(async input => {
    if (failFirst) { failFirst = false; return { ok: false, error: '实例已被其他伙伴绑定' }; }
    if (input.type === 'companion.environment.create') live = { ...live, instances: [...live.instances, { ...instance(`${input.companionId}-own`), name: `${input.name} 的能力环境`, companionId: input.companionId, isDefault: false }] };
    if (input.type === 'companion.environment.bind') live = { ...live, instances: live.instances.map(value => value.id === input.instanceId ? { ...value, companionId: input.companionId, isDefault: false } : value) };
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

it('requires a deliberate runtime selection and confirmation, without allocating on open or cancel', async () => {
  const f = await mount();
  expect(f.request).not.toHaveBeenCalled(); expect(button('确认创建并绑定').disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('Alice 的能力环境');
  expect(host.querySelector<HTMLInputElement>('input')?.readOnly).toBe(true);
  await click('稍后设置'); expect(f.close).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
  await choose('选择 DSH 版本', runtime.id); expect(button('确认创建并绑定').disabled).toBe(false);
  await click('确认创建并绑定');
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'companion.environment.create', companionId: 'alice', name: 'Alice', runtimeId: runtime.id });
  expect(host.querySelector('[role=dialog]')).toBeNull();
});

it('guides an empty installation to the launcher and cannot create a version implicitly', async () => {
  const f = await mount({ ...state(), runtimes: [] });
  expect(host.textContent).toContain('先安装一个 DSH 版本'); expect(button('确认创建并绑定').disabled).toBe(true);
  await click('前往启动器'); expect(f.close).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
});

it('binds an existing unowned stopped instance while excluding another companion and running hosts', async () => {
  const initial = { ...state(), instances: [instance('manual'), instance('running', 'running'), { ...instance('other'), companionId: 'other' }] };
  const f = await mount(initial); await click('绑定已有实例');
  const select = host.querySelector<HTMLSelectElement>('select')!;
  expect([...select.options].map(value => value.value)).toEqual(['', 'manual']);
  await choose('选择已有实例', 'manual'); await click('确认绑定');
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'companion.environment.bind', companionId: 'alice', name: 'Alice', instanceId: 'manual' });
});

it('requires every group member and resets the version choice before each independent confirmation', async () => {
  const f = await mount(state(), people);
  expect(host.querySelector('[data-companion-binding]')?.getAttribute('data-companion-binding')).toBe('alice');
  expect(host.textContent).toContain('还需绑定 2 位伙伴');
  await choose('选择 DSH 版本', runtime.id); await click('确认创建并绑定');
  expect(host.querySelector('[data-companion-binding]')?.getAttribute('data-companion-binding')).toBe('bob');
  expect(host.textContent).toContain('还需绑定 1 位伙伴'); expect(button('确认创建并绑定').disabled).toBe(true);
  await choose('选择 DSH 版本', runtime.id); await click('确认创建并绑定');
  expect(f.request.mock.calls.map(([input]) => input)).toEqual(people.map(person => ({ type: 'companion.environment.create', companionId: person.id, name: person.name, runtimeId: runtime.id })));
  expect(host.querySelector('[role=dialog]')).toBeNull();
});

it('preserves the selected version on a rejected binding and retries only by explicit confirmation', async () => {
  const f = await mount(state(), people.slice(0, 1), true);
  await choose('选择 DSH 版本', runtime.id); await click('确认创建并绑定');
  expect(host.querySelector('[role=alert]')?.textContent).toBe('实例已被其他伙伴绑定');
  expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe(runtime.id); expect(f.request).toHaveBeenCalledOnce();
  await click('确认创建并绑定'); expect(f.request).toHaveBeenCalledTimes(2); expect(host.querySelector('[role=dialog]')).toBeNull();
});

it('does not treat an installed default as bound and directs a missing owned runtime to repair', async () => {
  expect(hasCompanionDshBinding({ ...state(), instances: [instance('default', 'running')] }, 'alice')).toBe(false);
  const initial = { ...state(), runtimes: [], instances: [{ ...instance('alice-own'), companionId: 'alice' }] };
  expect(hasCompanionDshBinding(initial, 'alice')).toBe(false);
  const f = await mount(initial); expect(host.textContent).toContain('已绑定实例的运行版本不可用');
  expect(button('确认创建并绑定').disabled).toBe(true); await click('前往启动器'); expect(f.request).not.toHaveBeenCalled();
});
