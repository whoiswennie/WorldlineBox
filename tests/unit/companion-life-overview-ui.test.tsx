// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionLifeOverview } from '../../src/renderer/companions/CompanionLifeOverview';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion } from '../../src/shared/companions';
import type { CompanionLifeOverview as Overview, CompanionLifeOverviewItem } from '../../src/shared/companion-life-overview';
import type { ScheduleRequest } from '../../src/renderer/companions/companion-schedules';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-22T01:09:00.000Z';
const companions: Companion[] = BUILTIN_COMPANIONS.slice(0, 3).map((item, index) => ({ ...item, active: index !== 2, builtin: true, createdAt: at }));
const alice = companions[0]!, bob = companions[1]!;
function flow(id = 'schedule-a', patch: Partial<CompanionLifeOverviewItem> = {}): CompanionLifeOverviewItem {
  return { id, kind: 'schedule', title: '明晚一起读海边札记', status: 'active', section: 'upcoming', condition: '到计划时间后仍需伙伴与模型可用。',
    timing: { kind: 'scheduled', clock: 'real', at: '2026-10-23T12:00:00.000Z' }, destination: { kind: 'schedules', id, conversationId: 'private-alice' }, ...patch };
}
function overview(owner = alice.id, items = [flow()]): Overview {
  return { companionId: owner, companion: { id: owner, name: companions.find(item => item.id === owner)?.name ?? '', active: true }, checkedAt: at,
    clock: { realNow: at, observedRealAt: at, virtualNow: '2026-10-22T15:00:00.000Z', timeZone: 'Asia/Shanghai', speed: 72, mode: 'compressed', backlog: true },
    environment: { weather: 'rain', light: .2, outdoorTemperature: 14.4, indoorTemperature: 22.6 },
    current: { activity: 'sleeping', label: '正在小屋里休息', startedAtReal: at, routinePhase: 'sleeping' }, items, hasMore: false,
    memoryLifePlan: { companionId: owner, checkedAt: at, hasMore: false, items: [] } };
}
type Props = ComponentProps<typeof CompanionLifeOverview>;
async function mount(request: ScheduleRequest, patch: Partial<Props> = {}) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const props: Props = { companions, companionId: alice.id, active: true, request, onOwnerChange: vi.fn(), onOpen: vi.fn(), ...patch };
  await act(async () => root!.render(<CompanionLifeOverview {...props} />)); return props;
}
function button(label: string) { const found = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label); if (!found) throw new Error('Missing ' + label); return found; }

it('shows the persisted shared world clock and actual weather with one bounded owner read and no chat creation', async () => {
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, lifeOverview: overview() }));
  const props = await mount(request);
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'life.overview.status', companionId: alice.id, filter: 'all', limit: 20 });
  const environment = node!.querySelector('[aria-label="共享世界时间与天气"]')!;
  expect(environment.querySelector('time')?.dateTime).toBe('2026-10-22T15:00:00.000Z'); expect(environment.textContent).toContain('23:00');
  expect(environment.textContent).toContain('下雨'); expect(environment.textContent).toContain('室外 14°'); expect(environment.textContent).toContain('世界观测已落后，等待后台继续推进');
  expect(node!.textContent).toContain('正在小屋里休息'); expect(node!.querySelector('[aria-label="查看' + companions[2]!.name + '的生活"]')).toBeNull();
  await act(() => button('查看与调整').click()); expect(props.onOpen).toHaveBeenCalledWith('schedules', expect.objectContaining({ id: 'schedule-a' }));
});

it('replaces bounded pages and uses the backend filter instead of retaining every history entry', async () => {
  const request = vi.fn<ScheduleRequest>(async command => {
    if (command.type !== 'life.overview.status') return { ok: true };
    const offset = command.cursor ? 20 : 0;
    return { ok: true, lifeOverview: { ...overview(alice.id, Array.from({ length: 20 }, (_, index) => flow('item-' + (offset + index)))), hasMore: !offset, ...(offset ? {} : { nextCursor: 'second-page' }) } };
  });
  await mount(request); expect(node!.querySelectorAll('[data-life-item]')).toHaveLength(20);
  await act(async () => button('下一页').click());
  expect(request).toHaveBeenCalledWith({ type: 'life.overview.status', companionId: alice.id, filter: 'all', limit: 20, cursor: 'second-page' });
  expect(node!.querySelectorAll('[data-life-item]')).toHaveLength(20); expect(node!.querySelector('[data-life-item="item-0"]')).toBeNull();
  await act(async () => button('需关注').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'life.overview.status', companionId: alice.id, filter: 'attention', limit: 20 });
  expect(node!.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('需关注');
});

it('keeps an empty life feed as one compact icon-and-copy block and omits pointless single-page controls', async () => {
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, lifeOverview: overview(alice.id, []) }));
  await mount(request);
  const feed = node!.querySelector('.life-overview-feed')!, empty = feed.querySelector('[role="status"]')!;
  expect(empty.classList.contains('life-overview-empty')).toBe(true);
  expect(empty.querySelector('.life-overview-empty-symbol > svg')).not.toBeNull();
  expect(empty.querySelector('.life-overview-empty-copy h3')?.textContent).toBe('生活正在慢慢展开');
  expect(empty.querySelector('.life-overview-empty-copy p')?.textContent).toContain('新的安排与真实经历');
  expect(feed.querySelector('.life-overview-pagination')).toBeNull();
  expect(feed.textContent).not.toContain('第 1 页');
});

it('keeps back navigation available when a later page becomes empty', async () => {
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'life.overview.status' && command.cursor
    ? { ok: true, lifeOverview: overview(alice.id, []) }
    : { ok: true, lifeOverview: { ...overview(), hasMore: true, nextCursor: 'later-page' } });
  await mount(request); await act(async () => button('下一页').click());
  expect(node!.querySelectorAll('[data-life-item]')).toHaveLength(0);
  expect(button('上一页').disabled).toBe(false);
  await act(async () => button('上一页').click());
  expect(node!.querySelector('[data-life-item]')).not.toBeNull();
});

it('never displays the previous companion under a new identity or accepts another owner memory projection', async () => {
  let finishBob!: (value: { ok: true; lifeOverview: Overview }) => void;
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'life.overview.status' && command.companionId === bob.id
    ? new Promise(resolve => { finishBob = resolve; }) : { ok: true, lifeOverview: overview(alice.id, [flow('alice-only', { title: '小肥鱼独有的海边经历' })]) });
  const props = await mount(request); expect(node!.textContent).toContain('小肥鱼独有的海边经历');
  await act(async () => root!.render(<CompanionLifeOverview {...props} companionId={bob.id} />));
  expect(node!.textContent).not.toContain('小肥鱼独有的海边经历');
  await act(async () => finishBob({ ok: true, lifeOverview: { ...overview(bob.id), memoryLifePlan: { companionId: alice.id, checkedAt: at, items: [], hasMore: false } } }));
  expect(node!.textContent).toContain('暂时无法读取'); expect(node!.querySelector('[data-life-item]')).toBeNull();
});

it('stops periodic reads and subscriptions while hidden and resumes only the selected owner', async () => {
  vi.useFakeTimers();
  const off = vi.fn(), api = { onChanged: vi.fn(() => off) } as unknown as Props['api'];
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, lifeOverview: overview() }));
  const props = await mount(request, { api });
  await act(async () => root!.render(<CompanionLifeOverview {...props} active={false} />));
  await act(() => vi.advanceTimersByTimeAsync(60_000)); expect(request).toHaveBeenCalledOnce(); expect(off).toHaveBeenCalledOnce();
  expect(node!.querySelector<HTMLElement>('[aria-label="伙伴生活总览"]')?.hidden).toBe(true);
  await act(async () => root!.render(<CompanionLifeOverview {...props} />)); expect(request).toHaveBeenCalledTimes(2);
});

it('keeps probabilistic life windows distinct from a guaranteed task and exposes trace through an explicit owner action', async () => {
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, lifeOverview: overview(alice.id, [flow('rule-1', { kind: 'life_rule', title: '晚间问候', probability: .6,
    timing: { kind: 'window', clock: 'world', timeZone: 'Asia/Shanghai', windowStart: '2026-10-22T14:00:00.000Z', windowEnd: '2026-10-22T16:00:00.000Z' }, destination: { kind: 'life_rules', id: 'rule-1' } })]) }));
  const trace = vi.fn(); await mount(request, { onOpenTrace: trace });
  expect(node!.textContent).toContain('60% 候选概率'); expect(node!.textContent).toContain('可用窗口'); expect(node!.textContent).toContain('世界时间');
  expect(node!.textContent).not.toContain('下次执行'); expect(trace).not.toHaveBeenCalled();
  await act(() => button('成长足迹').click()); expect(trace).toHaveBeenCalledWith(alice.id);
});

it('does not mistake an expired persistent running lease for a live memory model task', async () => {
  const data = overview(); data.memoryProcessing = { companionId: alice.id, hasMore: false, summary: { pending: 0, running: 7, failed: 0, parked: 0, abandoned: 0, completed: 20, cancelled: 0 }, jobs: [
    { id: 'expired', kind: 'index', title: '海边札记的索引', status: 'running', attempts: 8, stage: '旧阶段：正在生成向量', schedule: {
      scheduleKind: 'manual', timeBasis: 'real', observedAt: at, waitingReason: 'lease_expired', condition: '上次整理已中断，需要手动恢复。', triggerRule: '核验后恢复。', explanation: '不是实时执行中。',
    } },
  ] };
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, lifeOverview: data })); await mount(request);
  const memory = node!.querySelector('[aria-label="当前伙伴记忆收录"]')!;
  expect(memory.textContent).toContain('7 项已领取'); expect(memory.textContent).toContain('需要手动恢复');
  expect(memory.textContent).not.toContain('7 项进行中'); expect(memory.textContent).not.toContain('旧阶段');
});

it('shows one representative condition per memory pipeline while retaining the full backend queue counts', async () => {
  const data = overview(); data.memoryProcessing = { companionId: alice.id, hasMore: true, summary: { pending: 900, running: 0, failed: 0, parked: 0, abandoned: 0, completed: 400, cancelled: 0 }, jobs: [
    ...[1, 2, 3].map(index => ({ id: 'capture-' + index, kind: 'capture' as const, status: 'pending' as const, title: '整理聊天与经历', attempts: 0, stage: '等待聊天模型可用' })),
    { id: 'index-1', kind: 'index', status: 'pending', title: '海边日记', attempts: 0, stage: '等待设备检测通过' },
    { id: 'index-2', kind: 'index', status: 'pending', title: '另一篇日记', attempts: 0, stage: '等待设备检测通过' },
  ] };
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, lifeOverview: data })); await mount(request);
  const memory = node!.querySelector('[aria-label="当前伙伴记忆收录"]')!;
  expect(memory.textContent).toContain('900 项等待整理');
  expect(memory.querySelectorAll('[data-life-memory-kind="capture"]')).toHaveLength(1);
  expect(memory.querySelectorAll('[data-life-memory-kind="index"]')).toHaveLength(1);
  expect(memory.textContent?.match(/等待聊天模型可用/gu)).toHaveLength(1);
  expect(memory.textContent?.match(/等待设备检测通过/gu)).toHaveLength(1);
});
