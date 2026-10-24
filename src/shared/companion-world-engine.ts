import type { CompanionWorldActor, CompanionWorldScene, CompanionWorldSettings, CompanionWorldSnapshot } from './companion-world';
import type { CompanionWorldOccupancy } from './companion-world';
import type { CompanionHabitProgress, CompanionRoutineConfig } from './companion-routine';
import { companionCivilInstantInZone, companionTimeInZone } from './companion-schedule-time';

export const COMPANION_WORLD_WALK_TILES_PER_SECOND = 2.4;
export const COMPANION_WORLD_ACTION_TIMINGS = { sitDown: 1400, standUp: 1400, lieDown: 2800, wake: 2800, turn: 900 } as const;
export const COMPANION_WORLD_SEATING_MS = COMPANION_WORLD_ACTION_TIMINGS.sitDown;
export type WorldPoint = { x: number; y: number };
export type WorldWaypoint = WorldPoint & { sceneId: string };
export type CompanionWorldClockAnchor = { realAt: number; virtualAt: number };
/** Civil time always follows the system clock, including when reading a legacy save. */
export const companionWorldSpeed = (settings: Pick<CompanionWorldSettings, 'mode' | 'dayDurationMinutes'>): number => { void settings; return 1; };
export const companionWorldVirtualAt = (_anchor: CompanionWorldClockAnchor, _settings: CompanionWorldSettings, realAt: number): number => realAt;
export const companionWorldRealAt = (_anchor: CompanionWorldClockAnchor, _settings: CompanionWorldSettings, virtualAt: number): number => virtualAt;

/** The same anchors and solid footprints drive rendering, pathfinding and interactions. */
export function companionWorldHomeFootprint(ownerId: string) {
  return { ownerId, width: 20, depth: 16, origin: { x: 0, y: 0 } };
}
export function createCompanionWorldHome(ownerId: string): CompanionWorldScene {
  const object = (suffix: string, kind: CompanionWorldScene['objects'][number]['kind'], name: string, x: number, y: number, width: number, depth: number, ax: number, ay: number, blocking = true) =>
    ({ id: ownerId + '_' + suffix, kind, name, position: { x, y }, width, depth, anchor: { x: ax, y: ay }, blocking });
  return { id: 'home_' + ownerId, kind: 'home', ...companionWorldHomeFootprint(ownerId), name: '小屋', door: { x: 10, y: 15 }, portals: [{ id: 'entrance', direction: 'both', position: { x: 10, y: 15 } }], objects: [
      object('desk', 'desk', '书桌', 2, 2, 5, 2, 4, 4),
      object('computer', 'computer', '电脑', 4, 2, 1, 1, 4, 4, false),
      object('chair', 'chair', '电脑椅', 4, 4, 1, 1, 4, 4, false),
      object('bed', 'bed', '床', 14, 2, 3, 2, 14, 4),
      object('kitchen', 'kitchen', '厨房', 15, 11, 3, 2, 14, 11),
      object('dining', 'dining', '餐桌', 5, 10, 3, 2, 5, 12),
      object('sofa', 'sofa', '休息沙发', 2, 7, 2, 3, 4, 8),
      object('habit', 'habit', '日常活动区', 14, 7, 3, 1, 15, 8, false),
      object('door', 'door', '房门', 10, 15, 1, 1, 10, 15, false),
    ] };
}
/** Public destinations have their own local space; no houses, streets or global placement. */
export function createCompanionWorldPark(): CompanionWorldScene {
  const object = (id: string, kind: CompanionWorldScene['objects'][number]['kind'], name: string, x: number, y: number, width = 1, depth = 1) =>
    ({ id, kind, name, position: { x, y }, width, depth, anchor: { x, y: y + depth }, blocking: true });
  return { id: 'park', kind: 'park', name: '公共花园', width: 56, depth: 36, origin: { x: 0, y: 0 }, door: { x: 28, y: 34 },
    portals: [{ id: 'entrance', direction: 'both', position: { x: 28, y: 34 } }], objects: [
      object('park_bench', 'bench', '花园长椅', 18, 24, 3), object('park_bench_east', 'bench', '树下长椅', 42, 24, 3),
      object('park_tree_west', 'tree', '花园的树', 8, 8, 2, 2), object('park_tree_east', 'tree', '花园的树', 42, 8, 2, 2),
      object('park_tree_north', 'tree', '花园的树', 26, 4, 2, 2), object('park_fountain', 'fountain', '花园喷泉', 26, 14, 4, 4),
      ...[{ x: 3, y: 5 }, { x: 50, y: 5 }, { x: 3, y: 30 }, { x: 50, y: 30 }].map((position, index) => object('park_lamp_' + index, 'lamp', '花园路灯', position.x, position.y)),
      { id: 'park_exit', kind: 'door', name: '花园出入口', position: { x: 28, y: 34 }, anchor: { x: 28, y: 34 }, width: 1, depth: 1, blocking: false },
    ] };
}
export function companionWorldCellWalkable(scene: CompanionWorldScene, point: WorldPoint): boolean {
  const x = Math.round(point.x), y = Math.round(point.y);
  return x >= 0 && y >= 0 && x < scene.width && y < scene.depth && !scene.objects.some(object => object.blocking &&
    x >= object.position.x && x < object.position.x + object.width && y >= object.position.y && y < object.position.y + object.depth);
}
/** Deterministic A*, cardinal movement only; solid furniture is never crossed. */
export function findCompanionWorldPath(scene: CompanionWorldScene, from: WorldPoint, to: WorldPoint, escapeObstructedStart = false): WorldWaypoint[] | undefined {
  const start = { x: Math.round(from.x), y: Math.round(from.y) }, end = { x: Math.round(to.x), y: Math.round(to.y) };
  if (!companionWorldCellWalkable(scene, end)) return undefined;
  const contains = (object: CompanionWorldScene['objects'][number], point: WorldPoint) => point.x >= object.position.x && point.x < object.position.x + object.width && point.y >= object.position.y && point.y < object.position.y + object.depth;
  const enclosing = escapeObstructedStart ? scene.objects.filter(object => object.blocking && contains(object, start)) : [];
  // A layout edit can place a saved actor inside a new solid base. Permit only
  // an exit from that original footprint, never re-entry from a walkable cell.
  const mayEscape = (current: WorldPoint, next: WorldPoint) => enclosing.length > 0 && enclosing.some(object => contains(object, current))
    && enclosing.some(object => contains(object, next)) && !scene.objects.some(object => object.blocking && !enclosing.includes(object) && contains(object, next));
  const key = (p: WorldPoint) => p.x + ',' + p.y;
  const cost = new Map([[key(start), 0]]), parent = new Map<string, WorldPoint>();
  const open = [start], visited = new Set<string>();
  while (open.length) {
    open.sort((a, b) => (cost.get(key(a))! + Math.abs(a.x - end.x) + Math.abs(a.y - end.y)) - (cost.get(key(b))! + Math.abs(b.x - end.x) + Math.abs(b.y - end.y)));
    const current = open.shift()!, k = key(current);
    if (visited.has(k)) continue;
    if (k === key(end)) {
      const result: WorldWaypoint[] = []; let cursor = end;
      while (key(cursor) !== key(start)) { result.push({ ...cursor, sceneId: scene.id }); cursor = parent.get(key(cursor))!; }
      if (!result.length && Math.hypot(from.x - end.x, from.y - end.y) > .000001) result.push({ ...end, sceneId: scene.id });
      return result.reverse();
    }
    visited.add(k);
    for (const delta of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
      const next = { x: current.x + delta.x, y: current.y + delta.y }, nk = key(next), candidate = cost.get(k)! + 1;
      if ((!companionWorldCellWalkable(scene, next) && !mayEscape(current, next)) || candidate >= (cost.get(nk) ?? Infinity)) continue;
      cost.set(nk, candidate); parent.set(nk, current); open.push(next);
    }
  }
  return undefined;
}
/** A path is always local. Cross-scene travel is a host portal operation, never a coordinate route. */
export function routeCompanionWorldActor(scenes: CompanionWorldScene[], actor: CompanionWorldActor, sceneId: string, destination: WorldPoint, mayEnter: (owner: string) => boolean, escapeObstructedStart = false): WorldWaypoint[] | undefined {
  const scene = scenes.find(scene => scene.id === sceneId);
  if (!scene || actor.sceneId !== scene.id || scene.ownerId && !mayEnter(scene.ownerId)) return undefined;
  return findCompanionWorldPath(scene, actor.position, destination, escapeObstructedStart);
}
export function advanceCompanionWorldActor(actor: CompanionWorldActor, elapsedMs: number): { actor: CompanionWorldActor; usedMs: number; arrived: boolean } {
  const next = structuredClone(actor); let distance = Math.max(0, elapsedMs) / 1000 * actor.movementSpeed, used = 0;
  while (next.route.length && distance > 0) {
    const waypoint = next.route[0]!, crossing = waypoint.sceneId !== next.sceneId;
    const dx = crossing ? 0 : waypoint.x - next.position.x, dy = crossing ? 0 : waypoint.y - next.position.y;
    const length = crossing ? 1 : Math.hypot(dx, dy);
    if (!crossing && length < 0.000001) { next.position = { x: waypoint.x, y: waypoint.y }; next.route.shift(); continue; }
    const walked = Math.min(distance, length);
    if (crossing) throw new Error('局部路径不能跨场景，必须通过场景出入口通行。');
    next.facing = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'east' : 'west' : dy > 0 ? 'south' : 'north';
    next.position.x += dx / length * walked; next.position.y += dy / length * walked;
    used += walked / actor.movementSpeed * 1000; distance -= walked;
    if (walked >= length) { next.position = { x: waypoint.x, y: waypoint.y }; next.route.shift(); } else break;
  }
  next.frame = next.route.length ? Math.floor(elapsedMs / 180) % 3 as 0 | 1 | 2 : 0;
  if (next.route.length) next.activity = 'walking';
  return { actor: next, usedMs: used, arrived: !next.route.length };
}
export function companionWorldEnvironment(virtualAt: number, timeZone: string): { clock: Pick<CompanionWorldSnapshot['clock'], 'day' | 'hour' | 'daylight'>; environment: Required<CompanionWorldSnapshot['environment']> } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(virtualAt);
  const part = (name: string) => Number(parts.find(p => p.type === name)?.value ?? 0);
  const hour = part('hour') + part('minute') / 60, day = Math.floor(virtualAt / 86400000), seed = ((day * 1103515245 + 12345) >>> 0) % 100;
  const season = Math.sin((part('month') - 4) / 12 * Math.PI * 2), outdoorTemperature = Math.round((17 + 11 * season + 5 * Math.sin((hour - 9) / 24 * Math.PI * 2) - (seed < 25 ? 3 : 0)) * 10) / 10;
  const weather = seed < 12 && outdoorTemperature < 2 ? 'snow' : seed < 25 ? 'rain' : seed < 52 ? 'cloudy' : 'clear';
  return { clock: { day, hour, daylight: hour >= 6 && hour < 18 }, environment: { weather,
    light: Math.max(0.08, Math.sin((hour - 6) / 12 * Math.PI) * (weather === 'clear' ? 1 : .65)), outdoorTemperature,
    indoorTemperature: Math.round((21 + (outdoorTemperature - 20) * .15) * 10) / 10 } };
}

/** Only authoritative furniture participation earns recovery. Walking and gaps consume awake energy. */
export function companionWorldEnergyRate(window?: Pick<CompanionWorldOccupancy, 'phase' | 'habitKind'>): number {
  return !window ? -.08 : window.phase === 'sleeping' ? .3 : window.phase === 'eating' ? .5 : window.phase === 'resting' ? .15 : window.habitKind === 'rest' ? .15 : window.habitKind === 'exercise' ? -.12 : window.habitKind === 'study' ? -.06 : window.habitKind === 'leisure' ? .04 : -.04;
}
export function advanceCompanionWorldEnergy(windows: CompanionWorldOccupancy[], from: number, to: number, energy: number,
  virtualAt: (realAt: number, referenceRealAt?: number) => number, clockBoundaries: readonly number[] = []): number {
  let current = from, result = energy;
  const apply = (left: number, right: number, rate: number) => {
    for (const [start, end] of clockIntervals(left, right, clockBoundaries)) result = Math.max(0, Math.min(100, result + Math.max(0, virtualAt(end, start) - virtualAt(start, start)) / 60000 * rate));
  };
  for (const window of windows) {
    const start = Math.max(current, window.start), end = Math.min(to, window.end); if (end <= start) continue;
    if (start > current) apply(current, start, companionWorldEnergyRate());
    apply(start, end, companionWorldEnergyRate(window)); current = end;
  }
  if (to > current) apply(current, to, companionWorldEnergyRate()); return result;
}

/** Completion means accumulated real participation equal to one configured session; daily streaks require actual practice. */
export function deriveCompanionWorldHabitProgress(config: CompanionRoutineConfig, windows: CompanionWorldOccupancy[], now: number,
  virtualAt: (realAt: number, referenceRealAt?: number) => number, realAt: (virtualAt: number, referenceRealAt?: number) => number,
  clockBoundaries: readonly number[] = []): CompanionHabitProgress[] {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return config.habits.map(habit => {
    let total = 0, lastCompletedAt: string | undefined; const daily = new Map<string, number>();
    for (const window of windows.filter(window => window.habitId === habit.id && ['habit', 'resting'].includes(window.phase))) for (const [realStart, realEnd] of clockIntervals(window.start, Math.min(now, window.end), clockBoundaries)) {
      const start = virtualAt(realStart, realStart), end = virtualAt(realEnd, realStart), minutes = Math.max(0, end - start) / 60000, before = Math.floor(total / habit.durationMinutes);
      total += minutes; const completed = Math.floor((total + .000001) / habit.durationMinutes);
      if (completed > before) lastCompletedAt = new Date(realAt(end - (total - completed * habit.durationMinutes) * 60000, realStart)).toISOString();
      let cursor = start;
      while (cursor < end) {
        const civil = companionTimeInZone(cursor, config.timeZone), following = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + 1));
        const boundary = companionCivilInstantInZone({ year: following.getUTCFullYear(), month: following.getUTCMonth() + 1, day: following.getUTCDate(), hour: 0, minute: 0, second: 0, millisecond: 0 }, config.timeZone, 'next_valid')!;
        const next = Math.min(end, boundary), key = formatter.format(cursor); daily.set(key, (daily.get(key) ?? 0) + (next - cursor) / 60000); cursor = next;
      }
    }
    const days = [...daily.entries()].filter(([, minutes]) => minutes >= Math.min(5, habit.durationMinutes / 2)).map(([day]) => day);
    let streak = 0, cursor = new Date(formatter.format(virtualAt(now)) + 'T12:00:00Z').getTime();
    if (!days.includes(new Date(cursor).toISOString().slice(0, 10))) cursor -= 86400000;
    while (days.includes(new Date(cursor).toISOString().slice(0, 10))) { streak++; cursor -= 86400000; }
    return { id: habit.id, completedCount: Math.floor((total + .000001) / habit.durationMinutes), practicedMinutes: total, streak,
      strength: Math.min(100, Math.round((1 - Math.exp(-total / Math.max(60, habit.durationMinutes * 14))) * 10000) / 100), ...(lastCompletedAt ? { lastCompletedAt } : {}) };
  });
}

/** Real-time ordering remains unambiguous even when a clock reset repeats a virtual date. */
function* clockIntervals(from: number, to: number, boundaries: readonly number[]): Generator<[number, number]> {
  let low = 0, high = boundaries.length;
  while (low < high) { const middle = (low + high) >>> 1; if (boundaries[middle]! <= from) low = middle + 1; else high = middle; }
  let cursor = from;
  for (let index = low; index < boundaries.length && boundaries[index]! < to; index++) { const end = boundaries[index]!; yield [cursor, end]; cursor = end; }
  if (cursor < to) yield [cursor, to];
}
