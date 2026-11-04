// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotWorldScene } from '../../src/renderer/companion-bot/BotWorldScene';
import { LocaleProvider } from '../../src/renderer/i18n';
import { createWorldHome, createWorldPark } from '../../src/shared/world-physics';
import type { BotWorldSnapshot } from '../../src/shared/companion-bot-world';
import type { BotRequest, BotResponse, WorldlineBoxBotApi } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement, requests: BotRequest[], value: BotWorldSnapshot;
let override: ((request: BotRequest) => Promise<BotResponse> | undefined) | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); requests = []; override = undefined;
  value = { revision: 1, observedAt: '2026-11-02T10:00:00Z', companionId: 'alice', scenes: [createWorldPark(), createWorldHome('alice')], events: [], actors: [
    { companionId: 'alice', name: 'Alice', sceneId: 'home_alice', homeSceneId: 'home_alice', position: { x: 10, y: 15 }, facing: 'north', frame: 0, activity: 'idle', movementSpeed: 2.4, route: [] },
  ] };
});
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function mount() {
  const api: WorldlineBoxBotApi = { async request(request) { requests.push(request); return override?.(request) ?? { ok: true, world: value }; }, onEvent() { return () => undefined; } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><BotWorldScene api={api} conversationId="world-a" companionId="alice" /></LocaleProvider>));
}
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  expect(button).toBeDefined(); await act(() => button.click());
}
it('renders the real physical footprint and actor coordinates through the new world API', async () => {
  await mount(); expect(requests[0]).toEqual({ type: 'world.observe', conversationId: 'world-a', companionId: 'alice' });
  expect(host.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 20 16');
  expect(host.querySelector('[data-world-actor="alice"]')?.getAttribute('data-world-y')).toBe('15');
  expect(host.querySelectorAll('.bot-world-object').length).toBe(9); expect(host.textContent).toContain('位置（10.0, 15.0）');
});
it('submits furniture interactions with stable audience and observed revision', async () => {
  await mount(); const select = host.querySelector<HTMLSelectElement>('[aria-label="场景物件"]')!;
  await act(() => { select.value = 'alice_chair'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('坐下');
  expect(requests.find(request => request.type === 'world.act')).toMatchObject({ type: 'world.act', companionId: 'alice', conversationId: 'world-a',
    command: { operation: 'interact', objectId: 'alice_chair', action: 'sit', expectedRevision: 1 }, effectId: expect.any(String) });
});
it('maps a click through SVG letterboxing to the correct world tile', async () => {
  await mount(); const map = host.querySelector('svg')!;
  vi.spyOn(map, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 160, right: 400, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
  await act(() => map.dispatchEvent(new MouseEvent('click', { clientX: 155, clientY: 75, bubbles: true })));
  expect(requests.find(request => request.type === 'world.act')).toMatchObject({ command: { operation: 'move', sceneId: 'home_alice', x: 5, y: 7 } });
});
it('keeps a newer action snapshot when an earlier observation resolves late', async () => {
  await mount(); let resolve!: (response: BotResponse) => void;
  const old = new Promise<BotResponse>(done => { resolve = done; });
  override = request => request.type === 'world.observe' ? old : undefined;
  await click('刷新观察');
  value = { ...value, revision: 2, observedAt: '2026-11-02T10:00:01Z', actors: [{ ...value.actors[0]!, activity: 'working' }] };
  await click('站起来');
  expect(host.querySelector('.bot-world-position')?.textContent).toContain('在电脑前');
  await act(() => resolve({ ok: true, world: { ...value, revision: 1, actors: [{ ...value.actors[0]!, activity: 'idle' }] } }));
  expect(host.querySelector('.bot-world-position')?.textContent).toContain('在电脑前');
});
it('stops observation polling when the world view unmounts', async () => {
  await mount(); await act(() => vi.advanceTimersByTime(1000)); expect(requests.filter(request => request.type === 'world.observe')).toHaveLength(2);
  await act(() => root!.unmount()); root = undefined; await act(() => vi.advanceTimersByTime(5000));
  expect(requests.filter(request => request.type === 'world.observe')).toHaveLength(2);
});
