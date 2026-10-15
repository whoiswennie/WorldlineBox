import type { CompanionWorldActor, CompanionWorldScene, CompanionWorldSnapshot } from '../../../shared/companion-world';

export interface WorldMapPoint { x: number; y: number }
export interface WorldMapHome {
  sceneId: string; ownerId: string; center: WorldMapPoint; entrance: WorldMapPoint;
  bounds: { x: number; y: number; width: number; height: number };
}
/** All map coordinates use the host's outdoor x/y grid, including custom homes. */
export function worldNeighborhoodLayout(scene: CompanionWorldScene, scenes: readonly CompanionWorldScene[]) {
  const homes: WorldMapHome[] = scenes.filter(home => home.kind === 'home' && home.ownerId).flatMap(home => {
    const building = scene.objects.find(object => object.kind === 'building' && object.id === home.ownerId + '_building');
    const entrance = scene.objects.find(object => object.kind === 'door' && object.id === home.ownerId + '_entrance');
    if (!building || !entrance) return [];
    return [{ sceneId: home.id, ownerId: home.ownerId!, center: { x: building.position.x + building.width / 2, y: building.position.y + building.depth / 2 },
      entrance: { ...entrance.anchor }, bounds: { ...building.position, width: building.width, height: building.depth } }];
  });
  function gaps(axis: 'x' | 'y', size: 'width' | 'height', maximum: number) {
    const intervals = homes.map(home => [home.bounds[axis], home.bounds[axis] + home.bounds[size]] as const).sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const [start, end] of intervals) { const prior = merged.at(-1); if (prior && start <= prior[1]!) prior[1] = Math.max(prior[1]!, end); else merged.push([start, end]); }
    const values: number[] = []; let end = 0;
    for (const interval of merged) { if (interval[0]! - end >= 2) values.push((interval[0]! + end) / 2); end = Math.max(end, interval[1]!); }
    if (maximum - end >= 2) values.push((maximum + end) / 2);
    return values;
  }
  return { width: scene.width, height: scene.depth, homes, streets: { vertical: gaps('x', 'width', scene.width), horizontal: gaps('y', 'height', scene.depth) } };
}
/** Routes end at a portal; never draw a line through a different private room. */
export function worldOutdoorRoute(actor: Pick<CompanionWorldActor, 'sceneId' | 'position' | 'route'>, sceneId: string): WorldMapPoint[] {
  if (actor.sceneId !== sceneId) return [];
  const points = [{ ...actor.position }];
  for (const node of actor.route) { if (node.sceneId !== sceneId) break; if (node.x !== points.at(-1)!.x || node.y !== points.at(-1)!.y) points.push({ x: node.x, y: node.y }); }
  return points;
}
export function worldMapActors(snapshot: CompanionWorldSnapshot, sceneId: string) { return snapshot.actors.filter(actor => actor.sceneId === sceneId); }

/** Decoration follows the actual public furniture, without adding obstacles. */
export function worldMapGarden(scene: CompanionWorldScene) {
  const objects = scene.objects.filter(object => object.kind === 'tree' || object.kind === 'bench');
  if (!objects.length) return undefined;
  const left = Math.max(0, Math.min(...objects.map(object => object.position.x)) - 7);
  const top = Math.max(0, Math.min(...objects.map(object => object.position.y)) - 5);
  const right = Math.min(scene.width, Math.max(...objects.map(object => object.position.x + object.width)) + 7);
  const bottom = Math.min(scene.depth, Math.max(...objects.map(object => object.position.y + object.depth)) + 5);
  return { x: left, y: top, width: right - left, height: bottom - top,
    trees: objects.filter(object => object.kind === 'tree'), benches: objects.filter(object => object.kind === 'bench') };
}
