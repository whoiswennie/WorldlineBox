// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionPlanner } from '../../src/renderer/companions/CompanionPlanner';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionRuntimeState } from '../../src/shared/companion-state';
import type { CompanionRoutine } from '../../src/shared/companion-routine';
import { companionAgendaRuleSchema } from '../../src/shared/companion-agenda';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); });
const at = '2026-10-14T08:00:00.000Z';
const companion: Companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at };
const plannedAt = '2026-10-15T10:00:00.000Z';
const runtime: CompanionRuntimeState = { schema: 'companion-runtime-qualitative-v1', companionId: companion.id, energy: 67, expression: 'playful', relationshipRecords: [], focus: '旅行相册', reason: '刚完成一起整理照片的任务。', updatedAt: at, revision: 5 };
const routine: CompanionRoutine = { companionId: companion.id, revision: 3, config: { timeZone: 'Asia/Shanghai', sleepAt: '23:00', wakeAt: '07:00', meals: [{ name: '晚餐', at: '19:00', durationMinutes: 30 }], habits: [{ id: 'reading', title: '睡前读书', at: '21:00', durationMinutes: 25, kind: 'study' }] }, createdAt: at, updatedAt: at, habitProgress: [{ id: 'reading', strength: 42, completedCount: 10, streak: 4 }], runtime: { phase: 'awake', canRespond: true, nextTransitionAt: '2026-10-14T11:00:00.000Z', simulation: true } };
type Request = (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
const agendaRule = companionAgendaRuleSchema.parse({ id: 'plan', companionId: companion.id, revision: 1, title: '一起整理相册', intent: '核对照片目录。', kind: 'work', executor: 'brain', trigger: { kind: 'at', at: plannedAt, timeZone: 'Asia/Shanghai' }, reason: '延续实际约定。', origin: 'user', status: 'active', createdAt: at, updatedAt: at, nextAt: plannedAt });
function fixture() { return vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'agenda.read' ? { ok: true, agenda: { companionId: input.companionId, rules: [agendaRule], occurrences: [], runs: [], goals: [], grants: [], hasMore: false, observedAt: at, revision: 1 } } : input.type === 'state.get' ? { ok: true, runtimeState: runtime } : input.type === 'routine.get' ? { ok: true, routine } : { ok: true }); }
async function mount(element: React.ReactNode) { vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => root!.render(element)); await advance(); }
async function advance() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
function button(label: string) { const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label); if (!found) throw new Error('Missing button ' + label); return found; }
async function click(label: string) { await act(async () => button(label).click()); }

it('keeps detailed state out of the journal until opened and refreshes actual scoped state on backend changes', async () => {
  const base = fixture(); let current = runtime, changed: (() => void) | undefined;
  const request: Request = input => input.type === 'state.get' ? Promise.resolve({ ok: true, runtimeState: current }) : base(input);
  const api: WorldlineBoxCompanionsApi = { request: async input => (await request(input)) ?? { ok: false }, onChanged: listener => { changed = listener; return () => { changed = undefined; }; }, onReplyStream: () => () => undefined };
  const memory = vi.fn(), schedules = vi.fn(), profile = vi.fn();
  await mount(<CompanionPlanner companion={companion} members={[companion]} conversationId="room" actions={[]} request={request} api={api} onOwnerChange={vi.fn()} onClose={vi.fn()} onProfile={profile} onMemory={memory} onSchedules={schedules} />);
  expect(container!.textContent).toContain('近期处境与关注'); expect(container!.textContent).toContain('旅行相册'); expect(container!.textContent).not.toContain('好感 52');
  expect(container!.querySelector('[role="progressbar"]')).toBeNull();
  expect(container!.textContent).not.toContain('情绪维度'); expect(container!.textContent).not.toContain('共同记忆管理');
  expect(container!.textContent).toContain('一起整理相册');
  await click('查看当前伙伴状态详情'); expect(container!.textContent).not.toContain('12 次交流'); expect(container!.textContent).toContain('刚完成一起整理照片'); expect(container!.querySelectorAll('meter')).toHaveLength(0);
  await click('查看完整角色设定'); expect(profile).toHaveBeenCalledOnce();
  await click('关闭当前状态详情'); await click('管理共同记忆'); await click('查看日程'); expect(memory).toHaveBeenCalledOnce(); expect(schedules).toHaveBeenCalledOnce();
  current = { ...runtime, energy: 35, reason: '刚结束整理，想先安静片刻。' }; await act(async () => changed!()); await advance();
  expect(container!.textContent).not.toContain('有点疲惫'); expect(container!.querySelector('[role="progressbar"]')).toBeNull();
  expect(container!.textContent).not.toContain('好感 57'); expect(container!.textContent).not.toContain('好感 52');
  expect(base).toHaveBeenCalledWith({ type: 'agenda.read', companionId: companion.id, limit: 50 });
  expect(base.mock.calls.some(([input]) => input.type === 'schedule.list' || input.type === 'work-order.list' || input.type === 'memory.processing.status')).toBe(false);
});

it('does not display the previous companion mood, focus or schedule under a newly selected companion name', async () => {
  let finish: ((result: CompanionsResponse) => void) | undefined;
  const base = fixture(), other = { ...companion, id: 'other-companion', name: '另一个伙伴' };
  const request: Request = input => input.type === 'state.get' && input.companionId === other.id ? new Promise(resolve => { finish = resolve; }) : base(input);
  const props = { members: [companion, other], conversationId: 'room', actions: [], request, onOwnerChange: vi.fn(), onClose: vi.fn(), onProfile: vi.fn(), onMemory: vi.fn(), onSchedules: vi.fn(), onWork: vi.fn() };
  await mount(<CompanionPlanner companion={companion} {...props} />); expect(container!.textContent).toContain('旅行相册');
  await act(async () => root!.render(<CompanionPlanner companion={other} {...props} />)); await advance();
  expect(container!.textContent).toContain('另一个伙伴的日常'); expect(container!.textContent).not.toContain('旅行相册'); expect(container!.textContent).not.toContain('心情明亮'); expect(container!.textContent).not.toContain('一起整理相册');
  await act(async () => finish!({ ok: true, runtimeState: runtime }));
  expect(container!.textContent).not.toContain('旅行相册'); expect(container!.querySelector('[role="progressbar"]')).toBeNull();
});

it('distinguishes manual dormancy from an active companion whose body is asleep', async () => {
  const base = fixture(), request: Request = input => input.type === 'routine.get' ? Promise.resolve({ ok: true, routine: { ...routine, runtime: { ...routine.runtime, phase: 'sleeping', activity: '正在睡觉', canRespond: false } } }) : base(input);
  const props = { members: [companion], conversationId: 'room', actions: [], request, onOwnerChange: vi.fn(), onClose: vi.fn(), onProfile: vi.fn(), onMemory: vi.fn(), onSchedules: vi.fn(), onWork: vi.fn() };
  await mount(<CompanionPlanner companion={{ ...companion, active: false }} {...props} />);
  expect(container!.querySelector('.companions-planner-routine-current')?.textContent).toContain('正在睡觉激活后可交流');
  await act(async () => root!.render(<CompanionPlanner companion={{ ...companion, active: true }} {...props} />));
  expect(container!.querySelector('.companions-planner-routine-current')?.textContent).toContain('正在睡觉可以交流');
  expect(container!.textContent).not.toContain('休息后回复'); expect(container!.textContent).not.toContain('激活后可交流');
});

it('summarizes one owner agenda without separate work or memory queues and forwards the selected event', async () => {
  const request = fixture(), schedules = vi.fn();
  await mount(<CompanionPlanner companion={companion} members={[companion]} conversationId="room" actions={[]} request={request} onOwnerChange={vi.fn()} onClose={vi.fn()} onProfile={vi.fn()} onMemory={vi.fn()} onSchedules={schedules} />);
  expect(container!.querySelector('[aria-label="伙伴日程摘要"]')).not.toBeNull();
  expect(container!.querySelector('[aria-label="工作数量"]')).toBeNull();
  expect(container!.textContent).not.toContain('工作台');
  await act(() => container!.querySelector<HTMLButtonElement>('.agenda-sidebar-entry')!.click());
  expect(schedules).toHaveBeenCalledWith(agendaRule.id);
  expect(request.mock.calls.some(([input]) => input.type === 'work-order.list' || input.type === 'schedule.list' || input.type === 'memory.processing.status')).toBe(false);
});
