// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionPromptAssets } from '../../src/renderer/companions/CompanionPromptAssetsEditor';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); });
const initial = { companionId: 'alice', profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), prompts: [
  { path: '提示词/对话.md', revision: 'c'.repeat(64), content: '仅在需要时给出建议，保留原条件。', purposes: ['chat'] },
] };
async function mount(workspace: NonNullable<WorldlineBoxCompanionsApi['workspace']>, initiallyOpen = true) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionPromptAssets companionId="alice" api={{ workspace }} initiallyOpen={initiallyOpen} />));
}
it('loads when expanded and shows exact guidance read-only without file-count or write controls', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async () => ({ ok: true, companionAssets: initial }));
  await mount(workspace, false); expect(workspace).not.toHaveBeenCalled();
  await act(async () => { const details = node.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(node.textContent).toContain(initial.prompts[0]!.content);
  expect(node.textContent).toContain('它们不代表某次模型实际收到');
  expect(node.querySelector('textarea, input, select')).toBeNull();
  expect(node.textContent).not.toContain('个提示词模块');
  expect(workspace.mock.calls.every(([request]) => request.type === 'companion.assets.read')).toBe(true);
});
it('separates host policy from role instructions and preserves read failures', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async () => ({ ok: true, companionAssets: { ...initial, memoryPolicyError: '维护暂停：策略尚未核实。', prompts: [...initial.prompts, { path: '记忆策略.json', revision: 'f'.repeat(64), content: '{"mode":"balanced"}', purposes: ['host_policy'] }] } }));
  await mount(workspace);
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('策略尚未核实');
  expect(node.textContent).toContain('不作为提示词发送给模型');
  expect(node.querySelector('textarea')).toBeNull();
});
it('does not publish a late response for a previously selected companion', async () => {
  let finish!: (value: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async request => 'companionId' in request && request.companionId === 'alice'
    ? new Promise(resolve => { finish = resolve; }) : { ok: true, companionAssets: { ...initial, companionId: 'bob', prompts: [{ ...initial.prompts[0]!, content: 'Bob自己的指导。' }] } });
  await mount(workspace);
  await act(async () => root!.render(<CompanionPromptAssets companionId="bob" api={{ workspace }} initiallyOpen />));
  await act(async () => finish({ ok: true, companionAssets: initial }));
  expect(node.textContent).toContain('Bob自己的指导。'); expect(node.textContent).not.toContain(initial.prompts[0]!.content);
});
it('disposes the replaced StrictMode initial read before issuing exactly one current request', async () => {
  const workspace=vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async()=>({ok:true,companionAssets:initial}));
  node=document.createElement('div');document.body.append(node);root=createRoot(node);
  await act(async()=>root!.render(<StrictMode><CompanionPromptAssets companionId="alice" api={{workspace}} initiallyOpen /></StrictMode>));
  expect(workspace).toHaveBeenCalledTimes(1);expect(node.textContent).toContain(initial.prompts[0]!.content);
  expect(node.querySelector('textarea, input, select')).toBeNull();
});
