// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotWorldScene } from '../../src/renderer/companion-bot/BotWorldScene';
import { LocaleProvider } from '../../src/renderer/i18n';
import { createWorldHome } from '../../src/shared/world-physics';
import type { BotWorldSnapshot } from '../../src/shared/companion-bot-world';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';

const viewport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/renderer/companion-bot/world-3d', () => ({ createBotWorldViewport: viewport.create }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); viewport.create.mockReset(); });
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });

async function mount() {
  const world: BotWorldSnapshot = { revision: 1, observedAt: '2026-11-02T10:00:00Z', companionId: 'alice', scenes: [createWorldHome('alice')], events: [], actors: [
    { companionId: 'alice', name: 'Alice', sceneId: 'home_alice', homeSceneId: 'home_alice', position: { x: 10, y: 15 }, facing: 'north', frame: 0, activity: 'idle', movementSpeed: 2.4, route: [] },
  ] };
  const api: WorldlineBoxBotApi = { async request() { return { ok: true, world }; }, onEvent() { return () => undefined; } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><BotWorldScene api={api} conversationId="world-a" companionId="alice" /></LocaleProvider>));
  const switch3d = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '三维场景')!;
  await act(() => switch3d.click());
}

it('returns to the usable physical position map when WebGL cannot initialize', async () => {
  viewport.create.mockImplementation(() => { throw new Error('WebGL unavailable'); });
  await mount();
  await vi.waitFor(() => expect(host.querySelector('svg.bot-world-map')).not.toBeNull());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('三维场景暂不可用，已返回位置图。');
  expect(host.querySelector('[data-world-actor="alice"]')?.getAttribute('data-world-y')).toBe('15');
});

it('disposes an interrupted renderer and preserves the authoritative position map', async () => {
  let contextLost!: (message: string) => void;
  const dispose = vi.fn();
  viewport.create.mockImplementation((_container: HTMLElement, fail: (message: string) => void) => {
    contextLost = fail; return { update: vi.fn(), setActive: vi.fn(), dispose };
  });
  await mount();
  await vi.waitFor(() => expect(viewport.create).toHaveBeenCalledOnce());
  await act(() => contextLost('3D图形上下文已中断。'));
  expect(dispose).toHaveBeenCalledOnce();
  expect(host.querySelector('svg.bot-world-map')).not.toBeNull();
  expect(host.querySelector('[data-world-actor="alice"]')?.getAttribute('data-world-x')).toBe('10');
});
