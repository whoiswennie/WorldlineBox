// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionWorldStatus } from '../../src/renderer/companions/CompanionWorldStatus';
import type { Companion, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorldStatus as Status } from '../../src/shared/companion-world';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); root = undefined; container?.remove(); vi.useRealTimers(); });
const members: Companion[] = [{ id: 'fish', name: '小肥鱼', persona: '活泼', description: '', model: '', avatar: 'flash', builtin: true, proactive: true, active: true, createdAt: '2026-10-20T00:00:00Z' }];
const sister: Companion = { ...members[0]!, id: 'sister', name: '大肥鱼', avatar: 'sister', active: false };
function status(): Status { return { clock: { realNow: '2026-10-20T00:00:00Z', virtualNow: '2098-04-10T10:00:00Z', timeZone: 'UTC', mode: 'compressed', speed: 72, backlog: false }, contacts: [{ companionId: 'fish', state: 'available' }], interactions: [{ companionId: 'fish', conversationId: 'peers', recipientIds: ['sister'], phase: 'waiting', channel: 'phone', recipients: [{ companionId: 'sister', state: 'dormant' }] }] }; }
async function mount(value = status()) {
  vi.useFakeTimers(); vi.setSystemTime('2035-01-01T00:00:00Z');
  const api: WorldlineBoxCompanionsApi = { request: vi.fn(async () => ({ ok: true, worldStatus: value })), onChanged: vi.fn(() => () => undefined), onReplyStream: () => () => undefined };
  const observe = vi.fn(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(() => root!.render(<CompanionWorldStatus api={api} members={members} companions={[...members, sister]} active onObserve={observe} />));
  return { api, observe };
}
it('shows the simulation date and speed instead of wall time and opens the actual interacting companion conversation', async () => {
  const f = await mount();
  expect(container!.querySelector('time')?.dateTime).toBe('2098-04-10T10:00:00.000Z');
  expect(container!.textContent).toContain('大肥鱼 · 等待');
  expect(container!.querySelector('button')?.title).toContain('等待大肥鱼回复'); expect(container!.querySelector('button')?.title).toContain('已休眠，等待玩家激活');
  await act(() => container!.querySelector('button')!.click()); expect(f.observe).toHaveBeenCalledWith('fish', 'peers');
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(container!.querySelector('time')?.dateTime).toBe('2098-04-10T10:01:12.000Z');
  expect(f.api.request).toHaveBeenCalledWith({ type: 'world.status', companionIds: ['fish'] });
  expect(f.api.onChanged).not.toHaveBeenCalled();
});
it('holds the materialized world time while catching up and stops polling after unmount', async () => {
  const value = status(); value.clock.backlog = true; const f = await mount(value);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(container!.querySelector('time')?.dateTime).toBe('2098-04-10T10:00:00.000Z');
  await act(() => { root!.unmount(); root = undefined; }); const calls = vi.mocked(f.api.request).mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(5000)); expect(f.api.request).toHaveBeenCalledTimes(calls);
});
it('keeps virtual time and the authoritative world weather together in a compact header', async () => {
  const value = status(); value.environment = { weather: 'cloudy', light: .6, outdoorTemperature: 21.3, indoorTemperature: 21.2 };
  await mount(value);
  expect(container!.querySelector('time')?.dateTime).toBe('2098-04-10T10:00:00.000Z');
  const weather = container!.querySelector('[aria-label="虚拟世界天气"]')!;
  expect(weather.textContent).toBe('☁多云21.3°C'); expect(weather.textContent).not.toContain('☀');
  expect(weather.closest('.companions-world-clock')?.contains(container!.querySelector('time'))).toBe(true);
});
