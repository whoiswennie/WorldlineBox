// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionPlanner } from '../../src/renderer/companions/CompanionPlanner';
import { CompanionScheduleManager } from '../../src/renderer/companions/CompanionScheduleManager';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionAction, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionSchedule } from '../../src/shared/companion-schedule';
import type { CompanionRuntimeState } from '../../src/shared/companion-state';
import type { CompanionRoutine } from '../../src/shared/companion-routine';
import type { CompanionWorkOrder } from '../../src/shared/companion-work-order';
import { CompanionRoutineEditor } from '../../src/renderer/companions/CompanionRoutineEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); });
const at = '2026-10-14T08:00:00.000Z';
const companion: Companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at };
const schedule: CompanionSchedule = { id: 'plan', companionId: companion.id, conversationId: 'room', sourceMessageId: 'human-source', authorizationSourceMessageIds: ['human-source'], title: '一起整理相册', prompt: '整理电脑中的旅行照片，并写一份目录。', kind: 'task', runAt: '2026-10-15T10:00:00.000Z', timeZone: 'Asia/Shanghai', recurrence: 'weekly', weekDays: [4], flexible: true, status: 'active', revision: 4, createdAt: at, updatedAt: at, nextRunAt: '2026-10-15T10:00:00.000Z', blockedReason: 'resting', deferredUntil: '2026-10-15T11:00:00.000Z' };
const runtime: CompanionRuntimeState = { companionId: companion.id, energy: 67, mood: 'bright', expression: 'playful', affect: { pleasure: .4, arousal: .2, dominance: .1 }, relationship: { affinity: 52, trust: 61, respect: 70 }, focus: '旅行相册', reason: '刚完成一起整理照片的任务。', familiarity: { stage: 'acquainted', interactionCount: 12, sharedEventCount: 2 }, updatedAt: at, revision: 5 };
const routine: CompanionRoutine = { companionId: companion.id, revision: 3, config: { timeZone: 'Asia/Shanghai', sleepAt: '23:00', wakeAt: '07:00', meals: [{ name: '晚餐', at: '19:00', durationMinutes: 30 }], habits: [{ id: 'reading', title: '睡前读书', at: '21:00', durationMinutes: 25, kind: 'study' }] }, createdAt: at, updatedAt: at, habitProgress: [{ id: 'reading', strength: 42, completedCount: 10, streak: 4 }], runtime: { phase: 'awake', canRespond: true, nextTransitionAt: '2026-10-14T11:00:00.000Z', simulation: true } };
type Request = (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
function fixture() { return vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'work-order.list' ? { ok: true, workOrderPage: { items: [], hasMore: false } } : input.type === 'schedule.list' ? { ok: true, schedules: [schedule], scheduleOccurrences: [] } : input.type === 'state.get' ? { ok: true, runtimeState: runtime } : input.type === 'routine.get' ? { ok: true, routine } : { ok: true }); }
async function mount(element: React.ReactNode) { vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => root!.render(element)); await advance(); }
async function advance() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
function button(label: string) { const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label); if (!found) throw new Error('Missing button ' + label); return found; }
async function click(label: string) { await act(async () => button(label).click()); }
async function fill(label: string, value: string) { const input = container!.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function choose(label: string, value: string) { const input = container!.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }); }

it('keeps detailed state out of the journal until opened and refreshes actual scoped state on backend changes', async () => {
  const base = fixture(); let current = runtime, changed: (() => void) | undefined;
  const request: Request = input => input.type === 'state.get' ? Promise.resolve({ ok: true, runtimeState: current }) : base(input);
  const api: WorldlineBoxCompanionsApi = { request: async input => (await request(input)) ?? { ok: false }, onChanged: listener => { changed = listener; return () => { changed = undefined; }; }, onReplyStream: () => () => undefined };
  const memory = vi.fn(), schedules = vi.fn(), profile = vi.fn();
  await mount(<CompanionPlanner companion={companion} members={[companion]} conversationId="room" actions={[]} request={request} api={api} onOwnerChange={vi.fn()} onClose={vi.fn()} onProfile={profile} onMemory={memory} onTasks={vi.fn()} onSchedules={schedules} onWork={vi.fn()} />);
  expect(container!.textContent).toContain('心情明亮'); expect(container!.textContent).toContain('旅行相册'); expect(container!.textContent).toContain('好感 52');
  expect(container!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('67');
  expect(container!.textContent).not.toContain('情绪维度'); expect(container!.textContent).not.toContain('共同记忆管理');
  expect(container!.textContent).toContain('伙伴正在休息，稍后处理');
  await click('查看当前伙伴状态详情'); expect(container!.textContent).toContain('12 次交流'); expect(container!.textContent).toContain('刚完成一起整理照片'); expect(container!.querySelectorAll('meter')).toHaveLength(6);
  await click('查看完整角色设定'); expect(profile).toHaveBeenCalledOnce();
  await click('关闭当前状态详情'); await click('管理共同记忆'); await click('管理伙伴日程'); expect(memory).toHaveBeenCalledOnce(); expect(schedules).toHaveBeenCalledOnce();
  current = { ...runtime, mood: 'tired', energy: 35, relationship: { ...runtime.relationship, affinity: 57 } }; await act(async () => changed!()); await advance();
  expect(container!.textContent).toContain('有点疲惫'); expect(container!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('35');
  expect(container!.textContent).toContain('好感 57'); expect(container!.textContent).not.toContain('好感 52');
  expect(base).toHaveBeenCalledWith({ type: 'schedule.list', companionId: companion.id, conversationId: 'room', includeHistory: true, limit: 100 });
});

it('does not display the previous companion mood, focus or schedule under a newly selected companion name', async () => {
  let finish: ((result: CompanionsResponse) => void) | undefined;
  const base = fixture(), other = { ...companion, id: 'other-companion', name: '另一个伙伴' };
  const request: Request = input => input.type === 'state.get' && input.companionId === other.id ? new Promise(resolve => { finish = resolve; }) : base(input);
  const props = { members: [companion, other], conversationId: 'room', actions: [], request, onOwnerChange: vi.fn(), onClose: vi.fn(), onProfile: vi.fn(), onMemory: vi.fn(), onTasks: vi.fn(), onSchedules: vi.fn(), onWork: vi.fn() };
  await mount(<CompanionPlanner companion={companion} {...props} />); expect(container!.textContent).toContain('旅行相册');
  await act(async () => root!.render(<CompanionPlanner companion={other} {...props} />)); await advance();
  expect(container!.textContent).toContain('另一个伙伴的日常'); expect(container!.textContent).not.toContain('旅行相册'); expect(container!.textContent).not.toContain('心情明亮'); expect(container!.textContent).not.toContain('一起整理相册');
  await act(async () => finish!({ ok: true, runtimeState: runtime }));
  expect(container!.textContent).not.toContain('旅行相册'); expect(container!.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
});

it('preserves revision and timing when editing, clears repeat-only fields, and distinguishes pause from cancellation', async () => {
  const request = fixture(); await mount(<CompanionScheduleManager companion={companion} conversationId="room" request={request} onClose={vi.fn()} onDismissError={vi.fn()} />);
  await click('编辑'); await fill('安排标题', '整理照片与笔记'); await choose('安排重复', 'daily'); await click('保存安排修改');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.update', companionId: companion.id, conversationId: 'room', id: schedule.id, expectedRevision: 4, patch: expect.objectContaining({ title: '整理照片与笔记', runAt: schedule.runAt, timeZone: 'Asia/Shanghai', recurrence: 'daily', intervalMinutes: null, weekDays: null, flexible: true }) }));
  await click('暂停'); expect(request).toHaveBeenCalledWith({ type: 'schedule.pause', companionId: companion.id, conversationId: 'room', id: schedule.id, expectedRevision: 4, paused: true });
  await click('取消安排'); expect(container!.textContent).toContain('取消后停止后续安排及正在进行的任务，已产生的结果保留。');
  expect(request.mock.calls.some(([input]) => input.type === 'schedule.cancel')).toBe(false);
  await click('确认取消安排'); expect(request).toHaveBeenCalledWith({ type: 'schedule.cancel', companionId: companion.id, conversationId: 'room', id: schedule.id, expectedRevision: 4 });
});

it('summarizes all concurrent work in two compact rows and opens the correct scoped work or history view', async () => {
  const actions: CompanionAction[] = Array.from({ length: 20 }, (_, index) => ({ id: 'work' + index, companionId: companion.id, conversationId: 'room', sourceMessageId: 'source', title: '独立任务' + index, status: index < 12 ? 'running' : 'queued', createdAt: at, updatedAt: at }));
  const tasks = vi.fn(), open = vi.fn();
  const orders: CompanionWorkOrder[] = actions.map(action => ({ id: action.id, companionId: companion.id, publisherId: 'user', conversationId: 'room', sourceMessageId: 'source', authorizationSourceMessageIds: ['source'], title: action.title, instruction: '完整的任务目标', execution: 'external', status: action.status === 'running' ? 'running' : 'accepted', revision: 1, actionId: action.id, createdAt: at, worldCreatedAt: at, updatedAt: at }));
  const base = fixture(), request: Request = input => input.type === 'work-order.list' ? Promise.resolve({ ok: true, workOrderPage: { items: orders, hasMore: false } }) : base(input);
  await mount(<CompanionPlanner companion={companion} members={[companion]} conversationId="room" actions={actions} request={request} onOwnerChange={vi.fn()} onClose={vi.fn()} onProfile={vi.fn()} onMemory={vi.fn()} onTasks={tasks} onSchedules={vi.fn()} onWork={open} />);
  expect(container!.querySelector('[aria-label="工作数量"]')!.textContent).toBe('12进行中8待处理0已暂停');
  expect(container!.querySelectorAll('[data-work-preview]')).toHaveLength(2);
  expect(container!.textContent).toContain('另有 18 件');
  expect(container!.textContent).toContain('正在照看 20 件事');
  expect(container!.querySelector('.companions-planner-agenda')!.textContent).not.toContain('独立任务');
  await act(async () => container!.querySelector<HTMLButtonElement>('[data-work-preview="work0"]')!.click());
  expect(open).toHaveBeenCalledWith('work0');
  await click('查看全部伙伴工作'); expect(open).toHaveBeenLastCalledWith();
  await click('查看任务历史'); expect(tasks).toHaveBeenLastCalledWith('history', companion.id);
});

it('retains an unsuccessful creation with the same idempotency key for retry and submits full content', async () => {
  const base = fixture(), attempts: CompanionsRequest[] = [];
  const request: Request = input => { if (input.type !== 'schedule.create') return base(input); attempts.push(input); return Promise.resolve(attempts.length === 1 ? undefined : { ok: true }); };
  await mount(<CompanionScheduleManager companion={companion} conversationId="room" request={request} onClose={vi.fn()} onDismissError={vi.fn()} />);
  await click('添加安排'); await fill('安排标题', '喝水'); await fill('安排内容', '稍后提醒我喝一杯温水，今天工作很忙。'); await fill('首次执行时间', '2030-10-14T18:00:15'); await click('保存安排');
  expect(container!.textContent).toContain('安排未保存'); expect(container!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('稍后提醒我喝一杯温水，今天工作很忙。');
  await click('保存安排'); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]).toMatchObject({ type: 'schedule.create', companionId: companion.id, conversationId: 'room', clientId: expect.any(String), entries: [expect.objectContaining({ title: '喝水', prompt: '稍后提醒我喝一杯温水，今天工作很忙。', kind: 'reminder', recurrence: 'once', flexible: false })] });
});

it('edits actual routine configuration with its revision and keeps learning progress read-only', async () => {
  const request = fixture(); await mount(<CompanionRoutineEditor companionId={companion.id} conversationId="room" request={request} />);
  expect(request).toHaveBeenCalledWith({ type: 'routine.get', companionId: companion.id, conversationId: 'room' });
  expect(container!.textContent).toContain('养成程度 42% · 连续 4 次'); expect(container!.textContent).toContain('已按虚拟作息完成 10 次');
  expect(container!.querySelector('[aria-label="养成程度"]')).toBeNull();
  await fill('伙伴睡觉时间', '22:30'); await fill('习惯 1 名称', '读二十分钟喜欢的书'); await click('保存作息与习惯');
  expect(request).toHaveBeenCalledWith({ type: 'routine.configure', companionId: companion.id, conversationId: 'room', expectedRevision: 3, patch: { ...routine.config, sleepAt: '22:30', habits: [{ ...routine.config.habits[0], title: '读二十分钟喜欢的书' }] } });
  const payload = request.mock.calls.find(([input]) => input.type === 'routine.configure')![0]; expect(payload).not.toHaveProperty('strength'); expect(payload).not.toHaveProperty('habitProgress');
});

it('keeps group routine viewing read-only and sends no configuration mutation', async () => {
  const request = fixture(); await mount(<CompanionScheduleManager companion={companion} conversationId="room" conversationKind="group" request={request} onClose={vi.fn()} onDismissError={vi.fn()} />);
  await click('作息与习惯'); await advance();
  expect(container!.textContent).toContain('在伙伴私聊中调整作息与习惯');
  expect(container!.querySelector('[aria-label="伙伴睡觉时间"]')).toBeNull();
  expect([...container!.querySelectorAll('button')].some(item => item.textContent === '保存作息与习惯')).toBe(false);
  expect(request.mock.calls.some(([input]) => input.type === 'routine.configure')).toBe(false);
});
