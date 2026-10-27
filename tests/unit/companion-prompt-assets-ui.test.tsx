// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionPromptAssetsEditor } from '../../src/renderer/companions/CompanionPromptAssetsEditor';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); vi.restoreAllMocks(); });
const initial = { companionId: 'alice', profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), prompts: [
  { path: '提示词/对话.md', revision: 'c'.repeat(64), content: '原有伙伴交流习惯。', purposes: ['chat'] },
] };
async function mount(workspace: NonNullable<WorldlineBoxCompanionsApi['workspace']>, initiallyOpen = true) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionPromptAssetsEditor companionId="alice" api={{ workspace }} initiallyOpen={initiallyOpen} />));
}
async function edit(content: string) {
  const textarea = node!.querySelector('textarea')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, content);
    textarea.dispatchEvent(new Event('input', { bubbles: true })); });
}
const button = (label: string) => [...node!.querySelectorAll('button')].find(item => item.textContent === label)!;

it('loads only when expanded and saves the actual selected owner file with its captured revision', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async request => request.type === 'companion.assets.prompt.save'
    ? { ok: true, companionAssets: { ...initial, prompts: [{ ...initial.prompts[0]!, revision: 'd'.repeat(64), content: request.content }] } }
    : { ok: true, companionAssets: initial });
  await mount(workspace, false); expect(workspace).not.toHaveBeenCalled();
  await act(async () => { const details = node!.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(node!.textContent).toContain('不会随着聊天自动新增'); expect(node!.textContent).toContain('alice/提示词/对话.md');
  await edit('新的伙伴交流指导。'); await act(async () => button('保存到伙伴文件').click());
  expect(workspace).toHaveBeenLastCalledWith({ type: 'companion.assets.prompt.save', companionId: 'alice', path: '提示词/对话.md',
    expectedRevision: 'c'.repeat(64), content: '新的伙伴交流指导。' });
  expect(node!.textContent).toContain('已保存到此伙伴'); expect(node!.querySelector('textarea')!.value).toBe('新的伙伴交流指导。');
});

it('preserves an unsaved draft after a concurrent file conflict and does not replace it during a refresh', async () => {
  let reads = 0;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async request => request.type === 'companion.assets.prompt.save'
    ? { ok: false, error: '文件已有外部修改，请重新读取。' }
    : { ok: true, companionAssets: reads++ ? { ...initial, prompts: [{ ...initial.prompts[0]!, revision: 'e'.repeat(64), content: '外部编辑的新文件。' }] } : initial });
  await mount(workspace); await edit('必须保留的编辑草稿。'); await act(async () => button('保存到伙伴文件').click());
  expect(node!.querySelector('[role="alert"]')?.textContent).toContain('外部修改');
  expect(node!.querySelector('textarea')!.value).toBe('必须保留的编辑草稿。');
  await act(async () => button('重读文件').click()); expect(node!.querySelector('textarea')!.value).toBe('必须保留的编辑草稿。');
  await act(() => button('使用最新文件替换草稿').click()); expect(node!.querySelector('textarea')!.value).toBe('外部编辑的新文件。');
});

it('exposes the real owner policy JSON in the same file editor and saves its actual path and hash', async () => {
  const policy = { path: '记忆策略.json', revision: 'f'.repeat(64), content: '{"mode":"balanced"}', purposes: ['host_policy'] };
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async request => ({ ok: true, companionAssets: { ...initial,
    ...(request.type !== 'companion.assets.prompt.save' ? { memoryPolicyError: '策略JSON损坏，维护暂停；请修复文件。' } : {}),
    prompts: [initial.prompts[0]!, request.type === 'companion.assets.prompt.save' ? { ...policy, revision: '1'.repeat(64), content: request.content } : policy] } }));
  await mount(workspace);
  const select = node!.querySelector('select')!;
  await act(() => { select.value = policy.path; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(node!.querySelector('textarea')!.value).toBe(policy.content); expect(node!.textContent).toContain('它不作为提示词发送给模型');
  expect(node!.querySelector('[role="alert"]')!.textContent).toContain('策略JSON损坏');
  await edit('{"mode":"quiet"}'); await act(async () => button('保存到伙伴文件').click());
  expect(workspace).toHaveBeenLastCalledWith({ type: 'companion.assets.prompt.save', companionId: 'alice', path: policy.path,
    expectedRevision: policy.revision, content: '{"mode":"quiet"}' });
  expect(node!.querySelector('[role="alert"]')).toBeNull();
});

it('does not show a previous owner or publish a late response after the selected companion changes', async () => {
  let finish!: (value: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async request => 'companionId' in request && request.companionId === 'alice'
    ? new Promise(resolve => { finish = resolve; }) : { ok: true, companionAssets: { ...initial, companionId: 'bob', prompts: [{ ...initial.prompts[0]!, content: 'Bob自己的文件。' }] } });
  await mount(workspace);
  await act(async () => root!.render(<CompanionPromptAssetsEditor companionId="bob" api={{ workspace }} initiallyOpen />));
  await act(async () => finish({ ok: true, companionAssets: initial }));
  expect(node!.querySelector('textarea')!.value).toBe('Bob自己的文件。'); expect(node!.textContent).not.toContain('alice/');
});
