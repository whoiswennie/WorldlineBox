// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionJobFailures } from '../../src/renderer/companions/CompanionJobFailures';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';
import type { CompanionJobDisposition } from '../../src/shared/companion-job-control';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); });
type Workspace = NonNullable<WorldlineBoxCompanionsApi['workspace']>;
const empty = (): CompanionWorkspaceResponse => ({ ok: true, jobPage: { items: [], hasMore: false } });
function deferred() { let resolve!: (value: CompanionWorkspaceResponse) => void; const promise = new Promise<CompanionWorkspaceResponse>(done => { resolve = done; }); return { promise, resolve }; }
function api(workspace: Workspace): WorldlineBoxCompanionsApi { return { workspace, request: async () => ({ ok: true }), onChanged: () => () => undefined, onReplyStream: () => () => undefined }; }
async function mount(workspace: Workspace) {
  const connected = api(workspace); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (ownerId = 'alice') => act(async () => root!.render(<CompanionJobFailures ownerId={ownerId} api={connected} />));
  await render(); return { render };
}
async function select(label: string, value: string) {
  await act(() => { const field = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); });
}

it('removes the previous empty result before the next kind request even starts, and waits for its real response', async () => {
  const pending = deferred(), atDispatch: string[] = [];
  const workspace = vi.fn<Workspace>(command => {
    if (command.type === 'jobs.page' && command.kind === 'history_files') { atDispatch.push(host.textContent ?? ''); return pending.promise; }
    return Promise.resolve(empty());
  });
  await mount(workspace); expect(host.textContent).toContain('暂无已登记作业');
  await select('故障作业类型', 'history_files');
  expect(atDispatch).toHaveLength(1); expect(atDispatch[0]).not.toContain('暂无已登记作业');
  expect(host.textContent).not.toContain('暂无已登记作业'); expect(host.textContent).toContain('正在核对所选类型');
  await act(async () => pending.resolve(empty())); expect(host.textContent).toContain('暂无已登记作业');
});

it('does not carry old rows, selected details, continuation or footer counts into a new kind', async () => {
  const pending = deferred(), atDispatch: string[] = [];
  const item: CompanionJobDisposition = { ownerId: 'alice', kind: 'capture', id: 'old_job', inputVersion: 'a'.repeat(64), revision: 1,
    state: 'parked', failureCount: 3, cycleFailureCount: 3, lastError: 'PREVIOUS_KIND_ROW' };
  const workspace = vi.fn<Workspace>(command => {
    if (command.type === 'jobs.page' && command.kind === 'history_files') { atDispatch.push(host.textContent ?? ''); return pending.promise; }
    return Promise.resolve({ ok: true, jobPage: { items: [item], hasMore: true, nextId: item.id } });
  });
  await mount(workspace); expect(host.textContent).toContain('PREVIOUS_KIND_ROW'); expect(host.textContent).toContain('当前保留 1 条');
  expect(host.querySelector('[aria-label="所选故障详情"]')).not.toBeNull();
  await select('故障作业类型', 'history_files');
  for (const text of [atDispatch[0], host.textContent]) { expect(text).not.toContain('PREVIOUS_KIND_ROW'); expect(text).not.toContain('当前保留 1 条'); expect(text).not.toContain('加载更多故障记录'); }
  expect(host.querySelector('[aria-label="所选故障详情"]')).toBeNull();
  await act(async () => pending.resolve(empty())); expect(host.textContent).toContain('暂无已登记作业');
});

it('keeps errors and empty-state readiness bound to the actual selected disposition filter', async () => {
  const pending = deferred(), atDispatch: string[] = [];
  const workspace = vi.fn<Workspace>(command => {
    if (command.type === 'jobs.page' && command.states?.includes('abandoned')) { atDispatch.push(host.textContent ?? ''); return pending.promise; }
    return Promise.resolve({ ok: false, error: 'PREVIOUS_FILTER_ERROR' });
  });
  await mount(workspace); expect(host.textContent).toContain('PREVIOUS_FILTER_ERROR');
  await select('故障状态筛选', 'abandoned');
  expect(atDispatch[0]).not.toContain('PREVIOUS_FILTER_ERROR'); expect(host.textContent).not.toContain('暂无已登记作业');
  await act(async () => pending.resolve({ ok: false, error: 'CURRENT_FILTER_ERROR' }));
  expect(host.textContent).toContain('CURRENT_FILTER_ERROR'); expect(host.textContent).not.toContain('PREVIOUS_FILTER_ERROR');
  expect(host.textContent).not.toContain('暂无已登记作业');
});

it('never treats a late previous kind response as readiness for a newer pending request', async () => {
  const first = deferred(), second = deferred();
  const workspace = vi.fn<Workspace>(command => command.type === 'jobs.page' && command.kind === 'source_files' ? first.promise
    : command.type === 'jobs.page' && command.kind === 'history_files' ? second.promise : Promise.resolve(empty()));
  await mount(workspace); await select('故障作业类型', 'source_files'); await select('故障作业类型', 'history_files');
  await act(async () => first.resolve(empty()));
  expect(host.textContent).toContain('正在核对所选类型'); expect(host.textContent).not.toContain('暂无已登记作业');
  await act(async () => second.resolve(empty())); expect(host.textContent).toContain('暂无已登记作业');
  expect(workspace).toHaveBeenCalledTimes(3);
});

it('requires an actual response for a newly selected owner instead of reusing the prior owner empty result', async () => {
  const pending = deferred();
  const workspace = vi.fn<Workspace>(command => command.type === 'jobs.page' && command.ownerId === 'bob' ? pending.promise : Promise.resolve(empty()));
  const mounted = await mount(workspace); expect(host.textContent).toContain('暂无已登记作业'); await mounted.render('bob');
  expect(host.textContent).not.toContain('暂无已登记作业'); expect(host.textContent).toContain('正在核对所选类型');
  await act(async () => pending.resolve(empty())); expect(host.textContent).toContain('暂无已登记作业');
});
