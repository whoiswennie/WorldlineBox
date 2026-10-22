// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionMemoryLifePlan as LifePlan, CompanionMemoryLifePlanItem } from '../../src/shared/companion-life-plan';
import { CompanionMemoryLifePlan } from '../../src/renderer/companions/CompanionMemoryLifePlan';
import type { ScheduleRequest } from '../../src/renderer/companions/companion-schedules';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-22T01:09:00Z';
function item(patch: Partial<CompanionMemoryLifePlanItem>): CompanionMemoryLifePlanItem {
  return { id: 'journal', kind: 'journal', title: '日记整理', state: 'idle', timing: { kind: 'event_driven', clock: 'real' }, reason: '有正式交流与真实经历后检查，并非每天固定写日记。', ...patch };
}
const plan: LifePlan = { companionId: 'alice', checkedAt: at, hasMore: false, items: [
  item({}),
  item({ id: 'learning-none', kind: 'learning', title: '资料学习', state: 'unconfigured', timing: { kind: 'conditional', clock: 'real' }, reason: '尚未授权学习来源，不会自行读取资产库。' }),
  item({ id: 'sleep', kind: 'sleep_consolidation', title: '睡眠记忆整合', state: 'scheduled', timing: { kind: 'window', clock: 'world', timeZone: 'Asia/Shanghai', windowStart: '2026-10-22T15:00:00Z', windowEnd: '2026-10-22T23:00:00Z' }, reason: '真正入睡且存在可整合记忆后检查。' }),
  item({ id: 'dream', kind: 'dream', title: '梦境', state: 'waiting', probability: .6, timing: { kind: 'conditional', clock: 'world', timeZone: 'Asia/Shanghai', at: '2026-10-22T20:00:00Z' }, reason: '冷却结束后，在睡眠候选中再判断概率；本次不保证产生梦境。' }),
] };
async function mount(request: ScheduleRequest, extra: { active?: boolean } = {}) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionMemoryLifePlan companionId="alice" request={request} {...extra} />));
}

it('separates real source-triggered journals, unauthorized learning, sleep windows and probabilistic dreams', async () => {
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryLifePlan: plan }));
  await mount(request);
  expect(request).toHaveBeenCalledWith({ type: 'memory.life-plan.status', companionId: 'alice' });
  const learning = node!.querySelector('[data-memory-plan-kind="learning"]')!;
  expect(learning.textContent).toContain('未安排'); expect(learning.textContent).toContain('不会自行读取资产库'); expect(learning.querySelector('time')).toBeNull();
  const journal = node!.querySelector('[data-memory-plan-kind="journal"]')!;
  expect(journal.textContent).toContain('事件触发'); expect(journal.textContent).toContain('现实时间'); expect(journal.textContent).toContain('并非每天固定写日记');
  const sleep = node!.querySelector('[data-memory-plan-kind="sleep_consolidation"]')!;
  expect(sleep.textContent).toContain('可整理窗口'); expect(sleep.textContent).toContain('世界时间');
  expect(sleep.querySelector('time')?.textContent).toContain('23:00');
  const dream = node!.querySelector('[data-memory-plan-kind="dream"]')!;
  expect(dream.textContent).toContain('60%'); expect(dream.textContent).toContain('冷却至'); expect(dream.textContent).toContain('不保证产生梦境');
  expect(dream.textContent).not.toContain('下次检查'); expect(dream.textContent).not.toContain('待执行');
});

it('shows a future learning check as a real-time eligibility point and expands additional authorized sources', async () => {
  const grants = Array.from({ length: 7 }, (_, index) => item({ id: 'learning-' + index, kind: 'learning', title: '阅读资料', sourceTitle: '用户授权书库 ' + index,
    state: index === 4 ? 'running' : 'scheduled', timing: { kind: 'eligibility', clock: 'real', at: `2026-10-22T0${index}:10:00Z` },
    reason: '检查时仍需伙伴空闲且聊天模型可用。' }));
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryLifePlan: { ...plan, items: grants } }));
  await mount(request);
  expect(node!.querySelectorAll('.companions-memory-life-plan > ul > li')).toHaveLength(4);
  expect(node!.querySelector('li')?.getAttribute('data-memory-plan-state')).toBe('running');
  const more = node!.querySelector<HTMLDetailsElement>('.memory-life-plan-more')!;
  expect(more.open).toBe(false); expect(more.querySelector('summary')?.textContent).toContain('其他 3 项安排');
  expect(node!.textContent).toContain('最早可检查'); expect(node!.textContent).not.toContain('下次检查'); expect(node!.textContent).toContain('现实时间');
  expect(node!.textContent).toContain('不承诺开始或完成时间'); expect(node!.textContent).not.toContain('预计完成');
});

it('distinguishes a registered check from eligibility and retry lower bounds', async () => {
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryLifePlan: { ...plan, items: [
    item({ id: 'timer', state: 'scheduled', timing: { kind: 'next_check', clock: 'real', at } }),
    item({ id: 'sleep', kind: 'sleep_consolidation', state: 'scheduled', timing: { kind: 'eligibility', clock: 'real', at } }),
    item({ id: 'retry', kind: 'learning', state: 'waiting', timing: { kind: 'retry', clock: 'real', at } }),
  ] } }));
  await mount(request);
  expect(node!.querySelector('[data-memory-plan-kind="journal"]')?.textContent).toContain('下次检查');
  expect(node!.querySelector('[data-memory-plan-kind="sleep_consolidation"]')?.textContent).toContain('最早可检查');
  expect(node!.querySelector('[data-memory-plan-kind="learning"]')?.textContent).toContain('最早可重试');
  expect(node!.textContent).not.toContain('下次执行');
});

it('never flashes another owner plan while the new owner is loading or an old request returns late', async () => {
  let finishBob!: (value: { ok: true; memoryLifePlan: LifePlan }) => void;
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.life-plan.status' && command.companionId === 'alice'
    ? { ok: true, memoryLifePlan: { ...plan, items: [item({ title: '小肥鱼独有的海边札记' })] } }
    : new Promise(resolve => { finishBob = resolve; }));
  await mount(request); expect(node!.textContent).toContain('小肥鱼独有的海边札记');
  await act(async () => root!.render(<CompanionMemoryLifePlan companionId="bob" request={request} />));
  expect(node!.textContent).not.toContain('小肥鱼独有的海边札记'); expect(node!.textContent).toContain('正在读取实际安排');
  await act(async () => finishBob({ ok: true, memoryLifePlan: { ...plan, companionId: 'bob', items: [item({ title: '大肥鱼自己的阅读安排' })] } }));
  expect(node!.textContent).toContain('大肥鱼自己的阅读安排'); expect(node!.textContent).not.toContain('小肥鱼独有的海边札记');
});

it('pauses all periodic reads while the chat pane is hidden and refreshes its actual plan on return', async () => {
  vi.useFakeTimers();
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryLifePlan: plan }));
  await mount(request); expect(request).toHaveBeenCalledOnce();
  await act(async () => root!.render(<CompanionMemoryLifePlan companionId="alice" request={request} active={false} />));
  await act(() => vi.advanceTimersByTimeAsync(90_000)); expect(request).toHaveBeenCalledOnce();
  await act(async () => root!.render(<CompanionMemoryLifePlan companionId="alice" request={request} active />));
  expect(request).toHaveBeenCalledTimes(2);
});
