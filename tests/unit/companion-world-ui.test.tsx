// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Companion, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import { createCompanionWorldPark, createCompanionWorldHome } from '../../src/shared/companion-world-engine';
import { CompanionWorld } from '../../src/renderer/companions/world/CompanionWorld';
import { createWorldViewport } from '../../src/renderer/companions/world/world-engine';
import type { WorldGraphicsCapability } from '../../src/shared/world-graphics-capability';
import { checkWorldGraphicsCapability } from '../../src/renderer/device-capabilities/world-graphics-probe';
import { WORLD_OBSERVER_PREFERENCES_KEY, readWorldObserverPreferences, saveWorldObserverPreferences } from '../../src/renderer/companions/world/world-observer-preferences';
import { interpolateWorldPath, interpolateWorldPosition, worldActorAnimationFrame, worldActorStatus, worldAnimationFrame, worldArtAction, worldAssetUrl, worldClockLabel, worldFacingMirrored, worldInterpolationPath, worldPrecipitationHeight } from '../../src/renderer/companions/world/world-presentation';

const view = vi.hoisted(() => ({ update: vi.fn(), dispose: vi.fn(), setActive: vi.fn(), setVisibleWindowCount: vi.fn(), focus: vi.fn(), reset: vi.fn(), zoom: vi.fn(), rotate: vi.fn(), getView: vi.fn(), restoreView: vi.fn() }));
vi.mock('../../src/renderer/companions/world/world-engine', () => ({ createWorldViewport: vi.fn(() => view) }));
const graphics = vi.hoisted(() => ({ report: { status: 'available', checkedAt: '2026-10-22T00:00:00Z', webgl2: true, minimumMemoryGiB: 4 } as WorldGraphicsCapability,
  listeners: new Set<() => void>() }));
vi.mock('../../src/renderer/device-capabilities/world-graphics-probe', () => ({
  getWorldGraphicsCapability: () => graphics.report,
  subscribeWorldGraphicsCapability: (listener: () => void) => { graphics.listeners.add(listener); return () => graphics.listeners.delete(listener); },
  checkWorldGraphicsCapability: vi.fn(() => { graphics.report = { status: 'available', checkedAt: '2026-10-22T00:00:01Z', webgl2: true, minimumMemoryGiB: 4 }; graphics.listeners.forEach(listener => listener()); return graphics.report; }),
  markWorldGraphicsUnavailable: (reasonCode: WorldGraphicsCapability['reasonCode'], reason: string) => { graphics.report = { ...graphics.report, status: 'unavailable', reasonCode, reason }; graphics.listeners.forEach(listener => listener()); return graphics.report; },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
beforeEach(() => { localStorage.clear(); view.getView.mockReturnValue(undefined); graphics.report = { status: 'available', checkedAt: '2026-10-22T00:00:00Z', webgl2: true, minimumMemoryGiB: 4 }; });
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); vi.clearAllMocks(); });
const at = '2026-10-14T08:00:00.000Z';
const companions: Companion[] = BUILTIN_COMPANIONS.slice(0, 2).map(item => ({ ...item, builtin: true, createdAt: at }));
const first = companions[0]!, second = companions[1]!;
function world(): CompanionWorldSnapshot { return { settings: { revision: 4, mode: 'compressed', dayDurationMinutes: 20, timeZone: 'Asia/Shanghai' }, clock: { realNow: at, virtualNow: at, hour: 16, day: 10, daylight: true, speed: 72 }, environment: { weather: 'clear', light: .7, outdoorTemperature: 21.5, indoorTemperature: 22.2 }, scenes: [createCompanionWorldHome(first.id), createCompanionWorldHome(second.id)], actors: [{ companionId: first.id, homeSceneId: 'home_' + first.id, sceneId: 'home_' + first.id, position: { x: 5.3, y: 4 }, facing: 'west', frame: 1, activity: 'walking', activityStartedAtReal: at, artAction: 'walk', locomotion: 'walk', movementSpeed: 2.4, state: { energy: 75, expression: 'gentle', thermalComfort: .9 }, route: [{ sceneId: 'home_' + first.id, x: 4, y: 4 }], routinePhase: 'awake' }], visits: [{ id: 'visit', guestId: second.id, hostId: first.id, status: 'requested', reason: '想一起喝杯茶', createdAt: at, expiresAt: '2026-10-14T09:00:00.000Z' }], works: [{ workId: 'work', companionId: first.id, kind: 'action', status: 'moving', computerId: first.id + '_computer', reason: '先走到自己的电脑前' }], events: [], relationships: [], residents: companions.map(item => ({ companionId: item.id, name: item.name, homeSceneId: "home_" + item.id })), lastEventSequence: 0, backlog: false }; }
function apiFor(get: () => CompanionWorldSnapshot, config?: (input: CompanionsRequest) => CompanionsResponse): WorldlineBoxCompanionsApi { return { request: vi.fn(async input => input.type === 'world.snapshot' ? { ok: true, world: get() } : config?.(input) ?? { ok: true, world: get() }), onChanged: vi.fn(() => () => undefined), onReplyStream: vi.fn(() => () => undefined) }; }
async function mount(api: WorldlineBoxCompanionsApi, initialCompanionId: string | null = first.id) { vi.useFakeTimers(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); await act(async () => root!.render(<CompanionWorld api={api} companions={companions} initialCompanionId={initialCompanionId ?? undefined} onClose={vi.fn()} />)); }
function button(label: string) { const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label); if (!found) throw new Error('No button ' + label); return found; }
async function click(label: string) { await act(async () => button(label).click()); }

it('gates only the 3D renderer with a specific reason and restores it after a successful manual check', async () => {
  graphics.report = { ...graphics.report, status: 'unavailable', webgl2: false, reasonCode: 'webgl2_unavailable', reason: '当前无法创建 WebGL 2 画面。' };
  const api = apiFor(world); await mount(api);
  expect(createWorldViewport).not.toHaveBeenCalled();
  expect(container!.querySelector('[aria-label="3D 设备能力"]')!.textContent).toContain('WebGL 2');
  expect(container!.querySelector('[aria-label="3D 设备能力"]')!.textContent).toContain('聊天、记忆文档与资产管理可以继续使用');
  expect(container!.querySelector('[aria-label="世界中的伙伴"]')!.textContent).toContain('位置 5.3, 4.0');
  await act(() => vi.advanceTimersByTimeAsync(1000)); expect(api.request).toHaveBeenCalledTimes(2);
  await click('重新检测 3D 能力');
  expect(checkWorldGraphicsCapability).toHaveBeenCalledOnce(); expect(createWorldViewport).toHaveBeenCalledOnce();
  expect(container!.querySelector('[aria-label="3D 设备能力"]')).toBeNull();
  expect(view.update).toHaveBeenLastCalledWith(world(), world().scenes[0], companions);
});

it('disposes a genuinely lost scene and offers recheck without freezing its authoritative 2D life data', async () => {
  const api = apiFor(world); await mount(api);
  const camera = { position: { x: 30, y: 40, z: 50 }, target: { x: 28, y: 0, z: 18 }, zoom: .8 };
  view.getView.mockReturnValue(camera);
  await act(() => { vi.mocked(createWorldViewport).mock.calls.at(-1)![4]?.(); });
  expect(view.dispose).toHaveBeenCalledOnce();
  expect(container!.querySelector('[aria-label="3D 设备能力"]')!.textContent).toContain('上下文已中断');
  expect(container!.querySelector('[aria-label="世界中的伙伴"]')).not.toBeNull();
  await click('重新检测 3D 能力'); expect(createWorldViewport).toHaveBeenCalledTimes(2);
  expect(view.restoreView).toHaveBeenLastCalledWith(camera, undefined);
});

it('selects independent scenes directly and remembers the park camera without a neighborhood map', async () => {
  const snapshot = world(); snapshot.scenes.push(createCompanionWorldPark());
  saveWorldObserverPreferences({ sceneId: 'park', views: {} });
  const api = apiFor(() => snapshot); await mount(api, null);
  expect(container!.querySelector('[data-world-map-ready]')).toBeNull();
  expect(view.update).toHaveBeenLastCalledWith(snapshot, snapshot.scenes.at(-1), companions);
  expect(view.setActive).toHaveBeenLastCalledWith(true);
  const camera = { position: { x: 30, y: 40, z: 50 }, target: { x: 28, y: 0, z: 18 }, zoom: .8 };
  view.getView.mockReturnValue(camera);
  await act(async () => vi.mocked(createWorldViewport).mock.calls.at(-1)![3]?.());
  expect(readWorldObserverPreferences().views.park).toEqual(camera);
  const location = container!.querySelector<HTMLSelectElement>('[aria-label="观测地点"]')!;
  await act(() => { location.value = 'home_' + second.id; location.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(view.update.mock.calls.at(-1)?.[1].id).toBe('home_' + second.id);
  await act(() => { location.value = 'park'; location.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(view.restoreView).toHaveBeenLastCalledWith(camera, undefined);
  expect(vi.mocked(api.request).mock.calls.every(([input]) => input.type === 'world.snapshot')).toBe(true);
});

it('shows actual host positions, movement, environment and visit outcomes without impersonating an owner decision', async () => {
  let snapshot = { ...world(), backlog: true }; const api = apiFor(() => snapshot); await mount(api);
  expect(container!.querySelector('[role="status"]')!.textContent).toContain('正在接续离线期间的生活');
  expect(container!.querySelector('[data-world-actor]')!.textContent).toContain('位置 5.3, 4.0');
  expect(container!.textContent).toContain('正在前往电脑'); expect(container!.textContent).toContain('16:00'); expect(container!.textContent).toContain('21.5°'); expect(container!.textContent).toContain('等待对方回应');
  expect([...container!.querySelectorAll('button')].some(item => /批准|拒绝拜访/.test(item.textContent ?? ''))).toBe(false);
  snapshot = { ...snapshot, backlog: false, actors: [{ ...snapshot.actors[0]!, position: { x: 4, y: 4 }, activity: 'working' }], works: [{ ...snapshot.works[0]!, status: 'ready' }], visits: [{ ...snapshot.visits[0]!, status: 'denied', response: '现在有一点忙，晚些再见。' }] };
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container!.textContent).toContain('已就座，可以处理'); expect(container!.textContent).toContain('正在处理任务'); expect(container!.textContent).toContain('对方暂不方便'); expect(container!.textContent).toContain('现在有一点忙');
  expect(container!.querySelector('[role="status"]')).toBeNull();
  expect(api.request).toHaveBeenCalledTimes(2); expect(api.onChanged).not.toHaveBeenCalled();
  expect(view.update).toHaveBeenLastCalledWith(snapshot, snapshot.scenes[0], companions);
});

it('switches homes and routes camera controls without issuing actor commands', async () => {
  const snapshot = world(), api = apiFor(() => snapshot); await mount(api);
  const location = container!.querySelector<HTMLSelectElement>('[aria-label="观测地点"]')!;
  await act(async () => { location.value = 'home_' + second.id; location.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container!.textContent).toContain(second.name + '的小屋'); expect(container!.querySelectorAll('[data-world-actor]')).toHaveLength(0);
  expect(view.update).toHaveBeenLastCalledWith(snapshot, snapshot.scenes[1], companions);
  await click('放大世界'); await click('向左旋转世界'); await click('重置世界视角');
  expect(view.zoom).toHaveBeenCalledWith(1.2); expect(view.rotate).toHaveBeenCalledWith(-Math.PI / 8); expect(view.reset).toHaveBeenCalledOnce();
  expect(vi.mocked(api.request).mock.calls.every(([input]) => input.type === 'world.snapshot')).toBe(true);
});

it('keeps the compact header on authoritative world date/time and presents realtime as the default recommendation', async () => {
  const snapshot = world(); snapshot.clock.hour = 4;
  await mount(apiFor(() => snapshot)); vi.setSystemTime(new Date('2035-01-01T01:00:00Z'));
  const header = container!.querySelector('.companion-world-header')!;
  expect(header.querySelector('time')?.dateTime).toBe(snapshot.clock.virtualNow);
  expect(header.textContent).toContain('2026/10/14'); expect(header.textContent).toContain('16:00');
  expect(header.textContent).toContain('21.5°C'); expect(header.textContent).toContain('晴');
  expect(header.querySelector('h2')).toBeNull(); expect(container!.querySelector('.companion-world-brand')).toBeNull();
  expect(container!.textContent).not.toMatch(/A LITTLE WORLD|日子，在这里发生|HOME, SWEET HOME|THE NEIGHBORHOOD/);
  await click('世界设置');
  expect(container!.querySelector('form')?.textContent).toContain('相同的现实日期与时间');
  expect(container!.querySelector('input[type="radio"]')).toBeNull();
  expect(container!.querySelector('[aria-label="世界一天的现实分钟"]')).toBeNull();
});

it('saves the inspected settings revision and keeps the previous world on conflict', async () => {
  const snapshot = world(), api = apiFor(() => snapshot, input => input.type === 'world.configure' ? { ok: false, error: '世界设置已变化，请刷新。' } : { ok: true }); await mount(api);
  await click('世界设置'); await click('保存世界设置');
  expect(api.request).toHaveBeenCalledWith({ type: 'world.configure', expectedRevision: 4, patch: { timeZone: 'Asia/Shanghai' } });
  expect(container!.querySelector('form')!.textContent).toContain('世界设置已变化'); expect(container!.textContent).toContain('16:00');
  await click('关闭世界设置'); expect(container!.querySelector('form')).toBeNull();
});

it('stops polling and releases the renderer when the world closes', async () => {
  const api = apiFor(world); await mount(api); await act(async () => { root!.unmount(); root = undefined; });
  expect(view.dispose).toHaveBeenCalledOnce(); await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(api.request).toHaveBeenCalledTimes(1);
});

it('never creates a renderer for a dormant home and disposes its resources immediately when the resident is suspended', async () => {
  const snapshot = world(), full = world();
  snapshot.residents[0]!.active = false;
  snapshot.actors = []; snapshot.scenes = snapshot.scenes.filter(scene => scene.ownerId !== first.id);
  const api = apiFor(() => structuredClone(snapshot)); await mount(api);
  expect(container!.textContent).toContain('虚拟世界未加载');
  expect(createWorldViewport).not.toHaveBeenCalled(); expect(view.update).not.toHaveBeenCalled();
  snapshot.residents[0]!.active = true; snapshot.scenes = full.scenes; snapshot.actors = full.actors;
  await act(() => vi.advanceTimersByTimeAsync(1000)); expect(createWorldViewport).toHaveBeenCalledOnce();
  snapshot.residents[0]!.active = false; snapshot.actors = []; snapshot.scenes = snapshot.scenes.filter(scene => scene.ownerId !== first.id);
  await act(() => vi.advanceTimersByTimeAsync(1000)); expect(view.dispose).toHaveBeenCalledOnce();
  expect(container!.querySelector('canvas')).toBeNull(); expect(container!.textContent).toContain('虚拟世界未加载');
});

it('keeps world observation nonmodal, opens another scene window and collapses its inspector', async () => {
  const open = vi.fn(); await mount(apiFor(world));
  await act(async () => root!.render(<CompanionWorld api={apiFor(world)} companions={companions} visibleWindowCount={3} initialCompanionId={first.id} onClose={vi.fn()} onOpenWindow={open} />));
  expect(container!.querySelector('[aria-modal="true"]')).toBeNull();
  expect(view.setVisibleWindowCount).toHaveBeenLastCalledWith(3);
  await click('另开一个世界窗口'); expect(open).toHaveBeenCalledWith('home_' + first.id);
  await click('收起生活面板'); expect(container!.querySelector('aside')!.hidden).toBe(true);
  await click('显示生活面板'); expect(container!.querySelector('aside')!.hidden).toBe(false);
});

it('describes actual physical behavior before work promises and distinguishes destinations, habits and execution', () => {
  const snapshot = world(), actor = snapshot.actors[0]!;
  const status = (patch: Partial<typeof actor>, works = snapshot.works) => worldActorStatus({ ...actor, ...patch }, { ...snapshot, works }, companions);
  expect(status({ locomotion: 'run' }).label).toBe('跑向自己的电脑');
  expect(status({ sceneId: 'park', locomotion: 'run' }).label).toBe('赶回家里的电脑前');
  expect(status({ activity: 'sleeping' }, [{ ...snapshot.works[0]!, status: 'waiting' }])).toMatchObject({ label: '正在睡觉', kind: 'sleep', detail: '有事项等醒来后处理' });
  expect(status({ activity: 'eating' }, [{ ...snapshot.works[0]!, status: 'waiting' }]).label).toBe('正在用餐');
  expect(status({ activity: 'seating' }, [{ ...snapshot.works[0]!, status: 'seating' }]).label).toBe('正在电脑前坐稳');
  expect(status({ activity: 'working' }, [{ ...snapshot.works[0]!, status: 'ready' }]).label).toBe('正在处理任务');
  expect(status({ activity: 'working' }, [{ ...snapshot.works[0]!, kind: 'action', status: 'ready' }]).label).toBe('正在处理任务');
  expect(status({ activity: 'working' }, [{ ...snapshot.works[0]!, status: 'ready' }, { ...snapshot.works[0]!, workId: 'parallel', status: 'ready' }]).label).toBe('正在处理 2 件事');
  expect(status({ activity: 'working' }, []).label).toBe('在电脑前工作');
  expect(status({ activity: 'habit', artAction: 'cook' }, []).label).toBe('正在做饭');
  expect(status({ activity: 'habit', artAction: 'read' }, []).label).toBe('正在读书');
  expect(status({ activity: 'habit', artAction: 'exercise' }, []).label).toBe('正在锻炼');
  expect(status({ activity: 'habit', artAction: 'communicate' }, [])).toMatchObject({ label: '正在交谈', kind: 'social' });
  expect(status({ activity: 'walking' }, [{ ...snapshot.works[0]!, computerId: second.id + '_computer' }]).label).toBe('走向' + second.name + '家的电脑');
});

it('shows the actual phone correspondent while preserving physical activity and expired notification boundaries', () => {
  const snapshot = world(), actor = snapshot.actors[0]!;
  const communication = { channel: 'phone' as const, phase: 'typing' as const, conversationId: 'peer-room', recipientIds: [second.id], untilReal: '2026-10-14T08:00:05.000Z' };
  const status = (patch: Partial<typeof actor>) => worldActorStatus({ ...actor, communication, activity: 'idle', ...patch }, { ...snapshot, works: [] }, companions);
  expect(status({})).toMatchObject({ kind: 'social', label: '正在给' + second.name + '发消息' });
  expect(status({ activity: 'sitting' }).label).toBe('正在给' + second.name + '发消息');
  expect(status({ communication: { ...communication, recipientIds: [second.id, 'third'] } }).label).toBe('正在群聊里发消息');
  expect(status({ communication: { ...communication, phase: 'notification' } }).label).toBe('收到' + second.name + '的消息');
  expect(status({ activity: 'sitting', communication: { ...communication, phase: 'responding', recipientIds: ['user'] } }).label).toBe('正在回复聊天');
  expect(status({ activity: 'habit', communication: { ...communication, phase: 'responding', recipientIds: ['user'] } }).label).toBe('正在回复聊天');
  expect(status({ activity: 'sleeping' }).label).toBe('正在睡觉');
  expect(status({ activity: 'eating' }).label).toBe('正在用餐');
  expect(status({ activity: 'working' }).label).toBe('在电脑前工作');
  expect(status({ activity: 'walking' }).label).toBe('正在走动');
  expect(status({ communication: { ...communication, untilReal: at } }).kind).toBe('idle');
});

it('distinguishes live face-to-face speaking and listening, names group participants and preserves physical priority', () => {
  const snapshot = world(), actor = snapshot.actors[0]!;
  const communication = { channel: 'face_to_face' as const, phase: 'speaking' as const, conversationId: 'peer-room', recipientIds: [second.id], untilReal: '2026-10-14T08:00:05.000Z' };
  const status = (patch: Partial<typeof actor> = {}) => worldActorStatus({ ...actor, activity: 'habit', artAction: 'communicate', communication, ...patch }, { ...snapshot, works: [] }, companions);
  expect(status()).toMatchObject({ kind: 'social', label: '正在与' + second.name + '当面交谈' });
  expect(status({ communication: { ...communication, phase: 'listening' } }).label).toBe('正在听' + second.name + '说话');
  expect(status({ communication: { ...communication, recipientIds: [second.id, 'third', actor.companionId, second.id] } })).toMatchObject({ label: '正在与2位伙伴当面交谈', detail: second.name + '、伙伴' });
  expect(status({ activity: 'sleeping' }).label).toBe('正在睡觉'); expect(status({ activity: 'eating' }).label).toBe('正在用餐'); expect(status({ activity: 'working' }).label).toBe('在电脑前工作');
  expect(status({ activity: 'idle', communication: { ...communication, untilReal: at } }).kind).toBe('idle');
});

it('remembers each scene camera on interaction, close and reopen while explicit home entry overrides the last scene', async () => {
  const firstView = { position: { x: 25, y: 24, z: 30 }, target: { x: 9, y: 0, z: 7 }, zoom: 1.4 };
  const secondView = { position: { x: 30, y: 26, z: 28 }, target: { x: 8, y: 0, z: 6 }, zoom: 1.8 };
  const api = apiFor(world); await mount(api, null);
  view.getView.mockReturnValue(firstView);
  await act(async () => vi.mocked(createWorldViewport).mock.calls.at(-1)![3]?.());
  expect(readWorldObserverPreferences().views['home_' + first.id]).toEqual(firstView);
  const location = container!.querySelector<HTMLSelectElement>('[aria-label="观测地点"]')!;
  await act(async () => { location.value = 'home_' + second.id; location.dispatchEvent(new Event('change', { bubbles: true })); });
  view.getView.mockReturnValue(secondView);
  await act(async () => { root!.unmount(); root = undefined; }); container!.remove();
  expect(readWorldObserverPreferences()).toMatchObject({ sceneId: 'home_' + second.id, views: { ['home_' + first.id]: firstView, ['home_' + second.id]: secondView } });
  view.restoreView.mockClear(); await mount(api, null);
  expect(container!.querySelector('[data-world-scene]')!.getAttribute('data-world-scene')).toBe('home_' + second.id);
  expect(view.restoreView).toHaveBeenCalledWith(secondView, undefined);
  await act(async () => { root!.unmount(); root = undefined; }); container!.remove();
  view.restoreView.mockClear(); await mount(api, first.id);
  expect(container!.querySelector('[data-world-scene]')!.getAttribute('data-world-scene')).toBe('home_' + first.id);
  expect(view.restoreView).toHaveBeenCalledWith(firstView, undefined);
});

it('restores a valid follow choice without copying actor state and saves before the page unloads', async () => {
  const camera = { position: { x: 20, y: 20, z: 20 }, target: { x: 5, y: 0, z: 4 }, zoom: 2.4 };
  saveWorldObserverPreferences({ sceneId: 'home_' + first.id, followId: first.id, views: { ['home_' + first.id]: camera } });
  view.getView.mockReturnValue(camera); await mount(apiFor(world), null);
  expect(view.restoreView).toHaveBeenCalledWith(camera, first.id); expect(container!.textContent).toContain('正在跟随 ' + first.name);
  const changed = { ...camera, zoom: 2.8 }; view.getView.mockReturnValue(changed);
  await act(async () => window.dispatchEvent(new Event('beforeunload')));
  expect(readWorldObserverPreferences().views['home_' + first.id]).toEqual(changed);
  expect(Object.keys(JSON.parse(localStorage.getItem(WORLD_OBSERVER_PREFERENCES_KEY)!)).sort()).toEqual(['followId', 'sceneId', 'views']);
});

it('ignores corrupt, nonfinite or excessive camera preferences and still opens the real world', async () => {
  localStorage.setItem(WORLD_OBSERVER_PREFERENCES_KEY, '{broken'); expect(readWorldObserverPreferences()).toEqual({ views: {} });
  localStorage.setItem(WORLD_OBSERVER_PREFERENCES_KEY, JSON.stringify({ sceneId: 'home_' + second.id, views: { home: { position: { x: 0, y: 10, z: 20 }, target: { x: 0, y: 0, z: 0 }, zoom: 999 } } }));
  await mount(apiFor(world), null); expect(container!.querySelector('[data-world-scene]')!.getAttribute('data-world-scene')).toBe('home_' + first.id); expect(view.restoreView).not.toHaveBeenCalled();
  const storage = { getItem: () => JSON.stringify({ views: { home: { position: { x: null, y: 10, z: 20 }, target: { x: 0, y: 0, z: 0 }, zoom: 1 } } }), setItem: vi.fn() };
  expect(readWorldObserverPreferences(storage)).toEqual({ views: {} });
});

it('keeps the authoritative transition frame during offline catch-up and resumes live animation afterward', () => {
  const actor = { frame: 1 as const, activityStartedAtReal: at }, animation = { duration: 2800, playback: 'transition' as const };
  expect(worldActorAnimationFrame(actor, animation, true, Date.parse(at) + 3_600_000)).toBe(1);
  expect(worldActorAnimationFrame(actor, animation, false, Date.parse(at) + 3_600_000)).toBe(2);
  expect(worldActorAnimationFrame({ ...actor, frame: 0 }, animation, true, Date.parse(at) + 3_600_000)).toBe(0);
  expect(worldActorAnimationFrame({ ...actor, artStartedAtReal: at }, { duration: 900, playback: 'loop' }, false, Date.parse(at) + 350)).toBe(1);
});

it('never extrapolates beyond received facts and follows known route corners', () => {
  for (const time of [0, 1799, 1800, 1801, 120_000]) {
    const head = worldPrecipitationHeight(0, time, 'rain'), tail = head - 1.35;
    expect(head).toBeGreaterThanOrEqual(0); expect(head).toBeLessThan(18); expect(head - tail).toBeCloseTo(1.35);
  }
  expect(worldPrecipitationHeight(1, 100, 'rain')).not.toBe(worldPrecipitationHeight(1, 100, 'snow'));
  expect(interpolateWorldPosition({ x: 0, y: 0 }, { x: 2, y: 0 }, 900)).toEqual({ x: 2, y: 0 });
  const path = worldInterpolationPath({ sceneId: 'home', position: { x: 0, y: 0 }, route: [{ sceneId: 'home', x: 1, y: 0 }, { sceneId: 'home', x: 1, y: 2 }] }, { x: 1, y: 1 });
  expect(path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]); expect(interpolateWorldPath(path, 375)).toEqual({ x: 1, y: 0 }); expect(interpolateWorldPath(path, 50_000)).toEqual({ x: 1, y: 1 });
  expect(worldArtAction({ activity: 'working' })).toBe('work'); expect(worldArtAction({ activity: 'seating' })).toBe('sitDown'); expect(worldArtAction({ activity: 'sleeping' })).toBe('sleep');
  expect(worldClockLabel(23.5)).toBe('23:30'); expect(worldAssetUrl('/companion-world/a.webp')).toBe('./companion-world/a.webp');
  expect(worldAnimationFrame(at, 900, 'loop', Date.parse(at) + 1000)).toBe(0);
  expect(worldAnimationFrame(at, 900, 'transition', Date.parse(at) + 1000)).toBe(2);
  expect(worldAnimationFrame(at, 900, 'loop', Date.parse(at) + 350)).toBe(1);
  expect(worldFacingMirrored('east', { x: 1, z: 0 })).toBe(true); expect(worldFacingMirrored('west', { x: 1, z: 0 })).toBe(false);
  expect(worldFacingMirrored('east', { x: -1, z: 0 })).toBe(false); expect(worldFacingMirrored('west', { x: -1, z: 0 })).toBe(true);
  expect(worldFacingMirrored('north', { x: 0, z: -1 })).toBe(true);
});
