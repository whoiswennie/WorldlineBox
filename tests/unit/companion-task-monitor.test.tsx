// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionTaskMonitor } from '../../src/renderer/companions/CompanionTaskMonitor';
import { companionTimestamp, companionTimezone } from '../../src/shared/companion-time';
import type { Companion, CompanionAction, CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';
let root: Root | undefined, container: HTMLDivElement | undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); });

it('coalesces slow task polls and accepts completion while the parent still holds an older queued snapshot', async () => {
  vi.useFakeTimers();
  const queued: CompanionAction = { id: 'slow_task', companionId: 'role', conversationId: 'group', title: '等待状态同步的任务',
    status: 'queued', createdAt: '2026-10-25T10:46:25.161Z', updatedAt: '2026-10-25T10:46:25.161Z' };
  const completed: CompanionAction = { ...queued, status: 'succeeded', updatedAt: '2026-10-25T10:48:56.556Z', result: '真实执行结果已经返回。' };
  let finish!: (value: CompanionsResponse) => void;
  const pending = new Promise<CompanionsResponse>(resolve => { finish = resolve; });
  const request = vi.fn<(input: CompanionsRequest) => Promise<CompanionsResponse>>().mockResolvedValue({ ok: true, action: completed });
  request.mockImplementationOnce(() => pending);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CompanionTaskMonitor actions={[queued]} companions={[]} conversationId="group"
    initialActionId={queued.id} initialView="active" request={request} now={Date.now()} onClose={vi.fn()} onStop={vi.fn()} onGuide={vi.fn()} onOpenUrl={vi.fn()} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(request).toHaveBeenCalledOnce();
  await act(async () => { finish({ ok: true, action: completed }); });
  expect(container.querySelector('main')!.textContent).toContain('真实执行结果已经返回');
  const reads = request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(request.mock.calls).toHaveLength(reads);
});
it('switches durable history pages and roles, preserves the live selected stream, and shows exact timestamps', async () => {
  const roles: Companion[] = ['姐姐', '妹妹'].map((name, index) => ({ id: 'role' + index, name, avatar: 'custom', description: '', persona: '伙伴', model: '', builtin: false, proactive: false, createdAt: '2026-10-13T02:00:00.123Z' }));
  const tasks: CompanionAction[] = Array.from({ length: 45 }, (_, index) => ({ id: 'task' + index, conversationId: 'group', companionId: 'role' + index % 2, sourceMessageId: 'source', title: '任务' + index, status: index === 0 ? 'running' : 'succeeded', createdAt: new Date(Date.UTC(2026, 9, 13, 2, 45 - index, 0, 123)).toISOString(), updatedAt: '2026-10-13T03:00:00.456Z', result: '历史结果' + index }));
  const request = vi.fn(async (input: CompanionsRequest) => {
    if (input.type === 'action.get') return { ok: true, action: tasks.find(task => task.id === input.id) };
    if (input.type !== 'actions.page') return { ok: true };
    const filtered = tasks.filter(task => !input.companionId || task.companionId === input.companionId), limit = input.limit ?? 20;
    const start = input.before ? filtered.findIndex(task => task.id === input.before!.id) + 1 : 0;
    const items = filtered.slice(start, start + limit), last = items.at(-1)!;
    return { ok: true, actionPage: { items, total: filtered.length, hasMore: start + limit < filtered.length, ...(start + limit < filtered.length ? { nextCursor: { id: last.id, createdAt: last.createdAt } } : {}), owners: roles.map((role, index) => ({ companionId: role.id, name: role.name, count: index ? 22 : 23 })) } };
  });
  const onClose = vi.fn(), props = { actions: [tasks[0]!], companions: roles, conversationId: 'group', request, now: Date.now(), onClose, onStop: vi.fn(), onGuide: vi.fn(), onOpenUrl: vi.fn() };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CompanionTaskMonitor {...props} />));
  const history = () => container!.querySelector('nav[aria-label="选择伙伴任务"]')!;
  const button = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  expect(history().querySelectorAll('button')).toHaveLength(20);
  expect(container.textContent).toContain(companionTimestamp(tasks[0]!.createdAt));
  expect(container.textContent).toContain(companionTimezone(tasks[0]!.createdAt));
  await act(async () => button('下一页').click());
  expect(container.textContent).toContain('第 2 页');
  expect(container.textContent).toContain('历史结果20');
  const select = container.querySelector<HTMLSelectElement>('#companion-task-owner')!;
  await act(async () => { select.value = 'role1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.textContent).toContain('共 22 条 · 每页 20 条');
  expect(container.textContent).toContain('第 1 页');
  expect(history().textContent).not.toContain('姐姐');
  await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.textContent).toContain('共 45 条 · 每页 20 条');
  await act(async () => history().querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => root!.render(<CompanionTaskMonitor {...props} actions={[{ ...tasks[0]!, events: [{ sequence: 1, type: 'message', summary: '流式输出', contentKind: 'message', content: '实时的新输出', receivedAt: '2026-10-13T03:00:01.789Z' }] }]} />));
  expect(container.textContent).toContain('实时的新输出');
  expect(container.textContent).toContain(companionTimestamp('2026-10-13T03:00:01.789Z'));
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(onClose).toHaveBeenCalledOnce();
});
it('keeps milliseconds and calendar fields exact rather than replacing missing timestamps with the current time', () => {
  const value = '2026-10-13T02:03:04.007Z', date = new Date(value), shown = companionTimestamp(value);
  expect(shown).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:03:04\.007$/);
  expect(shown.startsWith(String(date.getFullYear()))).toBe(true);
  expect(companionTimestamp('invalid')).toBe('时间不可用');
});

it('shows concurrent active tasks together without history noise and keeps the selected work stable when another arrives or finishes', async () => {
  const base = { conversationId: 'room', companionId: 'one', sourceMessageId: 'source', createdAt: '2026-10-15T01:00:00.000Z', updatedAt: '2026-10-15T01:00:00.000Z' };
  const first: CompanionAction = { ...base, id: 'first', title: '核对新闻', status: 'running' };
  const second: CompanionAction = { ...base, id: 'second', title: '查询天气', status: 'queued' };
  const done: CompanionAction = { ...base, id: 'done', title: '昨天已经完成', status: 'succeeded' };
  let tasks = [first, second, done];
  const request = vi.fn(async (input: CompanionsRequest) => input.type === 'action.get' ? { ok: true, action: tasks.find(item => item.id === input.id) } : { ok: true, actionPage: { items: tasks, total: tasks.length, hasMore: false, owners: [] } });
  const props = { actions: tasks, companions: [], conversationId: 'room', initialView: 'active' as const, request, now: Date.now(), onClose: vi.fn(), onStop: vi.fn(), onGuide: vi.fn(), onOpenUrl: vi.fn() };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CompanionTaskMonitor {...props} />));
  const nav = () => container!.querySelector('nav')!;
  expect(nav().querySelectorAll('button')).toHaveLength(2);
  expect(nav().textContent).not.toContain('昨天已经完成');
  expect(container.querySelector('header')!.textContent).toContain('1 件进行中 · 1 件等待中');
  await act(async () => nav().querySelectorAll<HTMLButtonElement>('button')[1]!.click());
  tasks = [{ ...second, status: 'succeeded', result: '上海晴天' }, first, { ...first, id: 'third', title: '新来的任务' }, done];
  await act(async () => root!.render(<CompanionTaskMonitor {...props} actions={tasks} />));
  expect(container.querySelector('main')!.textContent).toContain('查询天气');
  expect(container.querySelector('main')!.textContent).not.toContain('新来的任务');
  expect(nav().querySelectorAll('button')).toHaveLength(2);
  const history = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === '全部记录')!;
  await act(async () => history.click());
  expect(nav().textContent).toContain('昨天已经完成');
  expect(request.mock.calls.some(([input]) => input.type === 'actions.page')).toBe(true);
});

it('opens an older linked task outside the first page and follows its own stream until the user chooses another task', async () => {
  const action: CompanionAction = { id: 'linked-old', conversationId: 'group', companionId: 'role', sourceMessageId: 'source',
    title: '从聊天打开的旧任务', status: 'running', createdAt: '2026-10-13T02:00:00.123Z', updatedAt: '2026-10-13T03:00:00.456Z',
    events: [{ sequence: 0, type: 'message', summary: '原始过程', contentKind: 'message', content: '旧任务的实时过程', receivedAt: '2026-10-13T03:00:00.456Z' }] };
  const newer = { ...action, id: 'newer', title: '较新的其他任务', events: [] };
  const request = vi.fn(async (input: CompanionsRequest) => input.type === 'action.get' ? { ok: true, action: input.id === action.id ? action : newer }
    : { ok: true, actionPage: { items: [newer], total: 2, hasMore: false, owners: [] } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const props = { actions: [], companions: [], conversationId: 'group', initialActionId: action.id, request, now: Date.now(), onClose: vi.fn(), onStop: vi.fn(), onGuide: vi.fn(), onOpenUrl: vi.fn() };
  await act(async () => root!.render(<CompanionTaskMonitor {...props} />));
  expect(container.querySelector('main')!.textContent).toContain('旧任务的实时过程');
  await act(async () => root!.render(<CompanionTaskMonitor {...props} actions={[newer]} />));
  expect(container.querySelector('main')!.textContent).toContain('旧任务的实时过程');
  await act(async () => container!.querySelector<HTMLButtonElement>('nav button')!.click());
  expect(container.querySelector('main')!.textContent).toContain('较新的其他任务');
  expect(container.querySelector('main')!.textContent).not.toContain('旧任务的实时过程');
});
