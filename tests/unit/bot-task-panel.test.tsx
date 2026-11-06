// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotTaskPanel } from '../../src/renderer/companion-bot/BotTaskPanel';
import { BotTaskNotice, botTaskNoticeVisible } from '../../src/renderer/companion-bot/BotTaskNotice';
import type { BotCompanion, BotRequest, BotResponse, BotTask } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement, calls: BotRequest[], tasks: BotTask[];
const createdAt = '2026-11-03T16:00:00.000Z';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); calls = [];
  tasks = Array.from({ length: 18 }, (_, i) => ({ id: `task-${i}`, conversationId: 'room', companionId: 'fish', title: `整理文件 ${i}`, goal: `这是完整原始要求 ${i}\n${'很长的执行约束。'.repeat(100)}`,
    status: i < 8 ? 'running' : i < 13 ? 'queued' : 'succeeded', createdAt, updatedAt: createdAt, progress: { phase: 'using-tool', toolName: 'shell', detail: 'PRIVATE REASONING AND RAW ARGUMENTS', updatedAt: createdAt }, summary: `原始执行回执 ${i}` }));
});
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
function response(request: BotRequest): BotResponse {
  if (request.type === 'task.list') {
    const scope = tasks.filter(task => task.conversationId === request.conversationId && (!request.companionId || task.companionId === request.companionId));
    const items = scope.filter(task => (request.filter === 'all' || request.filter === 'active' && task.status !== 'succeeded' || request.filter === 'done' && task.status === 'succeeded') && (!request.query || task.title?.includes(request.query)));
    return { ok: true, taskPage: { items: items.slice(request.page * request.limit, (request.page + 1) * request.limit), total: items.length, page: request.page, limit: request.limit, activeCount: scope.filter(task => !['succeeded', 'failed', 'cancelled'].includes(task.status)).length, queuedCount: scope.filter(task => task.status === 'queued').length, finishedCount: scope.filter(task => ['succeeded', 'failed', 'cancelled'].includes(task.status)).length } };
  }
  if (request.type === 'task.get') return { ok: true, task: tasks.find(task => task.id === request.taskId) };
  return { ok: true };
}
async function mount(override?: (request: BotRequest) => Promise<BotResponse> | undefined, focusedTaskId?: string, group = false, refreshVersion?: unknown) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const companions: BotCompanion[] = [{ id: 'fish', name: '大肥鱼', persona: '', createdAt }, { id: 'other', name: 'GPT', persona: '', createdAt }];
  const props = { conversationId: 'room', tasks: tasks.slice(0, 2), locale: 'zh-CN' as const, group, companions, refreshVersion, focusedTaskId, onFocus: vi.fn(), onClose: vi.fn(), request: async (request: BotRequest) => { calls.push(request); return override?.(request) ?? response(request); }, changed: async () => undefined };
  await act(() => root!.render(<div className="bot-workspace"><BotTaskPanel {...props} /></div>));
  return props;
}
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)!;
  expect(button, label).toBeDefined(); await act(() => button.click());
}
async function search(value: string) {
  const field = host.querySelector<HTMLInputElement>('[aria-label="搜索任务"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

it('pages the server catalog and only mounts the selected task detail with explicit tabs', async () => {
  await mount();
  expect(calls[0]).toMatchObject({ type: 'task.list', conversationId: 'room', limit: 6, page: 0 });
  expect(host.querySelectorAll('[data-task-row]')).toHaveLength(6);
  expect(host.querySelectorAll('[data-bot-task]')).toHaveLength(1);
  expect(host.querySelector('.bot-task-heading h4')?.textContent).toBe('整理文件 0');
  expect(host.querySelectorAll('details')).toHaveLength(0);
  expect(host.querySelector('.bot-task-goal')).toBeNull();
  expect(host.querySelector('.bot-task-receipt')).toBeNull();
  expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain('这项任务');
  expect(host.textContent).not.toContain('PRIVATE REASONING');
  await click('下一页任务');
  expect(calls.filter(call => call.type === 'task.list').at(-1)).toMatchObject({ page: 1, limit: 6 });
  expect(host.querySelector('[data-task-row]')?.getAttribute('data-task-row')).toBe('task-6');
  expect(host.querySelector('[data-bot-task]')?.getAttribute('data-bot-task')).toBe('task-6');
});

it('does not reset a quickly selected second page when the initial empty search debounce settles', async () => {
  await mount(); await click('下一页任务');
  expect(host.querySelector('.bot-tasks-pagination')?.textContent).toContain('2 / 3');
  await act(() => vi.advanceTimersByTime(220));
  expect(host.querySelector('.bot-tasks-pagination')?.textContent).toContain('2 / 3');
  expect(host.querySelector('[data-task-row]')?.getAttribute('data-task-row')).toBe('task-6');
});

it('debounces search and sends filters to the server rather than filtering the snapshot', async () => {
  await mount(); const initial = calls.length;
  await search('整理文件 17'); expect(calls).toHaveLength(initial);
  await act(() => vi.advanceTimersByTime(180));
  expect(calls.filter(call => call.type === 'task.list').at(-1)).toMatchObject({ query: '整理文件 17', page: 0 });
  expect(host.querySelector('[data-task-row]')?.getAttribute('data-task-row')).toBe('task-17');
  await click('已结束');
  expect(calls.filter(call => call.type === 'task.list').at(-1)).toMatchObject({ filter: 'done' });
});

it('ignores a late detail response when another task has been selected', async () => {
  let complete!: (value: BotResponse) => void;
  const old = new Promise<BotResponse>(resolve => { complete = resolve; });
  await mount(request => request.type === 'task.get' && request.taskId === 'task-0' ? old : undefined);
  await act(() => host.querySelector<HTMLButtonElement>('[data-task-row="task-1"]')!.click());
  expect(host.querySelector('[data-bot-task]')?.getAttribute('data-bot-task')).toBe('task-1');
  await act(() => complete({ ok: true, task: tasks[0] }));
  expect(host.querySelector('[data-bot-task]')?.getAttribute('data-bot-task')).toBe('task-1');
});

it('shows parallel executor activity and retains queue action IDs after a lost response', async () => {
  let attempt = 0;
  await mount(request => request.type === 'task.queue.control' ? Promise.resolve(++attempt === 1 ? { ok: false, error: '连接暂时中断' } : { ok: true }) : undefined);
  expect(host.querySelectorAll('.bot-task-row-activity')).toHaveLength(6);
  expect(host.querySelector('.bot-task-row-activity')?.textContent).toContain('正在执行工具 · shell');
  await click('管理任务队列'); await click('清理排队');
  expect(host.querySelector('[role="alertdialog"] h4')?.textContent).toContain('5 项排队任务');
  expect(calls.some(call => call.type === 'task.queue.control')).toBe(false);
  await click('确认'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('连接暂时中断');
  await click('确认');
  const changes = calls.filter(call => call.type === 'task.queue.control'); expect(changes).toHaveLength(2); expect(changes[1]).toEqual(changes[0]);
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});

it('opens an old task by its trusted notice ID without rendering or parsing raw executor text', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const open = vi.fn();
  await act(() => root!.render(<BotTaskNotice locale="zh-CN" tasks={[]} onOpen={open} message={{ id: 'notice', eventId: 'event', conversationId: 'room', senderId: 'task-service', senderName: '任务回执', createdAt, sequence: 1, status: 'sent', content: 'SECRET MASSIVE WORKER OUTPUT', taskNotice: { taskId: 'task-old-not-in-snapshot', kind: 'task_done' } }} />));
  expect(host.textContent).not.toContain('SECRET'); await click('查看任务 · 任务有新进展'); expect(open).toHaveBeenCalledWith('task-old-not-in-snapshot');
});

it('hides a transport notice only after its own visible natural reply has actually been sent', () => {
  const notice = { id: 'notice', eventId: 'e', conversationId: 'room', senderId: 'task-service', senderName: '任务回执', content: 'RAW', sequence: 1, status: 'sent' as const, createdAt, taskNotice: { taskId: 't', kind: 'task_done' as const, replyMessageId: 'reply' } };
  const reply = { ...notice, id: 'reply', senderId: 'fish', senderName: '大肥鱼', taskNotice: undefined, content: '结果已经整理好。' };
  expect(botTaskNoticeVisible(notice, [{ ...reply, status: 'running' }])).toBe(true);
  expect(botTaskNoticeVisible(notice, [{ ...reply, status: 'failed' }])).toBe(true);
  expect(botTaskNoticeVisible(notice, [{ ...reply, content: '' }])).toBe(true);
  expect(botTaskNoticeVisible(notice, [{ ...reply, conversationId: 'other-room' }])).toBe(true);
  expect(botTaskNoticeVisible(notice, [reply])).toBe(false);
});

it('limits the transport notice title to a compact label without exposing its long goal', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const task = { ...tasks[0]!, title: '一个很长的任务标题'.repeat(12) };
  await act(() => root!.render(<BotTaskNotice locale="zh-CN" tasks={[task]} onOpen={() => undefined} message={{ id: 'n', eventId: 'e', conversationId: 'room', senderId: 'task-service', senderName: '任务回执', createdAt, sequence: 1, status: 'sent', content: 'RAW', taskNotice: { taskId: task.id, kind: 'task_progress' } }} />));
  expect(host.querySelector('.bot-task-notice-title')?.textContent?.length).toBe(32);
  expect(host.textContent).not.toContain('完整原始要求');
});

it('keeps the real responsible identity on an old receipt outside the task snapshot', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const open = vi.fn();
  await act(() => root!.render(<BotTaskNotice locale="zh-CN" tasks={[]} onOpen={open} companions={[]}
    message={{ id: 'n', eventId: 'e', conversationId: 'room', senderId: 'task-service', senderName: '任务回执', createdAt, sequence: 1, status: 'sent', content: 'RAW SECRET',
      taskNotice: { taskId: 'old', kind: 'task_progress', companionId: 'gpt', companionName: 'GPT', title: '列桌面的歌曲' } }} />));
  expect(host.querySelector('[data-task-owner]')?.getAttribute('data-task-owner')).toBe('gpt');
  expect(host.querySelector('.bot-task-notice-meta strong')?.textContent).toBe('GPT');
  expect(host.querySelector('.bot-task-notice-title')?.textContent).toBe('列桌面的歌曲');
  expect(host.querySelector('time')?.getAttribute('datetime')).toBe(createdAt);
  expect(host.querySelector('time')?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/u);
  expect(host.textContent).not.toContain('RAW SECRET');
  await click('查看任务 · 列桌面的歌曲'); expect(open).toHaveBeenCalledWith('old');
});

it('selects the neighboring task after terminal removal without remounting the deleted record', async () => {
  tasks = tasks.slice(0, 6).map(task => ({ ...task, status: 'succeeded' }));
  await mount(request => { if (request.type === 'task.control' && request.operation === 'remove') { tasks = tasks.filter(task => task.id !== request.taskId); return Promise.resolve({ ok: true }); } });
  await act(() => host.querySelector<HTMLButtonElement>('[data-task-row="task-2"]')!.click());
  await click('移除记录');
  expect(host.querySelector('[data-bot-task]')?.getAttribute('data-bot-task')).toBe('task-3');
  expect(host.querySelector('[data-task-row="task-2"]')).toBeNull(); expect(host.querySelector('[role=alert]')).toBeNull();
});

it('returns from an empty last page after removing its final record', async () => {
  tasks = tasks.slice(0, 7).map(task => ({ ...task, status: 'succeeded' }));
  await mount(request => { if (request.type === 'task.control' && request.operation === 'remove') { tasks = tasks.filter(task => task.id !== request.taskId); return Promise.resolve({ ok: true }); } });
  await click('下一页任务'); expect(host.querySelectorAll('[data-task-row]')).toHaveLength(1);
  await click('移除记录');
  expect(host.querySelector('.bot-tasks-pagination')?.textContent).toContain('1 / 1');
  expect(host.querySelectorAll('[data-task-row]')).toHaveLength(6); expect(host.querySelector('[role=alert]')).toBeNull();
});

it('clears only ended records through a counted batch confirmation and preserves active work', async () => {
  await mount(request => { if (request.type === 'task.queue.control' && request.operation === 'clear_finished') { tasks = tasks.filter(task => !['succeeded', 'failed', 'cancelled'].includes(task.status)); return Promise.resolve({ ok: true }); } });
  await click('管理任务队列'); await click('清理已结束');
  expect(host.querySelector('[role=alertdialog]')?.textContent).toContain('5 项已结束记录');
  await click('确认');
  expect(calls.find(call => call.type === 'task.queue.control')).toMatchObject({ operation: 'clear_finished' });
  expect(tasks).toHaveLength(13); expect(host.querySelector('[role=alertdialog]')).toBeNull();
});

it('handles a retained chat notice for a removed task with a calm empty state and return navigation', async () => {
  await mount(request => request.type === 'task.get' && request.taskId === 'removed-old' ? Promise.resolve({ ok: true, taskRemoved: true }) : undefined, 'removed-old');
  expect(host.textContent).toContain('该任务记录已移除'); expect(host.querySelector('[role=alert]')).toBeNull();
  expect(host.querySelector('.bot-task-selected')?.getAttribute('aria-busy')).toBe('false');
  await click('返回任务列表');
  expect(host.querySelector('[data-bot-task]')?.getAttribute('data-bot-task')).toBe('task-0');
});


it('filters group owners through server paging and scopes bulk controls to that companion in the same group', async () => {
  tasks = tasks.map((task, index) => ({ ...task, companionId: index < 10 ? 'fish' : 'other', companionName: index < 10 ? '大肥鱼' : 'GPT' }));
  await mount(undefined, undefined, true);
  expect(host.querySelector('.bot-tasks-header h3')?.textContent).toBe('群任务工作台');
  expect(host.querySelectorAll('[data-task-row] .bot-task-owner')).toHaveLength(6);
  const select = host.querySelector<HTMLSelectElement>('[aria-label="筛选负责伙伴"]')!;
  await act(() => { select.value = 'other'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(calls.filter(call => call.type === 'task.list').at(-1)).toMatchObject({ conversationId: 'room', companionId: 'other', page: 0, limit: 6 });
  expect(host.querySelector('.bot-tasks-pagination')?.textContent).toContain('共 8 项');
  expect([...host.querySelectorAll('[data-task-row] .bot-task-owner')].every(element => element.getAttribute('data-task-owner') === 'other' && element.textContent?.includes('GPT'))).toBe(true);
  expect(host.querySelector('.bot-task-heading .bot-task-owner')?.getAttribute('data-task-owner')).toBe('other');
  await click('下一页任务'); expect(host.querySelectorAll('[data-task-row]')).toHaveLength(2);
  expect(host.querySelector('.bot-tasks-pagination')?.textContent).toContain('2 / 2');
  await search('整理文件 17'); await act(() => vi.advanceTimersByTime(180));
  expect(host.querySelectorAll('[data-task-row]')).toHaveLength(1);
  await click('管理任务队列'); await click('清理该伙伴已结束');
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('本群 · GPT');
  expect(host.querySelector('[role="alertdialog"] h4')?.textContent).toContain('5 项已结束记录');
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('关键词与状态筛选不改变');
  await click('确认');
  expect(calls.filter(call => call.type === 'task.queue.control').at(-1)).toMatchObject({ conversationId: 'room', companionId: 'other', operation: 'clear_finished' });
});

it('keeps direct task views free of redundant owner filters and labels', async () => {
  await mount();
  expect(host.querySelector('[aria-label="筛选负责伙伴"]')).toBeNull();
  expect(host.querySelector('.bot-task-owner')).toBeNull();
});


it('coalesces changed snapshots and refreshes an old selected task outside the recent snapshot tasks', async () => {
  const props = await mount(undefined, 'task-17', false, 0);
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已完成');
  const before = calls.filter(call => call.type === 'task.get').length;
  tasks[17] = { ...tasks[17]!, status: 'failed' };
  await act(() => root!.render(<div className="bot-workspace"><BotTaskPanel {...props} refreshVersion={1} /></div>));
  await act(() => root!.render(<div className="bot-workspace"><BotTaskPanel {...props} refreshVersion={2} /></div>));
  await act(() => vi.advanceTimersByTime(249));
  expect(calls.filter(call => call.type === 'task.get')).toHaveLength(before);
  await act(() => vi.advanceTimersByTime(1));
  expect(calls.filter(call => call.type === 'task.get')).toHaveLength(before + 1);
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已结束 · 失败');
});


it('rejects late owner pages after switching the group owner filter', async () => {
  tasks = tasks.map((task, index) => ({ ...task, companionId: index < 10 ? 'fish' : 'other', companionName: index < 10 ? '大肥鱼' : 'GPT' }));
  let complete!: (result: BotResponse) => void;
  const old = new Promise<BotResponse>(resolve => { complete = resolve; });
  await mount(request => request.type === 'task.list' && request.companionId === 'fish' ? old : undefined, undefined, true);
  const select = host.querySelector<HTMLSelectElement>('[aria-label="筛选负责伙伴"]')!;
  await act(() => { select.value = 'fish'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(() => { select.value = 'other'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('.bot-tasks-pagination')?.textContent).toContain('共 8 项');
  await act(() => complete(response({ type: 'task.list', conversationId: 'room', companionId: 'fish', filter: 'all', page: 0, limit: 6 })));
  expect(host.querySelector('.bot-tasks-pagination')?.textContent).toContain('共 8 项');
  expect([...host.querySelectorAll('[data-task-row] .bot-task-owner')].every(element => element.getAttribute('data-task-owner') === 'other')).toBe(true);
});


it('keeps paused and legacy stopped row clocks frozen and equal to the selected detail', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T01:00:00Z'));
  tasks = [
    { ...tasks[0]!, status: 'paused', elapsedMs: 62000, pausedAt: '2026-11-05T01:01:02Z' },
    { ...tasks[1]!, status: 'waiting', createdAt: '2026-11-05T01:00:00Z', updatedAt: '2026-11-06T00:00:00Z', cancelRequested: true, stopRequestedAt: '2026-11-05T01:01:30Z', progress: { phase: 'stop-unconfirmed' } },
  ];
  await mount();
  const row = () => host.querySelector('[data-task-row="task-0"] .bot-task-row-activity')?.textContent;
  const stoppedRow = () => host.querySelector('[data-task-row="task-1"] .bot-task-row-activity')?.textContent;
  expect(row()).toContain('1 分 2 秒'); expect(stoppedRow()).toBe('已停止 · 1 分 30 秒');
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时1 分 2 秒');
  await act(() => vi.advanceTimersByTime(12 * 60 * 60 * 1000));
  expect(row()).toContain('1 分 2 秒'); expect(stoppedRow()).toBe('已停止 · 1 分 30 秒');
  await act(() => host.querySelector<HTMLButtonElement>('[data-task-row="task-1"]')!.click());
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时1 分 30 秒');
  expect(host.textContent).not.toContain('停止待核实');
  expect(host.textContent).not.toContain('等待停止确认');
});
