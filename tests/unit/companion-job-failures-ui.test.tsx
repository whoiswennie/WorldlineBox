// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionJobFailures } from '../../src/renderer/companions/CompanionJobFailures';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionJobDisposition, CompanionJobKind } from '../../src/shared/companion-job-control';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
type Workspace = NonNullable<WorldlineBoxCompanionsApi['workspace']>;
const item = (n: number, kind: CompanionJobKind = 'capture'): CompanionJobDisposition => ({ ownerId: 'alice', kind, id: 'job-' + String(n).padStart(3, '0'), inputVersion: 'a'.repeat(64), revision: 4, state: 'parked', failureCount: 3, cycleFailureCount: 3, lastError: 'ERROR_' + n });
function api(workspace: Workspace): WorldlineBoxCompanionsApi { return { workspace, request: async () => ({ ok: true }), onChanged: () => () => undefined, onReplyStream: () => () => undefined }; }
async function mount(workspace: Workspace) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<CompanionJobFailures ownerId="alice" api={api(workspace)} />)); }
async function click(label: string) { const found = [...host.querySelectorAll('button')].find(button => button.textContent === label); expect(found, label).toBeDefined(); await act(async () => found!.click()); }
async function select(label: string, value: string) { const field = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(() => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); }); }

it('reads beyond fifty faults with explicit keyset pages for one selected kind, retaining a bounded display window', async () => {
  const values = Array.from({ length: 63 }, (_, n) => item(n));
  const workspace = vi.fn<Workspace>(async command => {
    if (command.type !== 'jobs.page') throw new Error('No per-row inspection or all-kind background scan is allowed.');
    const from = command.afterId ? values.findIndex(value => value.id === command.afterId) + 1 : 0, page = values.slice(from, from + command.limit);
    const hasMore = from + page.length < values.length; return { ok: true, jobPage: { items: page, hasMore, ...(hasMore ? { nextId: page.at(-1)!.id } : {}) } };
  });
  await mount(workspace); expect(workspace).toHaveBeenCalledExactlyOnceWith({ type: 'jobs.page', ownerId: 'alice', kind: 'capture', states: ['failed', 'parked'], limit: 20 });
  await click('加载更多故障记录'); await click('加载更多故障记录'); await click('加载更多故障记录');
  expect(workspace).toHaveBeenCalledTimes(4); expect(host.querySelectorAll('[aria-label="分页故障作业"] > li')).toHaveLength(60); expect(host.textContent).toContain('ERROR_62'); expect(host.textContent).toContain('较早读取的 3 条列表已收起');
  expect(workspace.mock.calls.filter(([command]) => command.type === 'jobs.page').map(([command]) => 'afterId' in command ? command.afterId : undefined)).toEqual([undefined, 'job-019', 'job-039', 'job-059']);
});
it('queries only the chosen kind and requested disposition states', async () => {
  const workspace = vi.fn<Workspace>(async command => command.type === 'jobs.page' ? { ok: true, jobPage: { items: [{ ...item(1, command.kind), state: command.states?.[0] ?? 'failed' }], hasMore: false } } : { ok: false });
  await mount(workspace); await select('故障作业类型', 'world'); await select('故障状态筛选', 'abandoned');
  expect(workspace).toHaveBeenLastCalledWith({ type: 'jobs.page', ownerId: 'alice', kind: 'world', states: ['abandoned'], limit: 20 }); expect(workspace).toHaveBeenCalledTimes(3); expect(host.textContent).toContain('已明确放弃');
});
it('rejects foreign-owner or invalid cursor pages without displaying their private errors', async () => {
  const workspace = vi.fn<Workspace>(async () => ({ ok: true, jobPage: { items: [{ ...item(1), ownerId: 'bob', lastError: 'BOB_ERROR_CANARY' }], hasMore: true } }));
  await mount(workspace); expect(host.querySelector('[role="alert"]')?.textContent).toContain('不一致'); expect(host.textContent).not.toContain('BOB_ERROR_CANARY'); expect([...host.querySelectorAll('button')].some(button => button.textContent === '加载更多故障记录')).toBe(false);
});
it('does not show a late page after the user changes the selected job kind', async () => {
  let finish!: (value: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<Workspace>(async command => command.type === 'jobs.page' && command.kind === 'capture' ? new Promise(resolve => { finish = resolve; }) : { ok: true, jobPage: { items: [item(4, 'tags')], hasMore: false } });
  await mount(workspace); await select('故障作业类型', 'tags'); await act(async () => finish({ ok: true, jobPage: { items: [{ ...item(1), lastError: 'OLD_CAPTURE_CANARY' }], hasMore: false } }));
  expect(host.textContent).toContain('ERROR_4'); expect(host.textContent).not.toContain('OLD_CAPTURE_CANARY');
});
it('pages source and history publication faults only when selected, without inspecting rows or reading note bodies', async () => {
  const workspace = vi.fn<Workspace>(async command => {
    if (command.type !== 'jobs.page') throw new Error('No per-row detail or body reads while listing.');
    return { ok: true, jobPage: { items: command.kind === 'history_files' ? [{ ...item(5, command.kind), memoryId: 'note-a', contentRevision: 9 }]
      : command.kind === 'source_files' ? [{ ...item(3, command.kind), sourceMessageId: 'source-a', conversationId: 'private-alice' }] : [], hasMore: false } };
  });
  await mount(workspace); expect(workspace).toHaveBeenCalledTimes(1); await select('故障作业类型', 'source_files');
  expect(workspace).toHaveBeenLastCalledWith({ type: 'jobs.page', ownerId: 'alice', kind: 'source_files', states: ['failed', 'parked'], limit: 20 });
  expect(host.textContent).toContain('来源文件发布'); expect(host.textContent).toContain('有原始消息依据');
  await select('故障作业类型', 'history_files'); expect(workspace).toHaveBeenLastCalledWith({ type: 'jobs.page', ownerId: 'alice', kind: 'history_files', states: ['failed', 'parked'], limit: 20 });
  expect(host.textContent).toContain('历史与当前正文发布'); expect(host.textContent).toContain('记忆修订 r9'); expect(workspace).toHaveBeenCalledTimes(3);
});
it('lists topic-compaction faults only for the chosen owner and kind without fetching source messages or summaries per row', async () => {
  const workspace = vi.fn<Workspace>(async command => {
    if (command.type !== 'jobs.page') throw new Error('Listing must not inspect jobs or read original messages.');
    return { ok: true, jobPage: { items: command.kind === 'topic_compaction' ? [{ ...item(8, command.kind), topicId: 'topic-a', sourceMessageId: 'message-a', conversationId: 'private-alice' }] : [], hasMore: false } };
  });
  await mount(workspace); await select('故障作业类型', 'topic_compaction');
  expect(workspace).toHaveBeenLastCalledWith({ type: 'jobs.page', ownerId: 'alice', kind: 'topic_compaction', states: ['failed', 'parked'], limit: 20 });
  expect(host.textContent).toContain('话题摘要整理'); expect(workspace).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('整段话题已完成摘要');
});
