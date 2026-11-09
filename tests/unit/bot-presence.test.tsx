// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { BotCompanionPresence } from '../../src/shared/companion-bot';
import { BotAvatar } from '../../src/renderer/companion-bot/BotAvatar';
import { BotPeerAvatar } from '../../src/renderer/companion-bot/BotPeerAvatar';
import { BotPresenceSummary, botPresenceLabel } from '../../src/renderer/companion-bot/BotPresence';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
const companions = [{ id: 'fish', name: '大肥鱼', persona: '', createdAt: '2026-11-04T05:00:00Z' }, { id: 'gpt', name: 'GPT', persona: '', createdAt: '2026-11-04T05:00:00Z' }];
const state = (patch: Partial<BotCompanionPresence> = {}): BotCompanionPresence => ({ status: 'idle', updatedAt: '2026-11-04T05:00:00Z', counts: { activeTasks: 0, queued: 0, running: 0, waiting: 0, stopping: 0, blocked: 0, replying: 0, pendingMessages: 0 }, ...patch });
async function mount(element: ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(() => root!.render(element)); }
it('uses the actual single-person status while group portraits share one frame without overlapping dots', async () => {
  const busy = state({ status: 'working' });
  await mount(<><BotAvatar companion={companions[0]} presence={busy} /><BotPeerAvatar companions={companions} presence={{ fish: busy, gpt: state({ status: 'replying' }) }} /></>);
  expect([...host.querySelectorAll('.bot-presence-dot')].map(dot => dot.getAttribute('data-presence'))).toEqual(['working']);
  expect(host.querySelector('.bot-avatar')?.classList.contains('has-presence')).toBe(true);
  expect(host.querySelectorAll('.bot-group-collage>.bot-group-portrait')).toHaveLength(2);
  expect(host.querySelectorAll('.bot-group-collage .bot-presence-dot')).toHaveLength(0);
  expect([...host.querySelectorAll<HTMLElement>('.bot-group-portrait')].map(tile => tile.dataset.companionId)).toEqual(['fish', 'gpt']);
});

it('overrides stale active presence for disabled companions and excludes them from group activity', async () => {
  const disabled = { ...companions[0]!, enabled: false }, busy = state({ status: 'working', counts: { ...state().counts, activeTasks: 5, running: 5 } });
  await mount(<><BotAvatar companion={disabled} presence={busy} /><BotPresenceSummary companions={[disabled]} presence={{ fish: busy }} locale="zh-CN" /><BotPresenceSummary companions={[disabled, companions[1]!]} presence={{ fish: busy, gpt: state() }} locale="zh-CN" /></>);
  expect(host.querySelector('.bot-presence-dot')?.getAttribute('data-presence')).toBe('disabled');
  expect(host.textContent).toContain('已关闭');
  expect(host.querySelector('.bot-presence-summary')?.textContent).toBe('待命');
  expect(host.textContent).not.toContain('5 项任务');
});

it('shows session presence as status text without a removed task-center navigation', async () => {
  const first = state({ status: 'working' });
  await mount(<BotPresenceSummary companions={companions} presence={{ fish: first, gpt: state({ status: 'replying' }) }} locale="zh-CN" />);
  expect(host.textContent).toContain('执行任务');
  expect(host.querySelector('button')).toBeNull();
  expect(botPresenceLabel(first, 'zh-CN')).toBe('执行任务');
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
