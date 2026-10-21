// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionWorkspace } from '../../src/renderer/companions/CompanionWorkspace';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';

let root: Root, container: HTMLDivElement;
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); environment.IS_REACT_ACT_ENVIRONMENT = false; });
const library = { libraryId: 'library', displayName: '资料库', libraryPath: 'D:/资料库', dataRoot: 'D:/资料库/.worldlinebox/companions', memoryRoot: 'D:/资料库/伙伴记忆' };
function api(workspace: NonNullable<WorldlineBoxCompanionsApi['workspace']>): WorldlineBoxCompanionsApi {
  return { workspace, request: vi.fn(async () => ({ ok: true })), onChanged: () => () => undefined, onReplyStream: () => () => undefined };
}
it('keeps all companion effects unmounted until the user selects an actual asset library', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async input => input.type === 'status'
    ? { ok: true, libraries: [library] } : { ok: true, selected: library });
  await act(() => root.render(<CompanionWorkspace api={api(workspace)} onOpenAssets={vi.fn()}><p>伙伴服务已运行</p></CompanionWorkspace>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(container.textContent).not.toContain('伙伴服务已运行');
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('资料库'))!;
  await act(() => button.click());
  expect(workspace).toHaveBeenCalledWith({ type: 'select', libraryId: 'library' });
  expect(container.textContent).toContain('伙伴服务已运行'); expect(container.textContent).toContain('打开记忆目录');
});
it('preserves the picker and the explicit error if selection fails', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async input => input.type === 'status'
    ? { ok: true, libraries: [] } : { ok: false, error: '该库暂时不可写。' });
  await act(() => root.render(<CompanionWorkspace api={api(workspace)} onOpenAssets={vi.fn()}><p>伙伴服务已运行</p></CompanionWorkspace>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  await act(() => [...container.querySelectorAll('button')].find(item => item.textContent === '选择资产库目录')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('该库暂时不可写。');
  expect(container.textContent).not.toContain('伙伴服务已运行');
});
