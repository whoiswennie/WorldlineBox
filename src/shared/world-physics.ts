import type { BotWorldActor, BotWorldScene } from './companion-bot-world';

/** Extracted unchanged path, footprint and movement rules from the previous world engine. */
export const WORLD_WALK_TILES_PER_SECOND = 2.4;
export const WORLD_ACTION_TIMINGS = { sitDown: 1400, standUp: 1400, lieDown: 2800, wake: 2800, turn: 900 } as const;
export const WORLD_SEATING_MS = WORLD_ACTION_TIMINGS.sitDown;
export type WorldPoint = { x: number; y: number };
export type WorldWaypoint = WorldPoint & { sceneId: string };
/** The same anchors and solid footprints drive rendering, pathfinding and interactions. */
export function worldHomeFootprint(ownerId: string) {
  return { ownerId, width: 20, depth: 16, origin: { x: 0, y: 0 } };
}
export function createWorldHome(ownerId: string): BotWorldScene {
  const object = (suffix: string, kind: BotWorldScene['objects'][number]['kind'], name: string, x: number, y: number, width: number, depth: number, ax: number, ay: number, blocking = true) =>
    ({ id: ownerId + '_' + suffix, kind, name, position: { x, y }, width, depth, anchor: { x: ax, y: ay }, blocking });
  return { id: 'home_' + ownerId, kind: 'home', ...worldHomeFootprint(ownerId), name: '小屋', door: { x: 10, y: 15 }, portals: [{ id: 'entrance', direction: 'both', position: { x: 10, y: 15 } }], objects: [
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
export function createWorldPark(): BotWorldScene {
  const object = (id: string, kind: BotWorldScene['objects'][number]['kind'], name: string, x: number, y: number, width = 1, depth = 1) =>
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
export function worldCellWalkable(scene: BotWorldScene, point: WorldPoint): boolean {
  const x = Math.round(point.x), y = Math.round(point.y);
  return x >= 0 && y >= 0 && x < scene.width && y < scene.depth && !scene.objects.some(object => object.blocking &&
    x >= object.position.x && x < object.position.x + object.width && y >= object.position.y && y < object.position.y + object.depth);
}
/** Deterministic A*, cardinal movement only; solid furniture is never crossed. */
export function findWorldPath(scene: BotWorldScene, from: WorldPoint, to: WorldPoint, escapeObstructedStart = false): WorldWaypoint[] | undefined {
  const start = { x: Math.round(from.x), y: Math.round(from.y) }, end = { x: Math.round(to.x), y: Math.round(to.y) };
  if (!worldCellWalkable(scene, end)) return undefined;
  const contains = (object: BotWorldScene['objects'][number], point: WorldPoint) => point.x >= object.position.x && point.x < object.position.x + object.width && point.y >= object.position.y && point.y < object.position.y + object.depth;
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
      if ((!worldCellWalkable(scene, next) && !mayEscape(current, next)) || candidate >= (cost.get(nk) ?? Infinity)) continue;
      cost.set(nk, candidate); parent.set(nk, current); open.push(next);
    }
  }
  return undefined;
}
/** A path is always local. Cross-scene travel is a host portal operation, never a coordinate route. */
export function routeWorldActor(scenes: BotWorldScene[], actor: BotWorldActor, sceneId: string, destination: WorldPoint, mayEnter: (owner: string) => boolean, escapeObstructedStart = false): WorldWaypoint[] | undefined {
  const scene = scenes.find(scene => scene.id === sceneId);
  if (!scene || actor.sceneId !== scene.id || scene.ownerId && !mayEnter(scene.ownerId)) return undefined;
  return findWorldPath(scene, actor.position, destination, escapeObstructedStart);
}
export function advanceWorldActor(actor: BotWorldActor, elapsedMs: number): { actor: BotWorldActor; usedMs: number; arrived: boolean } {
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
