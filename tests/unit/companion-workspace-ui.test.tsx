// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionWorkspace } from '../../src/renderer/companions/CompanionWorkspace';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

let root: Root, container: HTMLDivElement;
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); environment.IS_REACT_ACT_ENVIRONMENT = false; });
const library = { libraryId: 'library', displayName: '资料库', libraryPath: 'D:/资料库', dataRoot: 'D:/资料库/.worldlinebox/companions', memoryRoot: 'D:/资料库/伙伴记忆' };
function api(workspace: NonNullable<WorldlineBoxCompanionsApi['workspace']>): WorldlineBoxCompanionsApi {
  return { workspace, request: vi.fn(async () => ({ ok: true })), onChanged: () => () => undefined, onReplyStream: () => () => undefined };
}
async function mount(workspace: NonNullable<WorldlineBoxCompanionsApi['workspace']>, create?: WorldlineBoxLibraryApi['create']) {
  await act(() => root.render(<CompanionWorkspace api={api(workspace)} libraryApi={create ? { create } as WorldlineBoxLibraryApi : undefined}><p>伙伴服务已运行</p></CompanionWorkspace>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  if (!found) throw new Error('Missing button: ' + label);
  return found;
}
async function click(label: string) { await act(() => button(label).click()); }
async function existing() { await click('已有资产库？使用已有资产库'); }

it('keeps all companion effects unmounted until the user selects an actual asset library', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async input => input.type === 'status'
    ? { ok: true, libraries: [library] } : { ok: true, selected: library });
  await mount(workspace);
  expect(container.textContent).not.toContain('伙伴服务已运行');
  expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('创建伙伴资产库');
  await existing(); await click('使用资产库 资料库');
  expect(workspace).toHaveBeenCalledWith({ type: 'select', libraryId: 'library' });
  expect(container.textContent).toContain('伙伴服务已运行'); expect(container.textContent).toContain('打开记忆目录');
});
it('preserves the picker and the explicit error if selection fails', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async input => input.type === 'status'
    ? { ok: true, libraries: [] } : { ok: false, error: '该库暂时不可写。' });
  await mount(workspace);
  await existing(); await click('打开其他资产库…');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('该库暂时不可写。');
  expect(container.textContent).not.toContain('伙伴服务已运行');
});

it('creates in place with a default name and binds before mounting companions', async () => {
  let complete: ((value: CompanionWorkspaceResponse) => void) | undefined;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async input => input.type === 'status'
    ? { ok: true, libraries: [] } : new Promise(resolve => { complete = resolve; }));
  const create = vi.fn<WorldlineBoxLibraryApi['create']>(async () => ({ ok: true, value: { libraryId: library.libraryId, displayName: library.displayName, displayPath: library.libraryPath } }));
  await mount(workspace, create);
  expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('伙伴资产库');
  await click('选择位置并创建');
  expect(create).toHaveBeenCalledWith({ displayName: '伙伴资产库' });
  expect(workspace).toHaveBeenLastCalledWith({ type: 'select', libraryId: library.libraryId });
  expect(container.textContent).not.toContain('伙伴服务已运行');
  expect(container.querySelector('input')?.disabled).toBe(true);
  await act(() => complete!({ ok: true, selected: library, libraries: [library] }));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('伙伴服务已运行');
});

it('retries binding an already created library without creating another one', async () => {
  let failed = false;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async input => {
    if (input.type === 'status') return { ok: true, libraries: [] };
    if (!failed) { failed = true; return { ok: false, error: '资产库暂时不可用。' }; }
    return { ok: true, selected: library };
  });
  const create = vi.fn<WorldlineBoxLibraryApi['create']>(async () => ({ ok: true, value: { libraryId: library.libraryId, displayName: library.displayName, displayPath: library.libraryPath } }));
  await mount(workspace, create); await click('选择位置并创建');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('暂时不可用');
  await click('重试进入伙伴');
  expect(create).toHaveBeenCalledTimes(1);
  expect(workspace.mock.calls.filter(([input]) => input.type === 'select')).toHaveLength(2);
  expect(container.textContent).toContain('伙伴服务已运行');
});

it('keeps the form after native cancellation and lets the user close and reopen it', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async () => ({ ok: true, libraries: [] }));
  const create = vi.fn<WorldlineBoxLibraryApi['create']>(async () => ({ ok: false, error: { code: 'CANCELLED', message: '取消' } }));
  await mount(workspace, create); await click('选择位置并创建');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(workspace).toHaveBeenCalledTimes(1);
  await click('关闭伙伴资产库设置'); expect(container.querySelector('[role="dialog"]')).toBeNull();
  await click('创建伙伴资产库'); expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).not.toContain('伙伴服务已运行');
});

it('preserves the existing companion subtree when changing libraries is cancelled', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async () => ({ ok: true, selected: library, libraries: [library] }));
  await mount(workspace);
  const child = [...container.querySelectorAll('p')].find(node => node.textContent === '伙伴服务已运行');
  await click('更换资产库'); expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await click('关闭伙伴资产库设置');
  expect(container.contains(child!)).toBe(true);
  expect(workspace.mock.calls.every(([input]) => input.type === 'status')).toBe(true);
});
