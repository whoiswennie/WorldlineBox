// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionModelResourcesPanel } from '../../src/renderer/companions/CompanionModelResourcesPanel';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); vi.restoreAllMocks(); });
const initial: NonNullable<CompanionWorkspaceResponse['modelResources']> = { companionId: 'alice', path: '模型资源预算.json', revision: 'a'.repeat(64), content: '{"limit":2}',
  usage: { requests: 3, inputBytes: 1048576, reservedOutputTokens: 8192, reservedCostMicros: 0, responses: 2, networkErrors: 1, unfinished: 0, interrupted: 0,
    observedAt: '2026-10-27T01:00:00Z', windowStart: '2026-10-27T00:00:00Z' } };
type Api = NonNullable<WorldlineBoxCompanionsApi['workspace']>;
async function mount(workspace: Api) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionModelResourcesPanel companionId="alice" api={{ workspace }} />));
}
async function expand() { await act(async () => { const details = node!.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')); }); }
async function edit(content: string) { const field = node!.querySelector('textarea')!; await act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, content); field.dispatchEvent(new Event('input', { bubbles: true }));
}); }
function button(label: string) { return [...node!.querySelectorAll('button')].find(item => item.textContent === label)!; }

it('loads on expansion, labels owner-only UTC counters, and saves the actual shared file with a captured revision', async () => {
  const workspace = vi.fn<Api>(async command => ({ ok: true, modelResources: command.type === 'model.resources.save'
    ? { ...initial, content: command.content, revision: 'b'.repeat(64) } : initial }));
  await mount(workspace); expect(workspace).not.toHaveBeenCalled(); await expand();
  expect(node!.textContent).toContain('预算文件由此资产库的伙伴共享'); expect(node!.textContent).toContain('统计仅属于当前伙伴');
  expect(node!.textContent).toContain('不代表实际账单'); expect(node!.textContent).toContain('1.00 MiB');
  await edit('{"limit":3}'); await act(async () => button('保存预算文件').click());
  expect(workspace).toHaveBeenLastCalledWith({ type: 'model.resources.save', companionId: 'alice', expectedRevision: initial.revision, content: '{"limit":3}' });
  expect(node!.querySelector('[role="status"]')!.textContent).toContain('已写入 模型资源预算.json');
});

it('retains the original draft and revision through a file conflict and reread until the user replaces it', async () => {
  let reads = 0;
  const workspace = vi.fn<Api>(async command => command.type === 'model.resources.save' ? { ok: false, error: '文件已有外部修改。' }
    : { ok: true, modelResources: reads++ ? { ...initial, revision: 'c'.repeat(64), content: '{"limit":4}' } : initial });
  await mount(workspace); await expand(); await edit('{"limit":3}'); await act(async () => button('保存预算文件').click());
  expect(node!.querySelector('[role="alert"]')!.textContent).toContain('外部修改');
  await act(async () => button('重读预算与统计').click()); expect(node!.querySelector('textarea')!.value).toBe('{"limit":3}');
  await act(async () => button('保存预算文件').click()); expect(workspace).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: initial.revision }));
  await act(() => button('用最新文件替换草稿').click()); expect(node!.querySelector('textarea')!.value).toBe('{"limit":4}');
});

it('does not expose a late previous-owner response or overwrite the new owner during an in-flight save', async () => {
  let finish!: (response: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<Api>(async command => command.type === 'model.resources.save' ? new Promise(resolve => { finish = resolve; })
    : { ok: true, modelResources: { ...initial, companionId: 'companionId' in command ? command.companionId : 'alice',
      content: 'companionId' in command && command.companionId === 'bob' ? '{"bob":1}' : initial.content } });
  await mount(workspace); await expand(); await edit('{"limit":3}'); await act(async () => button('保存预算文件').click());
  await act(async () => root!.render(<CompanionModelResourcesPanel companionId="bob" api={{ workspace }} />));
  expect(node!.querySelector('textarea')).toBeNull();
  await act(async () => finish({ ok: true, modelResources: { ...initial, content: '{"alice":99}' } }));
  expect(node!.querySelector('textarea')!.value).toBe('{"bob":1}'); expect(node!.textContent).not.toContain('已写入');
});
