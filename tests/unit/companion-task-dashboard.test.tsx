// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionTaskDashboard } from '../../src/renderer/companions/CompanionTaskDashboard';
import type { CompanionTaskItem, CompanionTaskPage } from '../../src/shared/companion-task-overview';
import type { CompanionRequest } from '../../src/renderer/companions/CompanionDialogs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-26T04:00:00.000Z';
const task = (patch: Partial<CompanionTaskItem> = {}): CompanionTaskItem => ({ id: 'reply-1', kind: 'reply', companionId: 'fish', conversationId: 'private-fish',
  title: '查询今天的比赛', status: 'running', rawStatus: 'running', stage: '正在核对赛程', createdAt: at, startedAt: at, updatedAt: at, canStop: true, stoppedByUser: false, ...patch });
const page = (items: CompanionTaskItem[], patch: Partial<CompanionTaskPage> = {}): CompanionTaskPage => ({ items, total: items.length, current: items.length, history: 0, owners: [
  { companionId: 'fish', name: '小肥鱼', current: 2, history: 1 }, { companionId: 'sister', name: '大肥鱼', current: 1, history: 0 },
], hasMore: false, observedAt: at, coverage: ['reply', 'action', 'activity', 'memory_index'], ...patch });
async function mount(request: CompanionRequest) { node = document.createElement('div'); document.body.append(node); root = createRoot(node); await act(async () => root!.render(<CompanionTaskDashboard companions={[]} request={request} onClose={() => undefined} />)); }
function button(label: string) { const found = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label); if (!found) throw Error('Missing button ' + label); return found; }
async function click(label: string) { await act(async () => button(label).click()); }

it('lists chat, activity and memory work across conversations without eagerly loading tool bodies', async () => {
  const items = [task(), task({ id: 'walk', kind: 'activity', companionId: 'sister', conversationId: 'world-sister', title: '出门拜访' }), task({ id: 'index', kind: 'memory_index', conversationId: 'hidden-fish', title: '更新记忆索引', stage: '等待编码器', status: 'waiting' })];
  const request = vi.fn<CompanionRequest>(async () => ({ ok: true, taskPage: page(items) })); await mount(request);
  expect(request).toHaveBeenCalledWith({ type: 'tasks.list', view: 'current', limit: 20 });
  expect(node!.querySelectorAll('[data-companion-task]')).toHaveLength(3);
  expect(node!.textContent).toContain('聊天回复'); expect(node!.textContent).toContain('自主活动'); expect(node!.textContent).toContain('记忆索引');
  expect(request.mock.calls.every(([command]) => command.type === 'tasks.list' || command.type === 'task.inspect' && command.id === 'reply-1')).toBe(true);
  expect(request.mock.calls.some(([command]) => command.type === 'task.content')).toBe(false);
  expect(button('停止任务 查询今天的比赛')).toBeDefined();
});

it('scopes the list to an owner rather than the currently opened conversation', async () => {
  const request = vi.fn<CompanionRequest>(async command => command.type === 'tasks.list' && command.companionId === 'sister'
    ? { ok: true, taskPage: page([task({ id: 'sister-task', companionId: 'sister', conversationId: 'another-room', title: '另一个聊天的目标' })]) }
    : { ok: true, taskPage: page([task()]) });
  await mount(request); const owner = node!.querySelector<HTMLSelectElement>('#companion-task-dashboard-owner')!;
  await act(async () => { owner.value = 'sister'; owner.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(request).toHaveBeenCalledWith({ type: 'tasks.list', companionId: 'sister', view: 'current', limit: 20 });
  expect(node!.textContent).toContain('另一个聊天的目标'); expect(node!.textContent).not.toContain('查询今天的比赛');
});

it('sends an exact stop target and shows its persisted user-stopped history without an error label', async () => {
  let stopped = false;
  const request = vi.fn<CompanionRequest>(async command => {
    if (command.type === 'task.stop') { stopped = true; return { ok: true }; }
    if (command.type === 'tasks.list' && command.view === 'history') return { ok: true, taskPage: page([task({ status: 'cancelled', rawStatus: 'cancelled', canStop: false, stoppedByUser: true, stopRequestedAt: '2026-10-26T04:02:00Z', finishedAt: '2026-10-26T04:02:00Z', stage: '用户手动停止' })], { current: 0, history: 1 }) };
    return { ok: true, taskPage: page(stopped ? [] : [task()], { history: stopped ? 1 : 0 }) };
  });
  await mount(request); await click('停止任务 查询今天的比赛');
  expect(request).toHaveBeenCalledWith({ type: 'task.stop', companionId: 'fish', kind: 'reply', id: 'reply-1' });
  expect(node!.querySelector('[role="status"]')?.textContent).toContain('任务已停止'); await click('已结束记录');
  expect(node!.textContent).toContain('用户已停止'); expect(node!.querySelector('[aria-label="总用时 2 分 00 秒"]')).toBeTruthy();
  expect(node!.textContent).not.toContain('执行失败'); expect(node!.querySelector('[data-task-status]')?.getAttribute('data-task-status')).toBe('cancelled');
});

it('does not claim a stop succeeded when the host has not confirmed it', async () => {
  const request = vi.fn<CompanionRequest>(async command => command.type === 'task.stop' ? { ok: false, error: '宿主暂未确认停止' } : { ok: true, taskPage: page([task()]) });
  await mount(request); await click('停止任务 查询今天的比赛');
  expect(node!.querySelector('[role="alert"]')?.textContent).toContain('宿主暂未确认停止'); expect(node!.textContent).not.toContain('已收到你的停止请求');
  expect(node!.querySelector('[data-task-status]')?.getAttribute('data-task-status')).toBe('running');
});

it('resumes the exact manually stopped reply without creating a new task or confusing it with an error', async () => {
  const request = vi.fn<CompanionRequest>(async command => command.type === 'task.resume' ? { ok: true } : { ok: true,
    taskPage: page([task({ status: 'cancelled', rawStatus: 'cancelled', canStop: false, stoppedByUser: true })], { current: 0, history: 1 }) });
  await mount(request); await click('恢复任务 查询今天的比赛');
  expect(request).toHaveBeenCalledWith({ type: 'task.resume', companionId: 'fish', kind: 'reply', id: 'reply-1' });
  expect(node!.querySelector('[role="status"]')?.textContent).toContain('任务已恢复');
  expect(request.mock.calls.some(([command]) => command.type === 'message.send')).toBe(false);
});

it('rejects a late owner response after the user has switched owners', async () => {
  let accept!: (value: Awaited<ReturnType<CompanionRequest>>) => void;
  const late = new Promise<Awaited<ReturnType<CompanionRequest>>>(resolve => { accept = resolve; });
  let held = false;
  const request = vi.fn<CompanionRequest>(async command => {
    if (command.type === 'tasks.list' && command.companionId === 'sister') return { ok: true, taskPage: page([task({ companionId: 'sister', title: '姐姐的当前任务' })]) };
    if (held) return late;
    return { ok: true, taskPage: page([task()]) };
  });
  await mount(request); held = true; await click('刷新任务清单');
  const owner = node!.querySelector<HTMLSelectElement>('#companion-task-dashboard-owner')!;
  await act(async () => { owner.value = 'sister'; owner.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => accept({ ok: true, taskPage: page([task({ title: '不应回填的旧任务' })]) }));
  expect(node!.textContent).toContain('姐姐的当前任务'); expect(node!.textContent).not.toContain('不应回填');
});

it('keeps terminal duration frozen, reports missing timestamps, and uses bounded history cursors', async () => {
  const cursor = { at, kind: 'reply' as const, id: 'reply-1' };
  const request = vi.fn<CompanionRequest>(async command => ({ ok: true, taskPage: page([task({ status: 'completed', rawStatus: 'done', canStop: false,
    finishedAt: '2026-10-26T05:02:03Z', updatedAt: '2026-10-26T09:00:00Z' })], { hasMore: command.type === 'tasks.list' && !command.cursor, nextCursor: command.type === 'tasks.list' && !command.cursor ? cursor : undefined }) }));
  await mount(request); await click('已结束记录'); expect(node!.textContent).toContain('1 小时 2 分 03 秒');
  await click('下一页'); expect(request).toHaveBeenCalledWith({ type: 'tasks.list', view: 'history', limit: 20, cursor });
  expect(button('下一页').disabled).toBe(true);
});
