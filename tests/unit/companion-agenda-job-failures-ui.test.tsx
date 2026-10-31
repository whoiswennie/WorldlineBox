// @vitest-environment happy-dom
import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionAgenda, type AgendaRequest } from '../../src/renderer/companions/CompanionAgenda';
import type { Companion, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-10-29T01:00:00.000Z';
const owner: Companion = { id: 'fault-owner', name: '故障核对伙伴', description: '', persona: '依据不足时保留未知。', model: '', avatar: 'custom', builtin: false, proactive: false, active: true, createdAt: at };
const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { companionId: input.companionId, rules: [], occurrences: [], runs: [], goals: [], grants: [], hasMore: false, observedAt: at, revision: 1 } } : { ok: true });
type Workspace = NonNullable<WorldlineBoxCompanionsApi['workspace']>;
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; request.mockClear(); });
function api(workspace?: Workspace): WorldlineBoxCompanionsApi { return { workspace, request: async () => ({ ok: true }), onChanged: () => () => undefined, onReplyStream: () => () => undefined }; }
function page(error: string, companionId = owner.id): CompanionWorkspaceResponse { return { ok: true, jobPage: { items: [{ ownerId: companionId, kind: 'capture', id: 'fault', inputVersion: 'a'.repeat(64), revision: 3, state: 'parked', failureCount: 3, cycleFailureCount: 3, lastError: error }], hasMore: false } }; }
function view(jobsApi?: WorldlineBoxCompanionsApi, active = true, companion = owner) { return <Activity mode={active ? 'visible' : 'hidden'}><CompanionAgenda companions={[companion]} request={request} jobsApi={jobsApi} active={active} modal={false} onClose={vi.fn()} /></Activity>; }
async function mount(jobsApi?: WorldlineBoxCompanionsApi) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(view(jobsApi))); }
async function click(label: string) { const node = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === label || button.getAttribute('aria-label') === label); expect(node, label).toBeDefined(); await act(async () => { node!.click(); await import('../../src/renderer/companions/CompanionJobFailures'); }); }

it('opens the real paginated failure browser only on demand in system events, including when there are no agenda events', async () => {
  const workspace = vi.fn<Workspace>(async () => page('CURRENT_FAULT'));
  const jobsApi = api(workspace); await mount(jobsApi);
  expect(workspace).not.toHaveBeenCalled(); expect(host.querySelector('[aria-label="故障作业管理"]')).toBeNull();
  await click('系统事件'); expect(workspace).not.toHaveBeenCalled(); expect(host.textContent).toContain('没有待展示的系统维护');
  await click('管理故障作业');
  expect(workspace).toHaveBeenCalledExactlyOnceWith({ type: 'jobs.page', ownerId: owner.id, kind: 'capture', states: ['failed', 'parked'], limit: 20 });
  expect(host.querySelector('[aria-label="故障作业管理"]')?.textContent).toContain('CURRENT_FAULT');
  expect(workspace.mock.calls.every(([command]) => command.type === 'jobs.page')).toBe(true);
  await click('返回处理总览'); expect(host.querySelector('[aria-label="故障作业管理"]')).toBeNull();
  expect(workspace).toHaveBeenCalledTimes(1);
  await click('管理故障作业'); expect(workspace).toHaveBeenCalledTimes(2);
  await click('日常'); expect(host.querySelector('[aria-label="故障作业管理"]')).toBeNull(); expect(workspace).toHaveBeenCalledTimes(2);
});

it('does not advertise failure operations without the optional workspace capability', async () => {
  await mount(api()); await click('系统事件');
  expect(host.textContent).not.toContain('管理故障作业'); expect(host.querySelector('[aria-label="故障作业管理"]')).toBeNull();
});

it('unmounts when hidden and reads fresh on return without flashing the previously loaded private fault', async () => {
  let finish!: (response: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<Workspace>().mockResolvedValueOnce(page('OLD_PRIVATE_FAULT')).mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
  const jobsApi = api(workspace); await mount(jobsApi); await click('系统事件'); await click('管理故障作业');
  expect(host.textContent).toContain('OLD_PRIVATE_FAULT');
  await act(async () => root!.render(view(jobsApi, false)));
  expect(host.querySelector('[aria-label="故障作业管理"]')).toBeNull(); expect(workspace).toHaveBeenCalledTimes(1);
  await act(async () => root!.render(view(jobsApi)));
  expect(workspace).toHaveBeenCalledTimes(2); expect(host.textContent).not.toContain('OLD_PRIVATE_FAULT');
  await act(async () => finish(page('FRESH_FAULT'))); expect(host.textContent).toContain('FRESH_FAULT');
});

it('rejects a late page after closing and keeps a different owner behind an explicit fresh open', async () => {
  let finish!: (response: CompanionWorkspaceResponse) => void;
  const other = { ...owner, id: 'other-owner', name: '另一位伙伴' };
  const workspace = vi.fn<Workspace>().mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(page('OTHER_OWNER_FAULT', other.id));
  const jobsApi = api(workspace); await mount(jobsApi); await click('系统事件'); await click('管理故障作业');
  await click('返回处理总览'); await act(async () => finish(page('LATE_PRIVATE_FAULT')));
  expect(host.textContent).not.toContain('LATE_PRIVATE_FAULT');
  await act(async () => root!.render(view(jobsApi, true, other)));
  expect(workspace).toHaveBeenCalledTimes(1); expect(host.textContent).not.toContain('LATE_PRIVATE_FAULT');
  await click('管理故障作业'); expect(workspace).toHaveBeenLastCalledWith({ type: 'jobs.page', ownerId: other.id, kind: 'capture', states: ['failed', 'parked'], limit: 20 });
  expect(host.textContent).toContain('OTHER_OWNER_FAULT'); expect(host.textContent).not.toContain('LATE_PRIVATE_FAULT');
});
