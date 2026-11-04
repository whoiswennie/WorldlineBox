// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { BotCompanionPresence, BotCompanionPresenceEvent, BotConversation } from '../../src/shared/companion-bot';
import { BotAvatar } from '../../src/renderer/companion-bot/BotAvatar';
import { BotPeerAvatar } from '../../src/renderer/companion-bot/BotPeerAvatar';
import { BotPresenceSummary, botPresenceLabel, useBotTaskUpdates } from '../../src/renderer/companion-bot/BotPresence';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement, eventSequence = 0;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
const companions = [{ id: 'fish', name: '大肥鱼', persona: '', createdAt: '2026-11-04T05:00:00Z' }, { id: 'gpt', name: 'GPT', persona: '', createdAt: '2026-11-04T05:00:00Z' }];
const state = (patch: Partial<BotCompanionPresence> = {}): BotCompanionPresence => ({ status: 'idle', updatedAt: '2026-11-04T05:00:00Z', counts: { activeTasks: 0, queued: 0, running: 0, waiting: 0, stopping: 0, blocked: 0, replying: 0, pendingMessages: 0 }, ...patch });
const event = (id: string, kind: BotCompanionPresenceEvent['kind']): BotCompanionPresenceEvent => ({ id, sequence: ++eventSequence, kind, taskId: 'task-1', title: '整理目录', conversationId: 'elsewhere', status: kind === 'task-completed' ? 'succeeded' : 'running', occurredAt: '2026-11-04T05:00:00Z' });
async function mount(element: ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(() => root!.render(element)); }
const room = (id: string, patch: Partial<BotConversation> = {}): BotConversation => ({ id, title: id, kind: 'direct', memberIds: ['user', 'fish'], createdAt: '2026-11-04T05:00:00Z', ...patch });
const rooms = [room('elsewhere'), room('other')];
function Updates(props: Parameters<typeof useBotTaskUpdates>[0]) {
  const updates = useBotTaskUpdates(props);
  return <section>{['elsewhere', 'other', 'peer', 'private-world'].map(id => <output key={id} data-room-updates={id}>{updates.count(id)}</output>)}</section>;
}
const count = (id = 'elsewhere') => Number(host.querySelector(`[data-room-updates="${id}"]`)?.textContent);
const renderUpdates = (events: BotCompanionPresenceEvent[], patch: Partial<Parameters<typeof useBotTaskUpdates>[0]> = {}) => <Updates presence={{ fish: state({ events }) }} conversations={rooms} {...patch} />;

it('uses the actual single-person status while group portraits share one frame without overlapping dots', async () => {
  const busy = state({ status: 'working' });
  await mount(<><BotAvatar companion={companions[0]} presence={busy} /><BotPeerAvatar companions={companions} presence={{ fish: busy, gpt: state({ status: 'replying' }) }} /></>);
  expect([...host.querySelectorAll('.bot-presence-dot')].map(dot => dot.getAttribute('data-presence'))).toEqual(['working']);
  expect(host.querySelector('.bot-avatar')?.classList.contains('has-presence')).toBe(true);
  expect(host.querySelectorAll('.bot-group-collage>.bot-group-portrait')).toHaveLength(2);
  expect(host.querySelectorAll('.bot-group-collage .bot-presence-dot')).toHaveLength(0);
  expect([...host.querySelectorAll<HTMLElement>('.bot-group-portrait')].map(tile => tile.dataset.companionId)).toEqual(['fish', 'gpt']);
});

it('aggregates accurate nonterminal task totals and navigates to the real activity room', async () => {
  const first = state({ status: 'working', counts: { ...state().counts, activeTasks: 3, running: 2, stopping: 1 }, activity: { taskId: 'original', conversationId: 'other-room', title: '任务', phase: 'using-tool', updatedAt: '2026-11-04T05:00:00Z' } });
  const second = state({ status: 'replying', counts: { ...state().counts, activeTasks: 2, waiting: 1, queued: 1 } }), open = vi.fn();
  await mount(<BotPresenceSummary companions={companions} presence={{ fish: first, gpt: second }} locale="zh-CN" onOpen={open} />);
  expect(host.textContent).toContain('正在停止 · 1 项');
  await act(() => host.querySelector<HTMLButtonElement>('button')!.click()); expect(open).toHaveBeenCalledWith('other-room', 'original');
  expect(botPresenceLabel({ ...first, counts: { ...first.counts, stopping: 0, activeTasks: 3 } }, 'zh-CN')).toBe('执行任务 · 3 项任务');
});

it.each([4, 9, 14])('bounds a %i-member collage to the first nine real portraits without replacing a member with a count', async count => {
  const members = BUILTIN_BOT_COMPANIONS.slice(0, count).map(person => ({ ...person, createdAt: '2026-11-04T05:00:00Z' }));
  expect(members).toHaveLength(count);
  await mount(<BotPeerAvatar companions={members} />);
  const tiles = [...host.querySelectorAll<HTMLElement>('.bot-group-portrait')];
  expect(tiles.map(tile => tile.dataset.companionId)).toEqual(members.slice(0, 9).map(person => person.id));
  expect(host.querySelectorAll('img')).toHaveLength(Math.min(count, 9));
  expect(host.querySelectorAll('.bot-presence-dot, .bot-avatar, .bot-group-portrait-overflow')).toHaveLength(0);
});

it('expires a recent failure indicator without permanently marking the companion unavailable', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T05:00:00Z'));
  await mount(<BotAvatar companion={companions[0]} presence={state({ status: 'error', expiresAt: '2026-11-04T05:00:01Z' })} />);
  expect(host.querySelector('.bot-presence-dot')?.getAttribute('data-presence')).toBe('error');
  await act(() => vi.advanceTimersByTime(1100));
  expect(host.querySelector('.bot-presence-dot')?.getAttribute('data-presence')).toBe('idle');
});

it('counts only post-baseline distinct tasks without floating feedback, automatic expiry or duplicate stable events', async () => {
  vi.useFakeTimers(); const old = event('old', 'task-started');
  await mount(renderUpdates([old])); expect(count()).toBe(0);
  const completed = event('completed', 'task-completed');
  await act(() => root!.render(renderUpdates([old, completed]))); expect(count()).toBe(1);
  await act(() => root!.render(renderUpdates([old, completed]))); expect(count()).toBe(1);
  const anotherStage = event('another-stage', 'task-needs-attention');
  await act(() => root!.render(renderUpdates([completed, anotherStage]))); expect(count()).toBe(1);
  const issue = { ...event('issue', 'task-needs-attention'), taskId: 'task-2' };
  await act(() => root!.render(renderUpdates([completed, issue]))); expect(count()).toBe(2);
  await act(() => vi.advanceTimersByTime(9100)); expect(count()).toBe(2);
  expect(host.querySelector('.bot-presence-feedback, [role="alert"], [role="status"], button, .bot-transcript')).toBeNull();
});

it('bounds parallel updates to the latest 128 observed tasks rather than mounting notification cards', async () => {
  await mount(renderUpdates([]));
  for (let batch = 0; batch < 18; batch++) {
    const events = Array.from({ length: 8 }, (_, index) => ({ ...event(`batch-${batch}-${index}`, 'task-completed'), taskId: `task-${batch}-${index}` }));
    await act(() => root!.render(renderUpdates(events)));
    expect(count()).toBe(Math.min((batch + 1) * 8, 128));
  }
  expect(host.querySelector('[role="progressbar"], .bot-presence-feedback')).toBeNull();
  await act(() => root!.render(renderUpdates([], { readConversationId: 'elsewhere' }))); expect(count()).toBe(0);
});

it('distinguishes queued, paused, waiting for input and blocked stop without inferring progress from counts', () => {
  expect(botPresenceLabel(state({ status: 'waiting', counts: { ...state().counts, activeTasks: 1, waiting: 1 } }), 'zh-CN')).toBe('等待处理 · 1 项任务');
  expect(botPresenceLabel(state({ status: 'working', counts: { ...state().counts, activeTasks: 3, queued: 3 } }), 'zh-CN')).toBe('任务排队 · 3 项任务');
  expect(botPresenceLabel(state({ status: 'waiting', counts: { ...state().counts, activeTasks: 2, paused: 2 } }), 'zh-CN')).toBe('已暂停 · 2 项任务');
  expect(botPresenceLabel(state({ status: 'needs-attention', counts: { ...state().counts, activeTasks: 1, blocked: 1, stopping: 0 }, activity: { taskId: 't', conversationId: 'r', title: '短任务', phase: 'stop-unconfirmed', updatedAt: '2026-11-04T05:00:00Z' } }), 'zh-CN')).toBe('停止待核实 · 1 项任务');
});

it('distinguishes same-millisecond historical backfill from a genuine new transition using the SQL sequence', async () => {
  const initial = Array.from({ length: 8 }, (_, index) => ({ ...event(`old-${index}`, 'task-completed'), sequence: 20 - index, taskId: `task-${index}`, occurredAt: '2026-11-04T05:00:10Z' }));
  await mount(renderUpdates(initial));
  const backfill = { ...event('older-ninth', 'task-completed'), sequence: 12, taskId: 'older-task', occurredAt: '2026-11-04T05:00:10Z' };
  await act(() => root!.render(renderUpdates([...initial.slice(1), backfill]))); expect(count()).toBe(0);
  const actualNew = { ...event('new-transition', 'task-started'), sequence: 21, taskId: 'new-task', occurredAt: '2026-11-04T05:00:10Z' };
  await act(() => root!.render(renderUpdates([actualNew, ...initial.slice(1, 7), backfill]))); expect(count()).toBe(1);
});

it('acknowledges only the visible task room and never resurrects read updates after closing it', async () => {
  await mount(renderUpdates([]));
  const a = event('room-a', 'task-completed'), b = { ...event('room-b', 'task-failed'), taskId: 'b', conversationId: 'other' };
  await act(() => root!.render(renderUpdates([a, b]))); expect([count(), count('other')]).toEqual([1, 1]);
  await act(() => root!.render(renderUpdates([a, b], { readConversationId: 'elsewhere' }))); expect([count(), count('other')]).toEqual([0, 1]);
  await act(() => root!.render(renderUpdates([a, b]))); expect([count(), count('other')]).toEqual([0, 1]);
  const incomingRead = { ...event('while-reading', 'task-completed'), taskId: 'read-task' };
  await act(() => root!.render(renderUpdates([a, b, incomingRead], { readConversationId: 'elsewhere' })));
  await act(() => root!.render(renderUpdates([a, b, incomingRead]))); expect([count(), count('other')]).toEqual([0, 1]);
  const afterClose = { ...event('after-close', 'task-started'), taskId: 'new-task' };
  await act(() => root!.render(renderUpdates([b, afterClose]))); expect([count(), count('other')]).toEqual([1, 1]);
  await act(() => root!.render(renderUpdates([b, afterClose], { readConversationId: 'other' }))); expect([count(), count('other')]).toEqual([1, 0]);
});

it('does not let an older deferred publish undo a committed read followed immediately by closing the panel', async () => {
  await mount(renderUpdates([]));
  const completed = event('read-before-publish', 'task-completed');
  await act(() => {
    flushSync(() => root!.render(renderUpdates([completed])));
    flushSync(() => root!.render(renderUpdates([completed], { readConversationId: 'elsewhere' })));
    flushSync(() => root!.render(renderUpdates([completed])));
  });
  expect(count()).toBe(0);
  await act(() => root!.render(renderUpdates([completed]))); expect(count()).toBe(0);
});

it('drops removed or revoked rooms and ignores peer observation, dissolved groups and nonmember worlds', async () => {
  const inaccessible = [room('peer', { kind: 'peer', memberIds: ['fish', 'gpt'], userRole: 'observer' }), room('private-world', { kind: 'world', memberIds: ['fish'] }), room('dissolved', { kind: 'group', dissolvedAt: '2026-11-04T05:00:00Z' })];
  const conversations = [...rooms, ...inaccessible];
  await mount(renderUpdates([], { conversations }));
  const a = event('visible', 'task-started');
  const events = [a, ...inaccessible.map(item => ({ ...event(item.id, 'task-completed'), taskId: item.id, conversationId: item.id })), { ...event('unknown', 'task-completed'), conversationId: 'unknown' }];
  await act(() => root!.render(renderUpdates(events, { conversations }))); expect([count(), count('peer'), count('private-world')]).toEqual([1, 0, 0]);
  await act(() => root!.render(renderUpdates(events, { conversations: [rooms[1]!] }))); expect(count()).toBe(0);
  await act(() => root!.render(renderUpdates(events, { conversations }))); expect(count()).toBe(0);
  const revoked = rooms.map(item => item.id === 'elsewhere' ? { ...item, memberIds: ['fish'] } : item);
  const next = { ...event('after-revoke', 'task-completed'), taskId: 'new' };
  await act(() => root!.render(renderUpdates([next], { conversations: revoked }))); expect(count()).toBe(0);
});

it('baselines a newly observed companion and deduplicates one task reported through multiple companion snapshots', async () => {
  await mount(<Updates conversations={rooms} />);
  const old = event('first-presence', 'task-completed');
  await act(() => root!.render(renderUpdates([old]))); expect(count()).toBe(0);
  const gptOld = event('gpt-baseline', 'task-started');
  await act(() => root!.render(renderUpdates([old], { presence: { fish: state({ events: [old] }), gpt: state({ events: [gptOld] }) } }))); expect(count()).toBe(0);
  const shared = { ...event('one-shared-task', 'task-completed'), taskId: 'shared' };
  await act(() => root!.render(renderUpdates([], { presence: { fish: state({ events: [shared] }), gpt: state({ events: [shared] }) } }))); expect(count()).toBe(1);
});

it('keeps the legacy timestamp fallback bounded by the baseline and stable event identities', async () => {
  const old = { ...event('legacy-initial', 'task-started'), sequence: 0, occurredAt: '2026-11-04T05:00:10Z' };
  await mount(renderUpdates([old]));
  const historical = { ...event('legacy-historical', 'task-completed'), sequence: 0, occurredAt: '2026-11-04T05:00:09Z', taskId: 'older-task' };
  await act(() => root!.render(renderUpdates([historical]))); expect(count()).toBe(0);
  const sameTime = { ...event('legacy-same-ms', 'task-completed'), sequence: 0, occurredAt: old.occurredAt, taskId: 'same-time' };
  await act(() => root!.render(renderUpdates([sameTime]))); expect(count()).toBe(1);
  await act(() => root!.render(renderUpdates([sameTime]))); expect(count()).toBe(1);
});
