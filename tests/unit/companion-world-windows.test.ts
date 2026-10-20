import { afterEach, expect, it, vi } from 'vitest';
import { CompanionWorldWindowManager, type WorldObserverIpcEvent, type WorldObserverWindow, type WorldObserverWindowOptions } from '../../src/main/companions/world-windows';
import { COMPANION_WORLD_WINDOW_CHANNEL, COMPANION_WORLD_WINDOW_ARGUMENT, COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL, type CompanionWorldWindowResult } from '../../src/shared/companion-world-window';
import type { CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';

class FakeWindow implements WorldObserverWindow {
  destroyed = false; visible = false; minimized = false; maximized = false;
  listeners = new Map<string, Set<() => void>>();
  webContents = { mainFrame: {}, getURL: vi.fn(() => 'file:///app/index.html?window=companion-world'), send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() };
  setMenu = vi.fn<(menu: null) => void>();
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; } isMaximized() { return this.maximized; }
  on(name: string, callback: () => void) { const callbacks = this.listeners.get(name) ?? new Set(); callbacks.add(callback); this.listeners.set(name, callbacks); }
  emit(name: string) { for (const listener of this.listeners.get(name) ?? []) listener(); }
  show() { this.visible = true; this.minimized = false; this.emit('show'); } minimize() { this.minimized = true; this.emit('minimize'); }
  maximize() { this.maximized = true; } unmaximize() { this.maximized = false; }
  close() { this.destroyed = true; this.visible = false; this.emit('closed'); } destroy() { this.close(); }
}
const world = { scenes: [{ id: 'park', kind: 'park' }, { id: 'home_alice', kind: 'home' }], residents: [{ companionId: 'alice' }] };
function fixture() {
  const main = new FakeWindow(); main.show(); const created: Array<{ window: FakeWindow; options: WorldObserverWindowOptions }> = [];
  let handler: ((event: WorldObserverIpcEvent, input: unknown) => Promise<CompanionWorldWindowResult>) | undefined;
  const ipc = { handle: vi.fn((channel, callback) => { expect(channel).toBe(COMPANION_WORLD_WINDOW_CHANNEL); handler = callback; }), removeHandler: vi.fn() };
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'state'
    ? { ok: true, state: { companions: [{ id: 'alice', name: 'Alice', avatar: 'sister', persona: 'PRIVATE_PERSONA', llm: { apiKey: 'NOT_EXPOSED' } }] } } as unknown as CompanionsResponse
    : { ok: true, world } as unknown as CompanionsResponse);
  const load = vi.fn(async () => undefined), report = vi.fn();
  const manager = new CompanionWorldWindowManager({ ipc, getMainWindow: () => main, request, load, report, preload: '/index.js', createWindow: options => {
    const window = new FakeWindow(); created.push({ window, options }); return window;
  } }); manager.register();
  const invoke = (window: FakeWindow, input: unknown, frame = window.webContents.mainFrame) => handler!({ sender: window.webContents, senderFrame: frame }, input);
  return { manager, main, created, ipc, request, load, report, invoke };
}
afterEach(() => vi.useRealTimers());

it('opens a park camera only over the real public scene without creating another simulation', async () => {
  const f = fixture();
  expect((await f.invoke(f.main, { type: 'open', sceneId: 'home_alice', view: 'park' })).ok).toBe(false);
  expect((await f.invoke(f.main, { type: 'open', companionId: 'alice', view: 'park' })).ok).toBe(false);
  expect((await f.invoke(f.main, { type: 'open', sceneId: 'park' })).ok).toBe(true);
  const context = (await f.invoke(f.created[0]!.window, { type: 'context' })).context!;
  expect(context).toMatchObject({ sceneId: 'park' });
  expect(f.request.mock.calls.every(([request]) => ['world.snapshot', 'state'].includes(request.type))).toBe(true);
  f.manager.dispose();
});

it('opens independent native windows, scopes contacts and reuses the smallest released observer slot', async () => {
  const f = fixture();
  expect((await f.invoke(f.main, { type: 'open', sceneId: 'park' })).ok).toBe(true);
  await f.invoke(f.main, { type: 'open', companionId: 'alice' });
  const a = f.created[0]!, b = f.created[1]!;
  expect(a.options).toMatchObject({ frame: true, show: false, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: [COMPANION_WORLD_WINDOW_ARGUMENT] } });
  expect(a.window.setMenu).toHaveBeenCalledExactlyOnceWith(null); expect(b.window.setMenu).toHaveBeenCalledExactlyOnceWith(null);
  const ca = (await f.invoke(a.window, { type: 'context' })).context!, cb = (await f.invoke(b.window, { type: 'context' })).context!;
  expect(ca.observerKey).toBe('companion-world-observer'); expect(cb.observerKey).toBe('companion-world-observer-1');
  expect(ca.companions).toEqual([{ id: 'alice', name: 'Alice', avatar: 'sister' }]); expect(JSON.stringify(ca)).not.toContain('PRIVATE_PERSONA');
  expect(ca.visibleWindowCount).toBe(2);
  await f.invoke(a.window, { type: 'control', action: 'close' });
  expect(f.main.isDestroyed()).toBe(false); expect(b.window.isDestroyed()).toBe(false);
  await f.invoke(b.window, { type: 'open', sceneId: 'home_alice' });
  expect((await f.invoke(f.created[2]!.window, { type: 'context' })).context?.observerKey).toBe('companion-world-observer');
  f.manager.dispose(); expect(f.created.every(entry => entry.window.isDestroyed())).toBe(true); expect(f.main.isDestroyed()).toBe(false);
});

it('rejects foreign contents, subframes, invalid targets and every non-observer capability', async () => {
  const f = fixture();
  expect((await f.invoke(new FakeWindow(), { type: 'open' })).ok).toBe(false);
  expect((await f.invoke(f.main, { type: 'open' }, {})).ok).toBe(false);
  expect((await f.invoke(f.main, { type: 'open', sceneId: '../../secret' })).ok).toBe(false);
  expect((await f.invoke(f.main, { type: 'open', sceneId: 'missing' })).ok).toBe(false);
  expect((await f.invoke(f.main, { type: 'request', request: { type: 'world.snapshot' } })).ok).toBe(false);
  await f.invoke(f.main, { type: 'open' }); const observer = f.created[0]!.window;
  for (const type of ['message.send', 'action.run', 'state', 'memory.read', 'world.tool', 'world.tick']) {
    expect((await f.invoke(observer, { type: 'request', request: { type } })).ok).toBe(false);
  }
  expect(f.request.mock.calls.every(([request]) => request.type === 'world.snapshot')).toBe(true);
  expect((observer.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => unknown)()).toEqual({ action: 'deny' });
  const preventDefault = vi.fn(); (observer.webContents.on.mock.calls[0]![1] as (event: { preventDefault(): void }) => void)({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
  f.manager.dispose();
});

it('permits exact observer document reloads and rejects every different destination', async () => {
  const f = fixture(); await f.invoke(f.main, { type: 'open' }); const observer = f.created[0]!.window;
  const navigate = observer.webContents.on.mock.calls.find(([event]) => event === 'will-navigate')![1] as (event: { preventDefault(): void }, url: string) => void;
  const preventDefault = vi.fn(), current = observer.webContents.getURL();
  navigate({ preventDefault }, current); expect(preventDefault).not.toHaveBeenCalled();
  for (const url of ['https://example.com/', 'file:///app/index.html', current + '#other', current + '&scene=other', 'javascript:alert(1)']) navigate({ preventDefault }, url);
  expect(preventDefault).toHaveBeenCalledTimes(5); f.manager.dispose();
});

it('shares concurrent snapshots, expires the short cache and invalidates after configure', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000);
  const f = fixture(); await f.invoke(f.main, { type: 'open' }); const observer = f.created[0]!.window;
  await Promise.all(Array.from({ length: 5 }, () => f.invoke(observer, { type: 'request', request: { type: 'world.snapshot' } })));
  expect(f.request).toHaveBeenCalledTimes(1);
  vi.setSystemTime(1300); let resolve!: (value: CompanionsResponse) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const a = f.invoke(observer, { type: 'request', request: { type: 'world.snapshot' } });
  vi.setSystemTime(9000); const b = f.invoke(observer, { type: 'request', request: { type: 'world.snapshot' } });
  expect(f.request).toHaveBeenCalledTimes(2); resolve({ ok: true, world } as unknown as CompanionsResponse); await Promise.all([a, b]);
  await f.invoke(observer, { type: 'request', request: { type: 'world.configure', expectedRevision: 1, patch: { mode: 'realtime' } } });
  await f.invoke(observer, { type: 'request', request: { type: 'world.snapshot' } }); expect(f.request).toHaveBeenCalledTimes(4);
  f.manager.changed(); await f.invoke(observer, { type: 'request', request: { type: 'world.snapshot' } }); expect(f.request).toHaveBeenCalledTimes(5); f.manager.dispose();
});

it('broadcasts actual visibility budgets and never hides or minimizes a different window', async () => {
  const f = fixture(); await f.invoke(f.main, { type: 'open' }); await f.invoke(f.main, { type: 'open' });
  const a = f.created[0]!.window, b = f.created[1]!.window;
  await f.invoke(a, { type: 'control', action: 'minimize' });
  expect(a.webContents.send).toHaveBeenLastCalledWith(COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL, { visible: false, visibleWindowCount: 1 });
  expect(b.webContents.send).toHaveBeenLastCalledWith(COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL, { visible: true, visibleWindowCount: 1 });
  expect(f.main.isMinimized()).toBe(false); expect(b.isMinimized()).toBe(false);
  a.show(); expect(b.webContents.send).toHaveBeenLastCalledWith(COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL, { visible: true, visibleWindowCount: 2 }); f.manager.dispose();
});
it('shares only a minimal contact projection across observer contexts and invalidates it with real changes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000);
  const f = fixture(); await f.invoke(f.main, { type: 'open' }); await f.invoke(f.main, { type: 'open' });
  const a = f.created[0]!.window, b = f.created[1]!.window;
  const contexts = await Promise.all([f.invoke(a, { type: 'context' }), f.invoke(b, { type: 'context' })]);
  expect(f.request.mock.calls.filter(([request]) => request.type === 'state')).toHaveLength(1);
  expect(JSON.stringify(contexts)).not.toContain('PRIVATE_PERSONA'); expect(JSON.stringify(contexts)).not.toContain('NOT_EXPOSED');
  vi.setSystemTime(1300); await f.invoke(b, { type: 'context' }); expect(f.request.mock.calls.filter(([request]) => request.type === 'state')).toHaveLength(2);
  f.manager.changed(); await f.invoke(a, { type: 'context' }); expect(f.request.mock.calls.filter(([request]) => request.type === 'state')).toHaveLength(3); f.manager.dispose();
});

it('does not create a ghost observer when its opener closes during validation, and releases failed loads', async () => {
  const f = fixture(); let resolve!: (value: CompanionsResponse) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const opening = f.invoke(f.main, { type: 'open' }); f.main.close(); resolve({ ok: true, world } as unknown as CompanionsResponse);
  expect((await opening).ok).toBe(false); expect(f.created).toHaveLength(0);
  const next = fixture(); next.load.mockRejectedValueOnce(new Error('private raw diagnostic'));
  const failed = await next.invoke(next.main, { type: 'open' }); expect(failed.ok).toBe(false); expect(JSON.stringify(failed)).not.toContain('private');
  expect(next.created[0]!.window.isDestroyed()).toBe(true); await next.invoke(next.main, { type: 'open' });
  expect((await next.invoke(next.created[1]!.window, { type: 'context' })).context?.observerKey).toBe('companion-world-observer'); next.manager.dispose(); f.manager.dispose();
});
