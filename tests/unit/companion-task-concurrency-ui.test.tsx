// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionTaskConcurrencySettings } from '../../src/renderer/companions/CompanionTaskConcurrencySettings';
import type { CompanionRequest } from '../../src/renderer/companions/CompanionDialogs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
const owners = [{ id: 'fish', name: '小肥鱼' }, { id: 'sister', name: '大肥鱼' }];
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; vi.restoreAllMocks(); });
const policies = (fish = 3, sister = 3) => ({ defaultLimit: 3 as const, policies: [{ companionId: 'fish', limit: fish, active: 3, queued: 2 }, { companionId: 'sister', limit: sister, active: 1, queued: 0 }] });
async function mount(request: CompanionRequest, companionId?: string) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionTaskConcurrencySettings companions={owners} request={request} companionId={companionId} />));
}
function field(name: string) { return node!.querySelector<HTMLSelectElement>(`[aria-label="${name} 并发任务上限"]`)!; }
async function edit(name: string, limit: number) { await act(async () => { const input = field(name); input.value = String(limit); input.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function save(name: string) { await act(async () => node!.querySelector<HTMLButtonElement>(`[aria-label="保存 ${name} 并发设置"]`)!.click()); }

it('persists an exact owner limit without stopping existing tasks or changing another owner', async () => {
  const request = vi.fn<CompanionRequest>(async command => ({ ok: true, taskConcurrency: policies(command.type === 'tasks.concurrency.set' ? command.limit : 3, 5) }));
  await mount(request); expect(field('小肥鱼').value).toBe('3'); expect(field('大肥鱼').value).toBe('5');
  await edit('小肥鱼', 1); await save('小肥鱼');
  expect(request).toHaveBeenCalledWith({ type: 'tasks.concurrency.set', companionId: 'fish', limit: 1 });
  expect(field('小肥鱼').value).toBe('1'); expect(field('大肥鱼').value).toBe('5');
  expect(node!.textContent).toContain('正在执行的任务保留进度');
  expect(request.mock.calls.every(([command]) => ['tasks.concurrency.get', 'tasks.concurrency.set'].includes(command.type))).toBe(true);
});

it('does not announce a saved limit when the host rejects it', async () => {
  const request = vi.fn<CompanionRequest>(async command => command.type === 'tasks.concurrency.set' ? { ok: false, error: '设置未写入' } : { ok: true, taskConcurrency: policies() });
  await mount(request, 'fish'); await edit('小肥鱼', 2); await save('小肥鱼');
  expect(node!.querySelector('[role="alert"]')?.textContent).toContain('设置未写入');
  expect(node!.textContent).not.toContain('并发设置已保存');
});

it('ignores the late policy response for a previously selected owner', async () => {
  let resolve!: (value: Awaited<ReturnType<CompanionRequest>>) => void;
  const held = new Promise<Awaited<ReturnType<CompanionRequest>>>(accept => { resolve = accept; });
  const request = vi.fn<CompanionRequest>(async command => command.type === 'tasks.concurrency.get' && command.companionId === 'fish' ? held : { ok: true, taskConcurrency: policies(3, 4) });
  await mount(request, 'fish');
  await act(async () => root!.render(<CompanionTaskConcurrencySettings companions={owners} request={request} companionId="sister" />));
  await act(async () => resolve({ ok: true, taskConcurrency: policies(9, 9) }));
  expect(field('大肥鱼').value).toBe('4'); expect(field('小肥鱼')).toBeNull();
});
