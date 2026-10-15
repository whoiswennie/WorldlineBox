import { expect, it } from 'vitest';
import type { CompanionAction } from '../../src/shared/companions';
import { companionWorkOverview, companionWorkPhase } from '../../src/renderer/companions/companion-work-overview';

function action(id: string, patch: Partial<CompanionAction> = {}): CompanionAction {
  return { id, conversationId: 'room', companionId: 'one', sourceMessageId: 'source', title: '工作 ' + id, status: 'running', createdAt: '2026-10-15T01:00:00Z', updatedAt: '2026-10-15T01:00:00Z', ...patch };
}
it('counts concurrent work independently and bounds preview without replacing an older active task with the latest', () => {
  const tasks = Array.from({ length: 40 }, (_, index) => action('task_' + index, { createdAt: new Date(Date.UTC(2026, 9, 15, 1, index)).toISOString(), status: index < 30 ? 'running' : 'queued' }));
  const overview = companionWorkOverview([...tasks].reverse());
  expect(overview.counts).toEqual({ running: 30, queued: 10, confirmation: 0, interrupted: 0 });
  expect(overview.total).toBe(40); expect(overview.preview.map(item => item.action.id)).toEqual(['task_0', 'task_1']);
});
it('prioritizes explicit confirmation, preserves actual owner scope and excludes completed or intentionally stopped work', () => {
  const event = { sequence: 1, type: 'waiting_approval', summary: '等待操作确认', receivedAt: '2026-10-15T01:00:00Z' };
  const overview = companionWorkOverview([action('normal'), action('approval', { events: [event] }), action('other', { companionId: 'two' }), action('done', { status: 'succeeded' }), action('stopped', { status: 'cancelled', canResume: true }), action('resume', { status: 'interrupted', canResume: true })], 'one');
  expect(overview.preview.map(item => item.action.id)).toEqual(['approval', 'normal']);
  expect(overview.counts).toEqual({ running: 1, queued: 0, confirmation: 1, interrupted: 1 });
  expect(companionWorkPhase(action('prose', { stage: '用户说等待确认', events: [{ ...event, type: 'message' }] }))).toBe('running');
});
