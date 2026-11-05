// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotChatContext } from '../../src/renderer/companion-bot/BotChatContext';
import type { BotBrainContextSummary, BotTask } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
const at = '2026-11-04T03:55:00.000Z';
const companions = ['大肥鱼', 'GPT'].map((name, index) => ({ id: `person-${index}`, name, persona: '', createdAt: at }));
const props = (): ComponentProps<typeof BotChatContext> => ({
  conversation: { id: 'room', title: '一起做世界线', kind: 'group', memberIds: ['user', ...companions.map(person => person.id)], createdAt: at },
  companions, tasks: [], locale: 'zh-CN', onClose: vi.fn(), onEdit: vi.fn(), onMemory: vi.fn(), onTask: vi.fn(), onMembers: vi.fn(),
});
async function mount(value: ComponentProps<typeof BotChatContext>) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(() => root!.render(<BotChatContext {...value} />)); await act(() => host.querySelector<HTMLButtonElement>('.bot-context-group-tabs button:last-child')?.click()); }
const context = (id = 'person-0'): BotBrainContextSummary => ({ conversationId: 'room', companionId: id, epoch: 3, runningMessages: 1, queuedMessages: 2, phase: 'waiting-model', retention: { completedTurns: 25 }, compactionRequests: 2,
  lastRequest: { requestId: 'actual-step-7', purpose: 'reply', measuredAt: at, phase: 'finished', model: 'actual-model', window: 1000000, windowSource: 'metadata', inputTokensUpperBound: 24000, estimateMethod: 'utf8-byte-upper-bound', reservedOutputTokens: 8192, framingReserveTokens: 256, remainingTokensLowerBound: 967552, messageCount: 14, toolDefinitionCount: 8, reportedUsage: { inputTokens: 7300, outputTokens: 400 } } });

it('keeps only five ordered room tasks, shows real start/submission times and opens task center for overflow', async () => {
  const value = props(), tasks: BotTask[] = Array.from({ length: 1000 }, (_, index) => ({ id: `task-${index}`, conversationId: 'room', companionId: companions[0]!.id, title: `任务 ${index}`, goal: 'PRIVATE LONG GOAL MUST STAY HIDDEN', status: 'queued', createdAt: `2026-11-04T04:${String(index % 60).padStart(2, '0')}:00.000Z` }));
  tasks[0] = { ...tasks[0]!, status: 'running', createdAt: '2026-11-04T03:50:00.000Z', startedAt: at, progress: { phase: 'using-tool', toolName: 'shell' } };
  tasks[1] = { ...tasks[1]!, companionId: companions[1]!.id, createdAt: '2026-11-04T03:59:00.000Z' };
  value.tasks = [...tasks, { ...tasks[0]!, id: 'private', conversationId: 'elsewhere', title: '秘密私聊任务' }];
  await mount(value);
  expect(host.querySelectorAll('.bot-context-task')).toHaveLength(5);
  expect(host.querySelector('.bot-context-task strong')?.textContent).toBe('任务 0');
  expect(host.querySelector('.bot-context-task time')?.getAttribute('datetime')).toBe(at);
  expect(host.querySelector('.bot-context-task time')?.textContent).toContain('开始');
  expect(host.querySelectorAll('.bot-context-task time')[1]?.textContent).toContain('提交');
  expect([...host.querySelectorAll('.bot-context-task-owner>span:last-child')].slice(0, 2).map(owner => owner.textContent)).toEqual(['大肥鱼', 'GPT']);
  expect(host.textContent).toContain('本群全部伙伴的任务');
  expect(host.textContent).not.toContain('PRIVATE'); expect(host.textContent).not.toContain('秘密私聊任务');
  expect(host.textContent).toContain('还有 995 项');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-context-more-tasks')!.click()); expect(value.onTask).toHaveBeenCalledWith();
});

it('retains the real owner name for a former group member without borrowing another companion identity', async () => {
  const value = props(); value.tasks = [{ id: 'former-owner-task', conversationId: 'room', companionId: 'former-member', companionName: '以前的伙伴', goal: '', title: '尚未结束的旧任务', status: 'paused' }];
  await mount(value);
  expect(host.querySelector('.bot-context-task-owner')?.getAttribute('title')).toBe('负责伙伴：以前的伙伴');
  expect(host.querySelector('.bot-context-task-owner>span:last-child')?.textContent).toBe('以前的伙伴');
});

it('uses backend exact task totals even when current chat snapshot contains only old completed rows', async () => {
  const value = props(); value.tasks = [{ id: 'old', conversationId: 'room', companionId: 'person-0', goal: '', status: 'succeeded' }];
  value.taskSummary = { activeCount: 57, queuedCount: 52, items: Array.from({ length: 5 }, (_, index) => ({ id: `active-${index}`, conversationId: 'room', companionId: 'person-0', goal: '', title: `进行中 ${index}`, status: 'running' })) };
  await mount(value); expect(host.textContent).toContain('共 57 项未结束 · 待办 52 项'); expect(host.textContent).toContain('还有 52 项'); expect(host.querySelectorAll('.bot-context-task')).toHaveLength(5);
  expect(host.querySelector('.bot-context-task time')?.textContent).toBe('时间未记录');
});

it('shows last-request upper bound, separate provider input and real inbox/compaction counters without pretending cumulative use is occupancy', async () => {
  const value = props(); value.brainContexts = { 'person-0': { ...context(), agent: { id: 'stable-companion-actor', sequence: 71, continuity: 'durable-event-driven' } } }; await mount(value);
  const meter = host.querySelector('[role="meter"]')!;
  expect(meter.getAttribute('aria-valuenow')).toBe('24000'); expect(meter.getAttribute('aria-valuemax')).toBe('1000000');
  expect(host.textContent).toContain('最近请求上下文'); expect(host.textContent).toContain('保守估计'); expect(host.textContent).toContain('模型报告输入');
  expect(host.textContent).toContain('等待模型响应'); expect(host.textContent).toContain('2 条待处理'); expect(host.textContent).toContain('已处理轮次25'); expect(host.textContent).toContain('整理尝试2 次');
  expect(host.textContent).toContain('统一主脑 · 当前聊天视图'); expect(host.textContent).toContain('主脑累计事件71'); expect(host.textContent).toContain('这里仅展示本聊天获准的上下文');
  expect(host.textContent).not.toContain('stable-companion-actor');
  expect(host.textContent).not.toContain('留住每一次相遇');
});

it('selects one group member context at a time and excludes a context from another room', async () => {
  const value = props(); value.brainContexts = { 'person-0': { ...context(), conversationId: 'other-private' }, 'person-1': { ...context('person-1'), queuedMessages: 0, runningMessages: 0, lastRequest: { ...context().lastRequest!, inputTokensUpperBound: 55000 } } };
  await mount(value); expect(host.querySelector('[role="meter"]')).toBeNull(); expect(host.textContent).toContain('尚无本轮上下文用量记录');
  await act(() => { const select = host.querySelector<HTMLSelectElement>('select')!; select.value = 'person-1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('55000'); expect(host.querySelectorAll('.bot-context-capacity')).toHaveLength(1);
});

it('does not invent zero tokens and renders only three events from this room', async () => {
  const value = props(); value.presence = { 'person-0': { status: 'idle', counts: { activeTasks: 0, queued: 0, running: 0, waiting: 0, stopping: 0, blocked: 0, replying: 0, pendingMessages: 0 }, updatedAt: at, events: Array.from({ length: 8 }, (_, index) => ({ id: `event-${index}`, sequence: index, kind: 'task-completed', taskId: `t-${index}`, conversationId: index === 7 ? 'private' : 'room', title: index === 7 ? '私密事件' : `任务事件${index}`, status: 'succeeded', occurredAt: at })) } };
  await mount(value); expect(host.querySelector('[role="meter"]')).toBeNull(); expect(host.querySelectorAll('.bot-context-events li')).toHaveLength(3); expect(host.textContent).not.toContain('私密事件'); expect(host.textContent).toContain('任务事件6'); expect(host.textContent).not.toContain('任务事件0');
});
