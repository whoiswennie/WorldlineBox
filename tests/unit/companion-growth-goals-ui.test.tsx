// @vitest-environment happy-dom
import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionGrowthGoals } from '../../src/renderer/companions/CompanionGrowthGoals';
import type { CompanionGrowthGoal } from '../../src/shared/companion-cognition';
import type { Companion, CompanionChangeEvent, CompanionConversation, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Workspace = NonNullable<WorldlineBoxCompanionsApi['workspace']>;
const at = '2026-10-29T01:00:00.000Z';
const room = (owner = 'alice'): CompanionConversation => ({ id: `private_${owner}`, kind: 'private', title: owner, memberIds: [owner], pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '' });
const companion = (id: string): Companion => ({ id, name: id, description: '', persona: '只读的当前人格。', model: '', avatar: 'custom', builtin: false, proactive: false, active: true, createdAt: at });
const goal = (status: CompanionGrowthGoal['status'] = 'proposed', owner = 'alice', statement = '练习核对未知条件'): CompanionGrowthGoal => ({ id: `goal_${status}`, companionId: owner, conversationId: room(owner).id, revision: 3, status, statement, context: '资料不足时', examples: ['我还需要确认'], counterexamples: ['直接断言'], practice: ['先核对一项条件'], authorId: 'user', createdAt: at, updatedAt: at, sources: [{ messageId: 'source_a', revision: 2, contentHash: 'a'.repeat(64) }] });
function connection(workspace: Workspace) {
  const listeners = new Set<(change?: CompanionChangeEvent) => void>();
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async input => input.type === 'state' ? { ok: true, state: { companions: [companion('alice'), companion('bob')], conversations: [room(), room('bob')], activities: [], configured: false } } : { ok: false, error: 'Read-only navigation must not create conversations' });
  const api: WorldlineBoxCompanionsApi = { workspace, request, onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onReplyStream: () => () => undefined };
  return { api, request, listeners, changed: (change?: CompanionChangeEvent) => { for (const listener of [...listeners]) listener(change); } };
}
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
async function mount(api: WorldlineBoxCompanionsApi, owner = 'alice') { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<CompanionGrowthGoals companionId={owner} api={api} />)); }
async function click(label: string, scope: ParentNode = host) { const node = [...scope.querySelectorAll('button')].find(button => button.textContent?.trim() === label); expect(node, label).toBeDefined(); await act(async () => node!.click()); }
async function fill(label: string, text: string, form: ParentNode = host) { const field = [...form.querySelectorAll('label')].find(node => node.textContent?.trim().startsWith(label))?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea'); expect(field, label).toBeDefined(); await act(async () => { const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, text); field!.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('resolves existing private scope without opening a conversation and displays paused and retired directions without integrating them', async () => {
  const values = [goal(), goal('paused'), goal('retired')];
  const workspace = vi.fn<Workspace>(async input => input.type === 'growth.goals.read' ? { ok: true, growthGoals: values } : { ok: false });
  const { api, request } = connection(workspace); await mount(api);
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'state', readiness: 'navigation' });
  expect(workspace).toHaveBeenCalledExactlyOnceWith({ type: 'growth.goals.read', companionId: 'alice', conversationId: 'private_alice' });
  expect(host.querySelectorAll('[data-growth-goal]')).toHaveLength(3); expect(host.querySelector('form')).toBeNull();
  expect(host.querySelector('[data-growth-goal="goal_paused"]')?.textContent).toContain('已暂停');
  expect(host.querySelector('[data-growth-goal="goal_retired"]')?.textContent).toContain('已结束');
  expect(host.querySelector('[data-growth-goal="goal_retired"] button')).toBeNull();
  expect(workspace.mock.calls.some(([input]) => /integrat|agenda|persona/u.test(input.type))).toBe(false);
});

it('adjusts a paused definition with exact optimistic revision and feedback while keeping it paused', async () => {
  let current = goal('paused');
  const workspace = vi.fn<Workspace>(async input => {
    if (input.type === 'growth.goals.read') return { ok: true, growthGoals: [current] };
    if (input.type === 'growth.goals.propose') { current = { ...current, ...input.goal, revision: 4 }; return { ok: true, growthGoal: current }; }
    return { ok: false };
  });
  const { api } = connection(workspace); await mount(api); await click('调整方向');
  const form = host.querySelector('form[aria-label="培养方向反馈"]')!; expect(form.textContent).toContain('调整定义不会自动恢复练习');
  await fill('培养方向', '先说清楚自己缺少什么依据', form); await fill('本次反馈', '先修改方向定义，暂时仍不恢复练习。', form); await click('保存方向调整', form);
  expect(workspace).toHaveBeenCalledWith({ type: 'growth.goals.propose', companionId: 'alice', conversationId: 'private_alice', operationId: expect.any(String), goalId: 'goal_paused', expectedRevision: 3,
    feedback: '先修改方向定义，暂时仍不恢复练习。', goal: { statement: '先说清楚自己缺少什么依据', context: '资料不足时', practice: ['先核对一项条件'], examples: ['我还需要确认'], counterexamples: ['直接断言'] } });
  expect(host.querySelector('[data-growth-goal="goal_paused"]')?.textContent).toContain('已暂停'); expect(host.textContent).toContain('先说清楚自己缺少什么依据');
  expect(workspace.mock.calls.some(([input]) => input.type === 'growth.goal.status')).toBe(false);
});

it('requires independent feedback for pause, explicit continuation and retirement instead of silently changing published persona', async () => {
  let current = goal();
  const workspace = vi.fn<Workspace>(async input => {
    if (input.type === 'growth.goals.read') return { ok: true, growthGoals: [current] };
    if (input.type === 'growth.goal.status') { current = { ...current, status: input.status, revision: current.revision + 1 }; return { ok: true, growthGoal: current }; }
    return { ok: false };
  });
  const { api } = connection(workspace); await mount(api);
  for (const [button, confirm, status, revision] of [['暂停练习', '确认暂停', 'paused', 3], ['继续提出', '确认继续提出', 'proposed', 4], ['结束方向', '确认结束', 'retired', 5]] as const) {
    const before = workspace.mock.calls.filter(([input]) => input.type === 'growth.goal.status').length;
    await click(button); expect(workspace.mock.calls.filter(([input]) => input.type === 'growth.goal.status')).toHaveLength(before);
    const form = host.querySelector('form[aria-label="培养方向状态反馈"]')!; await fill('本次状态反馈', `明确${status}，保留具体来源。`, form); await click(confirm, form);
    expect(workspace).toHaveBeenCalledWith({ type: 'growth.goal.status', companionId: 'alice', conversationId: 'private_alice', operationId: expect.any(String), goalId: 'goal_proposed', expectedRevision: revision, status, feedback: `明确${status}，保留具体来源。` });
  }
  expect(host.querySelector('[data-growth-goal="goal_proposed"] button')).toBeNull();
  expect(workspace.mock.calls.some(([input]) => /integrat|profile|persona/u.test(input.type))).toBe(false);
});

it('ignores progress notifications but clears old private definitions before a full authorization refresh', async () => {
  let finish!: (response: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<Workspace>().mockResolvedValueOnce({ ok: true, growthGoals: [goal('proposed', 'alice', 'PRIVATE_GOAL_BEFORE_WITHDRAWAL')] }).mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
  const channel = connection(workspace); await mount(channel.api);
  await act(async () => { for (let n = 0; n < 5; n++) channel.changed({ kind: 'progress' }); }); expect(workspace).toHaveBeenCalledTimes(1);
  await act(async () => channel.changed()); expect(host.textContent).not.toContain('PRIVATE_GOAL_BEFORE_WITHDRAWAL');
  await act(async () => { await vi.waitFor(() => expect(workspace).toHaveBeenCalledTimes(2)); });
  await act(async () => finish({ ok: false, error: '来源已撤回。' })); expect(host.textContent).not.toContain('PRIVATE_GOAL_BEFORE_WITHDRAWAL'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('已撤回');
});

it('rejects foreign-owner, foreign-room and over-bound goal lists without rendering their definitions', async () => {
  for (const values of [[goal('proposed', 'bob', 'FOREIGN_OWNER_GOAL')], [{ ...goal(), conversationId: 'foreign_room', statement: 'FOREIGN_ROOM_GOAL' }], [goal(), goal()], Array.from({ length: 41 }, (_, index) => ({ ...goal(), id: `goal_${index}`, statement: 'OVER_BOUND_GOAL' }))]) {
    const workspace = vi.fn<Workspace>(async () => ({ ok: true, growthGoals: values })); await mount(connection(workspace).api);
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.querySelector('[data-growth-goal]')).toBeNull(); expect(host.textContent).not.toMatch(/FOREIGN_OWNER_GOAL|FOREIGN_ROOM_GOAL|OVER_BOUND_GOAL/u);
    await act(async () => root!.unmount()); host.remove(); root = undefined;
  }
});

it('discards a late old-owner list and requires a fresh room and authorized list for the new owner', async () => {
  let finish!: (response: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<Workspace>().mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ok: true, growthGoals: [goal('paused', 'bob', 'BOB_CURRENT_GOAL')] });
  const channel = connection(workspace); await mount(channel.api);
  await act(async () => root!.render(<CompanionGrowthGoals companionId="bob" api={channel.api} />));
  await act(async () => finish({ ok: true, growthGoals: [goal('proposed', 'alice', 'LATE_ALICE_GOAL')] }));
  expect(channel.request).toHaveBeenCalledTimes(2); expect(channel.request.mock.calls.every(([input]) => input.type === 'state')).toBe(true); expect(workspace).toHaveBeenLastCalledWith({ type: 'growth.goals.read', companionId: 'bob', conversationId: 'private_bob' });
  expect(host.textContent).toContain('BOB_CURRENT_GOAL'); expect(host.textContent).not.toContain('LATE_ALICE_GOAL');
});

it('stops subscriptions while Activity is hidden and revalidates on return without showing the old definition', async () => {
  let finish!: (response: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<Workspace>().mockResolvedValueOnce({ ok: true, growthGoals: [goal('paused', 'alice', 'OLD_PRIVATE_GOAL')] }).mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
  const channel = connection(workspace), element = (active: boolean) => <Activity mode={active ? 'visible' : 'hidden'}><CompanionGrowthGoals companionId="alice" api={channel.api} /></Activity>;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element(true)));
  expect(host.textContent).toContain('OLD_PRIVATE_GOAL'); expect(channel.listeners.size).toBe(1);
  await act(async () => root!.render(element(false))); expect(channel.listeners.size).toBe(0);
  await act(async () => channel.changed()); expect(workspace).toHaveBeenCalledTimes(1);
  await act(async () => root!.render(element(true))); expect(workspace).toHaveBeenCalledTimes(2); expect(host.textContent).not.toContain('OLD_PRIVATE_GOAL');
  await act(async () => finish({ ok: true, growthGoals: [goal('paused', 'alice', 'FRESH_PRIVATE_GOAL')] })); expect(host.textContent).toContain('FRESH_PRIVATE_GOAL');
});

it('opens a missing private room only on explicit action and rechecks scope before accepting feedback despite real change notifications', async () => {
  let opened = false, saved: CompanionGrowthGoal | undefined;
  const workspace = vi.fn<Workspace>(async input => {
    if (input.type === 'growth.goals.read') return { ok: true, growthGoals: saved ? [saved] : [] };
    if (input.type === 'growth.goals.propose') { saved = { ...goal(), ...input.goal, revision: 1 }; channel.changed(); return { ok: true, growthGoal: saved }; }
    return { ok: false };
  });
  const channel = connection(workspace);
  channel.request.mockImplementation(async input => {
    if (input.type === 'state') return { ok: true, state: { companions: [companion('alice')], conversations: opened ? [room()] : [], activities: [], configured: false } };
    if (input.type === 'conversation.open') { opened = true; channel.changed(); return { ok: true, conversation: room() }; }
    return { ok: false };
  });
  await mount(channel.api); expect(workspace).not.toHaveBeenCalled(); expect(channel.request).toHaveBeenCalledExactlyOnceWith({ type: 'state', readiness: 'navigation' });
  expect(host.querySelector('form')).toBeNull(); await click('打开私聊提出方向');
  expect(workspace.mock.calls.some(([input]) => input.type === 'growth.goals.propose')).toBe(false);
  expect(workspace).toHaveBeenCalledWith({ type: 'growth.goals.read', companionId: 'alice', conversationId: 'private_alice' });
  const form = host.querySelector('form[aria-label="培养方向反馈"]')!; expect(form).not.toBeNull();
  const beforeSubmissionReads = workspace.mock.calls.filter(([input]) => input.type === 'growth.goals.read').length;
  await fill('培养方向', '先陈述未知依据', form); await fill('适用情境', '首次阅读陌生资料时', form); await fill('本次反馈', '这是我的明确培养反馈，请保留为来源。', form); await click('提交培养方向', form);
  await act(async () => { await vi.waitFor(() => expect(workspace.mock.calls.some(([input]) => input.type === 'growth.goals.propose')).toBe(true)); });
  expect(workspace).toHaveBeenCalledWith({ type: 'growth.goals.propose', companionId: 'alice', conversationId: 'private_alice', operationId: expect.any(String), feedback: '这是我的明确培养反馈，请保留为来源。', goal: { statement: '先陈述未知依据', context: '首次阅读陌生资料时', examples: [], counterexamples: [], practice: [] } });
  await act(async () => { await vi.waitFor(() => expect(workspace.mock.calls.filter(([input]) => input.type === 'growth.goals.read').length).toBeGreaterThan(beforeSubmissionReads)); });
  expect(host.querySelector('[data-growth-goal="goal_proposed"]')?.textContent).toContain('先陈述未知依据');
  expect(channel.request.mock.calls.filter(([input]) => input.type === 'conversation.open')).toHaveLength(1); expect(host.querySelector('form')).toBeNull();
});

it('clears old source-backed editors on full invalidation and rejects a late mutation acknowledgement', async () => {
  let finish!: (response: CompanionWorkspaceResponse) => void, reads = 0;
  const workspace = vi.fn<Workspace>(async input => {
    if (input.type === 'growth.goals.read') return { ok: true, growthGoals: ++reads === 1 ? [goal('paused', 'alice', 'WITHDRAWN_DEFINITION')] : [] };
    if (input.type === 'growth.goals.propose') return new Promise(resolve => { finish = resolve; });
    return { ok: false };
  });
  const channel = connection(workspace); await mount(channel.api); await click('调整方向');
  const form = host.querySelector('form[aria-label="培养方向反馈"]')!; await fill('本次反馈', '明确调整定义但不恢复练习。', form); await click('保存方向调整', form);
  await act(async () => channel.changed()); expect(host.querySelector('form')).toBeNull(); expect(host.textContent).not.toContain('WITHDRAWN_DEFINITION');
  await act(async () => { await vi.waitFor(() => expect(reads).toBe(2)); }); const calls = workspace.mock.calls.length;
  await act(async () => finish({ ok: true, growthGoal: { ...goal('paused', 'alice', 'LATE_OLD_DEFINITION'), revision: 4 } }));
  expect(host.textContent).not.toContain('LATE_OLD_DEFINITION'); expect(host.querySelector('[data-growth-goal]')).toBeNull(); expect(workspace).toHaveBeenCalledTimes(calls);
});

it('rejects a stale or implicitly resumed response to a paused adjustment without changing its displayed status', async () => {
  for (const response of [{ ...goal('paused'), revision: 3 }, { ...goal('paused'), revision: 4, status: 'proposed' as const }]) {
    const workspace = vi.fn<Workspace>(async input => input.type === 'growth.goals.read' ? { ok: true, growthGoals: [goal('paused')] } : { ok: true, growthGoal: response });
    await mount(connection(workspace).api); await click('调整方向'); const form = host.querySelector('form[aria-label="培养方向反馈"]')!;
    await fill('本次反馈', '仅改定义，不恢复暂停。', form); await click('保存方向调整', form);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('归属或状态不一致'); expect(host.querySelector('[data-growth-goal="goal_paused"]')?.textContent).toContain('已暂停');
    expect(workspace.mock.calls.filter(([input]) => input.type === 'growth.goals.read')).toHaveLength(1);
    await act(async () => root!.unmount()); host.remove(); root = undefined;
  }
});

it('removes a previously authorized definition from its editor when an explicit fresh read is denied', async () => {
  let denied = false;
  const workspace = vi.fn<Workspace>(async () => denied ? { ok: false, error: '此来源现在不可读取。' } : { ok: true, growthGoals: [goal('paused', 'alice', 'OLD_AUTHORIZED_DEFINITION')] });
  await mount(connection(workspace).api); await click('调整方向'); expect(host.querySelector<HTMLTextAreaElement>('form textarea')?.value).toBe('OLD_AUTHORIZED_DEFINITION');
  denied = true; await click('重新核对方向'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('不可读取');
  expect(host.querySelector('form')).toBeNull(); expect(host.textContent).not.toContain('OLD_AUTHORIZED_DEFINITION'); expect(host.querySelector('[data-growth-goal]')).toBeNull();
});
