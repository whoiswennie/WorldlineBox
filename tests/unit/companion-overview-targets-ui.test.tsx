// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionScheduleManager } from '../../src/renderer/companions/CompanionScheduleManager';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion } from '../../src/shared/companions';
import type { CompanionSchedule } from '../../src/shared/companion-schedule';
import type { ScheduleRequest } from '../../src/renderer/companions/companion-schedules';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); });
const at = '2026-10-22T01:09:00.000Z', companion: Companion = { ...BUILTIN_COMPANIONS[0]!, createdAt: at, builtin: true };
const target: CompanionSchedule = { id: 'precise-schedule', companionId: companion.id, conversationId: 'actual-room', sourceMessageId: 'authorized', authorizationSourceMessageIds: ['authorized'],
  title: '只编辑刚点击的这条约定', prompt: '保留这个安排的内容。', kind: 'reminder', runAt: '2026-12-23T03:00:00.000Z', timeZone: 'Asia/Shanghai', recurrence: 'once', flexible: false,
  status: 'active', revision: 4, createdAt: at, updatedAt: at };
async function mount(request: ScheduleRequest, initialScheduleId = target.id) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionScheduleManager companion={companion} conversationId="actual-room" request={request} onClose={vi.fn()} onDismissError={vi.fn()} initialScheduleId={initialScheduleId} />));
}

it('opens the exact owner schedule from the feed and saves using its own revision and conversation', async () => {
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'schedule.get' ? { ok: true, schedule: target, scheduleOccurrences: [] }
    : command.type === 'schedule.list' ? { ok: true, schedules: Array.from({ length: 100 }, (_, index) => ({ ...target, id: 'later-' + index, title: '更远的第 ' + index + ' 条便签' })), scheduleOccurrences: [] } : { ok: true });
  await mount(request);
  expect(request).toHaveBeenCalledWith({ type: 'schedule.get', companionId: companion.id, conversationId: 'actual-room', id: target.id });
  expect(node!.querySelector('[data-schedule-id="precise-schedule"]')).not.toBeNull();
  expect(node!.querySelectorAll('[data-schedule-id]')).toHaveLength(101);
  expect(node!.querySelector<HTMLInputElement>('[aria-label="安排标题"]')?.value).toBe(target.title);
  await act(async () => [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '保存安排修改')!.click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.update', id: target.id, companionId: companion.id, conversationId: 'actual-room', expectedRevision: 4 }));
});

it('reports a missing or differently owned target without silently editing another schedule', async () => {
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'schedule.get' ? { ok: true, schedule: { ...target, companionId: 'another-owner' } }
    : { ok: true, schedules: [{ ...target, id: 'unrelated' }], scheduleOccurrences: [] });
  await mount(request);
  expect(node!.textContent).toContain('不再属于当前伙伴'); expect(node!.querySelector('[aria-label="安排标题"]')).toBeNull();
  expect(request.mock.calls.some(([command]) => command.type === 'schedule.update')).toBe(false);
});

it('retries an exact read on explicit refresh instead of silently choosing a row from the ordinary page', async () => {
  let reads = 0;
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'schedule.get' ? ++reads === 1 ? { ok: false, error: '暂时无法读取' } : { ok: true, schedule: target }
    : { ok: true, schedules: [{ ...target, id: 'unrelated', title: '无关的安排' }], scheduleOccurrences: [] });
  await mount(request); expect(node!.querySelector('[aria-label="安排标题"]')).toBeNull();
  expect(node!.textContent).toContain('不再属于当前伙伴');
  await act(async () => [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '刷新')!.click());
  expect(reads).toBe(2); expect(node!.querySelector<HTMLInputElement>('[aria-label="安排标题"]')?.value).toBe(target.title);
});

it('retains a new unsaved editor if an older exact navigation request fails late', async () => {
  let finish!: (value: { ok: false; error: string }) => void;
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'schedule.get' ? new Promise(resolve => { finish = resolve; }) : { ok: true, schedules: [], scheduleOccurrences: [] });
  await mount(request);
  await act(() => [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '添加安排')!.click());
  const title = node!.querySelector<HTMLInputElement>('[aria-label="安排标题"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, '仍需保留的未保存安排'); title.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => finish({ ok: false, error: '目标暂时不可读' }));
  expect(node!.querySelector<HTMLInputElement>('[aria-label="安排标题"]')).toBe(title); expect(title.value).toBe('仍需保留的未保存安排');
  expect(node!.textContent).toContain('不再属于当前伙伴'); expect(request.mock.calls.some(([command]) => command.type === 'schedule.update')).toBe(false);
});

it('keeps the exact off-page target current after a scoped pause and uses the returned revision on resume', async () => {
  let current = target;
  const request = vi.fn<ScheduleRequest>(async command => {
    if (command.type === 'schedule.get') return { ok: true, schedule: current };
    if (command.type === 'schedule.pause') { current = { ...current, status: command.paused ? 'paused' : 'active', revision: current.revision + 1 }; return { ok: true, schedule: current }; }
    return { ok: true, schedules: Array.from({ length: 100 }, (_, index) => ({ ...target, id: 'later-' + index })), scheduleOccurrences: [] };
  });
  await mount(request);
  const targetRow = () => node!.querySelector('[data-schedule-id="precise-schedule"]')!;
  await act(async () => [...targetRow().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '暂停')!.click());
  expect(targetRow().textContent).toContain('已暂停');
  await act(async () => [...targetRow().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '恢复安排')!.click());
  expect(request).toHaveBeenCalledWith({ type: 'schedule.pause', companionId: companion.id, conversationId: 'actual-room', id: target.id, expectedRevision: 5, paused: false });
});
