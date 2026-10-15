import type { CompanionWorldScene, CompanionWorldSnapshot } from './companion-world';
import { companionWorldCellWalkable, findCompanionWorldPath } from './companion-world-engine';

export interface CompanionWorldParkPoint { x: number; y: number }
export interface CompanionWorldParkBounds { x: number; y: number; width: number; height: number }
/** A view over the existing public scene, with the same furniture and collision grid. */
export function companionWorldParkLayout(scene: CompanionWorldScene) {
  if (scene.kind !== 'commons') return undefined;
  const objects = scene.objects.filter(object => object.kind === 'tree' || object.kind === 'bench');
  if (!objects.length) return undefined;
  const left = Math.max(0, Math.min(...objects.map(object => object.position.x)) - 7);
  const top = Math.max(0, Math.min(...objects.map(object => object.position.y)) - 5);
  const right = Math.min(scene.width, Math.max(...objects.map(object => object.position.x + object.width)) + 7);
  const bottom = Math.min(scene.depth, Math.max(...objects.map(object => object.position.y + object.depth)) + 5);
  return { x: left, y: top, width: right - left, height: bottom - top,
    trees: objects.filter(object => object.kind === 'tree'), benches: objects.filter(object => object.kind === 'bench'),
    fountain: scene.objects.find(object => object.kind === 'fountain'), lamps: scene.objects.filter(object => object.kind === 'lamp') };
}

export function companionWorldParkContains(bounds: CompanionWorldParkBounds, point: CompanionWorldParkPoint): boolean {
  return point.x >= bounds.x && point.y >= bounds.y && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height;
}

/** The observer camera key is local UI state; it is never an authoritative scene id. */
export const companionWorldParkViewId = (sceneId: string): string => `${sceneId}:park`;

/** The hazard and physical host share one outdoor safety gate. */
export function companionWorldParkSuitable(environment: Pick<CompanionWorldSnapshot['environment'], 'weather' | 'outdoorTemperature'>, energy?: number): boolean {
  return environment.weather !== undefined && !['rain', 'snow'].includes(environment.weather) && environment.outdoorTemperature !== undefined && environment.outdoorTemperature >= 2 && environment.outdoorTemperature <= 34
    && (energy === undefined || energy > 25);
}

/** A quiet perimeter promenade. Every leg is checked against the host collision grid. */
export function companionWorldParkCircuit(scene: CompanionWorldScene): CompanionWorldParkPoint[] {
  const bounds = companionWorldParkLayout(scene); if (!bounds) return [];
  const left = Math.ceil(bounds.x + 2), right = Math.floor(bounds.x + bounds.width - 2);
  const top = Math.ceil(bounds.y + 2), bottom = Math.floor(bounds.y + bounds.height - 2);
  const points = [{ x: left, y: bottom }, { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }];
  if (points.some(point => !companionWorldCellWalkable(scene, point))) return [];
  for (let index = 0; index < points.length; index++) {
    const route = findCompanionWorldPath(scene, points[index]!, points[(index + 1) % points.length]!);
    if (!route?.length || route.some(point => !companionWorldParkContains(bounds, point))) return [];
  }
  return points;
}
