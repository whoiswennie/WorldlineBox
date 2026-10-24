// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionLearningSources } from '../../src/renderer/companions/CompanionLearningSources';
import type { Companion, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionLearningGrant, CompanionLearningStatus } from '../../src/shared/companion-learning';
import type { CompanionWorkspaceRequest, CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; });
const owner = { id: 'reader-a', name: '小雨', avatar: 'custom' } as Companion;
const grant: CompanionLearningGrant = { id: 'grant-a', companionId: owner.id, libraryId: 'books', libraryName: '旅行与自然', libraryPath: 'D:/books',
  folderId: 'travel', folderName: '旅行', autonomous: false, intervalMinutes: 30, revision: 3, enabled: true, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z', status: 'idle', reads: 2 };
const libraries = [{ libraryId: 'books', displayName: '旅行与自然', folders: [{ id: 'travel', name: '旅行' }, { id: 'nature', name: '自然' }] }];
function fixture(initial?: Partial<CompanionLearningStatus>) {
  let status: CompanionLearningStatus = { grants: [], reads: [], libraries, ...initial };
  const workspace = vi.fn(async (command: CompanionWorkspaceRequest): Promise<CompanionWorkspaceResponse> => {
    if (command.type === 'memory.learning.grant') status = { ...status, grants: [{ ...grant, folderId: command.folderId, autonomous: command.autonomous, intervalMinutes: command.intervalMinutes }] };
    if (command.type === 'memory.learning.update') status = { ...status, grants: status.grants.map(item => item.id === command.id ? { ...item, autonomous: command.autonomous, intervalMinutes: command.intervalMinutes, revision: item.revision + 1 } : item) };
    if (command.type === 'memory.learning.revoke') status = { ...status, grants: status.grants.filter(item => item.id !== command.id) };
    return { ok: true, learning: status };
  });
  return { workspace, api: { workspace, onChanged: vi.fn(() => () => undefined) } as unknown as WorldlineBoxCompanionsApi };
}
async function mount(f = fixture()) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const onClose = vi.fn(); await act(async () => root!.render(<CompanionLearningSources owner={owner} api={f.api} onClose={onClose} />));
  return { ...f, onClose };
}
function button(label: string) { const found = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label); if (!found) throw new Error('Missing button ' + label); return found; }
async function click(label: string) { await act(async () => button(label).click()); }
async function select(label: string, value: string) { const input = node!.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }); }

it('grants an explicitly selected folder with autonomous reading on, and never starts reading just by opening the UI', async () => {
  const f = await mount(); expect(f.workspace).toHaveBeenCalledTimes(1); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.status', companionId: owner.id });
  expect(node!.textContent).toContain('未授权的资料不会自动进入记忆');
  await click('添加来源'); await select('学习资料目录', 'nature');
  expect(node!.querySelector<HTMLInputElement>('.learning-add input[type="checkbox"]')!.checked).toBe(true);
  expect(node!.textContent).toContain('自动开始'); await click('添加为学习来源');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.grant', companionId: owner.id, libraryId: 'books', folderId: 'nature', autonomous: true, intervalMinutes: 30 });
  expect(f.workspace.mock.calls.some(([command]) => command.type === 'memory.learning.run')).toBe(false);
  expect(node!.textContent).toContain('按计划阅读');
});

it('preserves an existing manual source and allows a new grant to opt out before reading starts', async () => {
  const f = await mount(fixture({ grants: [grant] }));
  expect(node!.querySelector<HTMLInputElement>('.learning-source input[type="checkbox"]')!.checked).toBe(false);
  expect(f.workspace.mock.calls.some(([command]) => command.type !== 'memory.learning.status')).toBe(false);
  await click('添加来源');
  await act(async () => node!.querySelector<HTMLInputElement>('.learning-add input[type="checkbox"]')!.click());
  await select('学习资料目录', 'nature'); await click('添加为学习来源');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.grant', companionId: owner.id, libraryId: 'books', folderId: 'nature', autonomous: false, intervalMinutes: 30 });
  expect(f.workspace.mock.calls.some(([command]) => command.type === 'memory.learning.run' || command.type === 'memory.learning.update')).toBe(false);
});

it('saves per-companion reading cadence using the current revision and requires an explicit withdrawal action', async () => {
  const f = await mount(fixture({ grants: [grant] }));
  await act(async () => node!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await select('旅行与自然核对间隔', '60'); await click('保存安排');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.update', companionId: owner.id, id: grant.id, expectedRevision: 3, autonomous: true, intervalMinutes: 60 });
  await click('读一轮'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.run', companionId: owner.id, id: grant.id, expectedRevision: 4 });
  await click('移除来源'); expect(f.workspace.mock.calls.some(([command]) => command.type === 'memory.learning.revoke')).toBe(false);
  expect(node!.textContent).toContain('资料库中的文件仍然保留'); await click('移除并撤回记忆');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.revoke', companionId: owner.id, id: grant.id, expectedRevision: 4 });
  expect(node!.querySelector('.learning-source')).toBeNull();
});

it('retains a rejected grant and distinguishes reading evidence from internalized knowledge', async () => {
  const f = fixture({ grants: [grant], reads: [{ id: 'read-a', companionId: owner.id, grantId: grant.id, libraryId: 'books', assetId: 'asset-a', assetRevisionId: 'rev', assetName: '潮汐.md', offset: 0, characters: 260, contentHash: 'a'.repeat(64), sourceMessageId: 'actual-read', readAt: '2026-10-22T02:00:00Z', status: 'read' }] });
  const base = f.workspace.getMockImplementation()!; f.workspace.mockImplementation(command => command.type === 'memory.learning.revoke' ? Promise.resolve({ ok: false, error: '学习来源或权限已变化，请重新读取。' }) : base(command));
  await mount(f); expect(node!.textContent).toContain('已读取原文 · 交由记忆系统整理'); expect(node!.textContent).not.toContain('已学会');
  await click('移除来源'); await click('移除并撤回记忆');
  expect(node!.querySelector('[role="alert"]')!.textContent).toContain('权限已变化'); expect(node!.querySelector('.learning-source')).not.toBeNull();
  expect(node!.textContent).toContain('单文件不超过 2 MiB'); expect(node!.textContent).toContain('不会直接变成人格');
});
