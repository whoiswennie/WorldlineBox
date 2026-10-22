// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionActivityPanel } from '../../src/renderer/companions/CompanionActivityPanel';
import type { CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { ScheduleRequest } from '../../src/renderer/companions/companion-schedules';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); });
const task = (id: string, status: CompanionActivityTask['status'], owner = 'alice', room = 'private-alice'): CompanionActivityTask => ({ id, companionId: owner, conversationId: room, title: '前往白幻的小屋，确认邀请后再完成拜访并记录真实经历', goal: '真实拜访', status, step: 2, attempts: 1, stage: '等待房主实际许可后继续。', createdAt: '2026-10-22T01:00:00Z', updatedAt: '2026-10-22T01:02:00Z', deadline: '2026-10-23T00:00:00Z', history: [] });
async function mount(request: ScheduleRequest) { node = document.createElement('div'); document.body.append(node); root = createRoot(node); await act(async () => root!.render(<CompanionActivityPanel companionId="alice" conversationId="private-alice" request={request} />)); }

it('shows finished actions as recent records and excludes other companions and conversations', async () => {
  await mount(vi.fn(async () => ({ ok: true, activityTasks: [task('a', 'succeeded'), task('b', 'running', 'bob'), task('c', 'running', 'alice', 'other')] })));
  expect(node!.textContent).toContain('最近的行动记录'); expect(node!.textContent).not.toContain('等待结果后自动继续');
  expect(node!.querySelectorAll('details')).toHaveLength(1); expect(node!.querySelector('[data-status]')?.textContent).toBe('已完成');
  expect(node!.querySelector('time')?.dateTime).toBe('2026-10-22T01:02:00Z');
});

it('prioritizes current actions over finished records and cancels only the selected owner task', async () => {
  const current = task('pending', 'waiting'); current.wait = { kind: 'permission', targetCompanionId: 'bob' };
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'activity.cancel' ? { ok: true, activityTask: { ...current, status: 'cancelled' } } : { ok: true, activityTasks: [task('done', 'succeeded'), current] });
  await mount(request); expect(node!.querySelector('details')?.getAttribute('data-activity-task')).toBe('pending');
  expect(node!.querySelector('[data-status="waiting"]')?.textContent).toBe('等待房主许可');
  await act(async () => [...node!.querySelectorAll('button')].find(button => button.textContent === '取消后续行动')!.click());
  expect(request).toHaveBeenLastCalledWith({ type: 'activity.cancel', companionId: 'alice', conversationId: 'private-alice', id: 'pending' });
  expect(node!.querySelector('[data-status="cancelled"]')).not.toBeNull();
});

it('locates an exact older activity task from the overview without confusing it with action history', async () => {
  const located = task('older-activity', 'succeeded'); located.title = '刚从生活总览点击的拜访';
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'activity.get' ? { ok: true, activityTask: located }
    : { ok: true, activityTasks: [task('newer-activity', 'running')] });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionActivityPanel companionId="alice" conversationId="private-alice" request={request} initialTaskId={located.id} />));
  expect(request).toHaveBeenCalledWith({ type: 'activity.get', companionId: 'alice', conversationId: 'private-alice', id: located.id });
  expect(request.mock.calls.some(([command]) => command.type === 'action.get')).toBe(false);
  expect(node.querySelector<HTMLDetailsElement>('details')?.open).toBe(true);
  expect(node.querySelector('details')?.getAttribute('data-activity-task')).toBe(located.id);
});
