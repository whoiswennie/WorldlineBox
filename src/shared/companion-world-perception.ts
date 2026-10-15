import { z } from 'zod';
import type { CompanionWorldActor, CompanionWorldScene, CompanionWorldSnapshot } from './companion-world';

export const COMPANION_WORLD_PERCEPTION_INTERVAL_MS = 1000;
export const COMPANION_WORLD_PERCEPTION_OBJECT_LIMIT = 256;
export const COMPANION_WORLD_PERCEPTION_PEOPLE_LIMIT = 64;
export const COMPANION_WORLD_PERCEPTION_MAX_RADIUS = 10;
export const COMPANION_WORLD_PERCEPTION_LAMP_RADIUS = 9;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const activity = z.enum(['idle', 'walking', 'seating', 'sitting', 'working', 'sleeping', 'eating', 'resting', 'habit', 'standingUp', 'lyingDown', 'waking', 'turning']);
const furnitureKind = z.enum(['bed', 'desk', 'computer', 'chair', 'kitchen', 'dining', 'sofa', 'habit', 'door', 'tree', 'bench', 'building', 'fountain', 'lamp']);
const weather = z.enum(['clear', 'cloudy', 'rain', 'snow']);

export const companionWorldPerceivedObjectSchema = z.strictObject({ sceneId: id, id, kind: furnitureKind, name: z.string(), position: point,
  width: z.number().positive(), depth: z.number().positive(), anchor: point, blocking: z.boolean(),
  firstObservedAt: z.iso.datetime(), lastObservedAt: z.iso.datetime(), visible: z.boolean() });
export const companionWorldPerceivedPersonSchema = z.strictObject({ companionId: id, sceneId: id, position: point, activity,
  lastObservedAt: z.iso.datetime(), visible: z.boolean() });
export const companionWorldPerceptionSchema = z.strictObject({ companionId: id, observedAtReal: z.iso.datetime(), observedAtVirtual: z.iso.datetime(),
  sceneId: id, position: point, activity, radius: z.number().min(4).max(COMPANION_WORLD_PERCEPTION_MAX_RADIUS), awake: z.boolean(),
  environment: z.strictObject({ time: z.iso.datetime(), light: z.number().min(0).max(1), temperature: z.number().finite(), daylight: z.boolean(), weather: weather.optional(),
    weatherObservedAtVirtual: z.iso.datetime().optional(), weatherObservedAtReal: z.iso.datetime().optional(), weatherSource: z.enum(['outdoors', 'door']).optional() }),
  visibleObjectIds: z.array(id).max(COMPANION_WORLD_PERCEPTION_OBJECT_LIMIT), visibleCompanionIds: z.array(id).max(COMPANION_WORLD_PERCEPTION_PEOPLE_LIMIT),
  objects: z.array(companionWorldPerceivedObjectSchema).max(COMPANION_WORLD_PERCEPTION_OBJECT_LIMIT),
  people: z.array(companionWorldPerceivedPersonSchema).max(COMPANION_WORLD_PERCEPTION_PEOPLE_LIMIT), revision: z.number().int().nonnegative() });

export type CompanionWorldPerception = z.infer<typeof companionWorldPerceptionSchema>;
export type CompanionWorldPerceivedObject = z.infer<typeof companionWorldPerceivedObjectSchema>;
export type CompanionWorldPerceivedPerson = z.infer<typeof companionWorldPerceivedPersonSchema>;
type Actor = Pick<CompanionWorldActor, 'companionId' | 'sceneId' | 'position' | 'activity'>;
type Furniture = CompanionWorldScene['objects'][number];
export interface SampleCompanionWorldPerceptionInput {
  self: Actor;
  scenes: readonly CompanionWorldScene[];
  actors: readonly Actor[];
  environment: Required<CompanionWorldSnapshot['environment']> & { daylight: boolean };
  virtualAt: string;
  realAt: string;
  previous?: CompanionWorldPerception;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const cellKey = (x: number, y: number) => x + ',' + y;
const objectKey = (object: { sceneId: string; id: string }) => object.sceneId + '/' + object.id;
const range = (a: Actor['position'], b: Actor['position']) => Math.hypot(a.x - b.x, a.y - b.y);
// Low furniture occupies walking cells without becoming a floor-to-ceiling wall.
// A seated/standing observer can still see a computer on a desk or over a bed.
const opaqueKinds = new Set<Furniture['kind']>(['building', 'tree', 'kitchen', 'fountain']);
const atIso = (value: string) => { const timestamp = Date.parse(value); if (!Number.isFinite(timestamp)) throw new Error('伙伴感知时间无效。'); return new Date(timestamp).toISOString(); };

/** Footprints are the host's cell extents, not an object's distant anchor. */
function nearestFootprint(position: Actor['position'], object: Furniture) {
  return { x: clamp(position.x, object.position.x - .5, object.position.x + object.width - .5),
    y: clamp(position.y, object.position.y - .5, object.position.y + object.depth - .5) };
}

function lineOfSight(scene: CompanionWorldScene, origin: Actor['position']) {
  // Restrict the grid to the maximum possible sight square; huge buildings never
  // expand work or allocations in proportion to the entire outdoor map.
  const cells = new Map<string, string[]>(), radius = COMPANION_WORLD_PERCEPTION_MAX_RADIUS + 1;
  for (const object of scene.objects) {
    if (!object.blocking || !opaqueKinds.has(object.kind)) continue;
    const left = Math.max(Math.ceil(origin.x - radius), Math.ceil(object.position.x));
    const right = Math.min(Math.floor(origin.x + radius), Math.ceil(object.position.x + object.width) - 1);
    const top = Math.max(Math.ceil(origin.y - radius), Math.ceil(object.position.y));
    const bottom = Math.min(Math.floor(origin.y + radius), Math.ceil(object.position.y + object.depth) - 1);
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const key = cellKey(x, y), occupants = cells.get(key) ?? []; occupants.push(object.id); cells.set(key, occupants);
    }
  }
  const startX = Math.round(origin.x), startY = Math.round(origin.y);
  return (target: Actor['position'], ignoredObjectId?: string): boolean => {
    const blocked = (x: number, y: number) => (x !== startX || y !== startY) && cells.get(cellKey(x, y))?.some(id => id !== ignoredObjectId);
    const steps = Math.max(1, Math.ceil(range(origin, target) * 4)); let priorX = startX, priorY = startY;
    for (let step = 1; step <= steps; step++) {
      const x = Math.round(origin.x + (target.x - origin.x) * step / steps), y = Math.round(origin.y + (target.y - origin.y) * step / steps);
      if (blocked(x, y)) return false;
      // Conservative supercover prevents diagonally peeking through two solids
      // that meet at a grid corner. The target furniture itself is ignored.
      if (x !== priorX && y !== priorY && (blocked(x, priorY) || blocked(priorX, y))) return false;
      priorX = x; priorY = y;
    }
    return true;
  };
}

function footprintVisible(position: Actor['position'], object: Furniture, radius: number, canSee: ReturnType<typeof lineOfSight>) {
  const nearest = nearestFootprint(position, object);
  if (range(position, nearest) > radius + 1e-8) return false;
  const left = object.position.x - .5, right = object.position.x + object.width - .5, top = object.position.y - .5, bottom = object.position.y + object.depth - .5;
  // Seeing one unobstructed edge is enough to recognize the object. A target's
  // own solid cells must not make all beds, trees and buildings invisible.
  const candidates = [nearest, { x: left, y: top }, { x: right, y: top }, { x: left, y: bottom }, { x: right, y: bottom },
    { x: (left + right) / 2, y: (top + bottom) / 2 }];
  return candidates.some(target => range(position, target) <= radius + 1e-8 && canSee(target, object.id));
}

/** No timestamps or unseen positions: this changes only for meaningful awareness. */
export function companionWorldPerceptionSignature(value: CompanionWorldPerception): string {
  const cell = (position: Actor['position']) => [Math.floor(position.x / 2), Math.floor(position.y / 2)];
  return JSON.stringify({ companionId: value.companionId, sceneId: value.sceneId, position: cell(value.position), activity: value.activity, awake: value.awake,
    environment: { daylight: value.environment.daylight, lightBand: Math.floor(value.environment.light * 4), temperatureBand: Math.floor(value.environment.temperature / 2),
      weather: value.environment.weather, weatherSource: value.environment.weatherSource },
    knownObjectKeys: value.objects.map(objectKey), knownPeople: value.people.map(person => person.companionId),
    visibleObjects: value.objects.filter(object => object.visible).map(object => [object.sceneId, object.id, object.kind, object.name, object.position.x, object.position.y, object.width, object.depth, object.anchor.x, object.anchor.y, object.blocking]),
    visiblePeople: value.people.filter(person => person.visible).map(person => [person.companionId, person.sceneId, ...cell(person.position), person.activity]) });
}

/**
 * Samples one actor's senses; it never mutates authority or refreshes unseen facts.
 * first/lastObservedAt in object/people records are world-time ISO instants.
 */
export function sampleCompanionWorldPerception(input: SampleCompanionWorldPerceptionInput): CompanionWorldPerception {
  const { self, environment } = input, scene = input.scenes.find(scene => scene.id === self.sceneId);
  if (!scene) throw new Error('伙伴感知所在的场景不存在。');
  if (![self.position.x, self.position.y, environment.light, environment.outdoorTemperature, environment.indoorTemperature].every(Number.isFinite)) throw new Error('伙伴感知位置或环境无效。');
  const observedAtReal = atIso(input.realAt), observedAtVirtual = atIso(input.virtualAt);
  const previous = input.previous?.companionId === self.companionId ? input.previous : undefined;
  const awake = self.activity !== 'sleeping', outdoors = scene.kind === 'commons', canSee = lineOfSight(scene, self.position);
  let light = clamp(environment.light, 0, 1);
  if (!outdoors) light = Math.max(.65, light);
  else if (!environment.daylight) for (const lamp of scene.objects.filter(object => object.kind === 'lamp')) {
    const distance = range(self.position, { x: lamp.position.x + (lamp.width - 1) / 2, y: lamp.position.y + (lamp.depth - 1) / 2 });
    if (distance < COMPANION_WORLD_PERCEPTION_LAMP_RADIUS && canSee(lamp.position, lamp.id)) light = Math.max(light, 1 - (distance / COMPANION_WORLD_PERCEPTION_LAMP_RADIUS) ** 2);
  }
  const radius = 4 + (COMPANION_WORLD_PERCEPTION_MAX_RADIUS - 4) * light;
  const objectDistances = new Map<string, number>();
  const seenObjects: CompanionWorldPerceivedObject[] = awake ? scene.objects.filter(object => {
    const distance = range(self.position, nearestFootprint(self.position, object)); objectDistances.set(object.id, distance);
    return footprintVisible(self.position, object, radius, canSee);
  }).sort((a, b) => objectDistances.get(a.id)! - objectDistances.get(b.id)! || a.id.localeCompare(b.id)).slice(0, COMPANION_WORLD_PERCEPTION_OBJECT_LIMIT).map(object => {
    const before = previous?.objects.find(known => known.sceneId === scene.id && known.id === object.id);
    return { sceneId: scene.id, id: object.id, kind: object.kind, name: object.name, position: { ...object.position }, width: object.width, depth: object.depth,
      anchor: { ...object.anchor }, blocking: object.blocking, firstObservedAt: before?.firstObservedAt ?? observedAtVirtual, lastObservedAt: observedAtVirtual, visible: true };
  }) : [];
  const seenPeople: CompanionWorldPerceivedPerson[] = awake ? input.actors.filter(actor => actor.companionId !== self.companionId && actor.sceneId === scene.id
    && range(self.position, actor.position) <= radius + 1e-8 && canSee(actor.position))
    .sort((a, b) => range(self.position, a.position) - range(self.position, b.position) || a.companionId.localeCompare(b.companionId)).slice(0, COMPANION_WORLD_PERCEPTION_PEOPLE_LIMIT)
    .map(actor => ({ companionId: actor.companionId, sceneId: actor.sceneId, position: { ...actor.position }, activity: actor.activity, lastObservedAt: observedAtVirtual, visible: true })) : [];
  const visibleObjectKeys = new Set(seenObjects.map(objectKey)), visiblePeople = new Set(seenPeople.map(person => person.companionId));
  const actualObjects = new Map(scene.objects.map(object => [object.id, object]));
  const objects = [...seenObjects, ...(previous?.objects ?? []).filter(object => {
    if (visibleObjectKeys.has(objectKey(object))) return false;
    if (!awake || object.sceneId !== scene.id) return true;
    const actual = actualObjects.get(object.id);
    const sameFootprint = actual && actual.position.x === object.position.x && actual.position.y === object.position.y && actual.width === object.width && actual.depth === object.depth;
    // Negative visual evidence: observing an empty old place invalidates the old
    // static location. It does not reveal where a moved object is now hidden.
    return sameFootprint || !footprintVisible(self.position, object, radius, canSee);
  })
    .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt) || objectKey(a).localeCompare(objectKey(b)))
    .slice(0, COMPANION_WORLD_PERCEPTION_OBJECT_LIMIT - seenObjects.length).map(object => ({ ...object, position: { ...object.position }, anchor: { ...object.anchor }, visible: false }))]
    .sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
  const people = [...seenPeople, ...(previous?.people ?? []).filter(person => !visiblePeople.has(person.companionId))
    .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt) || a.companionId.localeCompare(b.companionId))
    .slice(0, COMPANION_WORLD_PERCEPTION_PEOPLE_LIMIT - seenPeople.length).map(person => ({ ...person, position: { ...person.position }, visible: false }))]
    .sort((a, b) => a.companionId.localeCompare(b.companionId));
  const weatherKnown = awake && (outdoors || scene.objects.some(object => object.kind === 'door' && range(self.position, object.anchor) <= 3 && canSee(object.anchor, object.id)));
  // Reconfiguring an accelerated world to an earlier civil date invalidates a
  // weather observation from its former future. Static spatial memory survives.
  const weatherHistoryValid = previous?.environment.weather !== undefined && previous.environment.weatherObservedAtVirtual !== undefined
    && Date.parse(previous.environment.weatherObservedAtVirtual) <= Date.parse(observedAtVirtual) + 1;
  const weatherObservation = weatherKnown ? { weather: environment.weather, weatherObservedAtVirtual: observedAtVirtual, weatherObservedAtReal: observedAtReal, weatherSource: outdoors ? 'outdoors' as const : 'door' as const }
    : weatherHistoryValid && previous ? { weather: previous.environment.weather, weatherObservedAtVirtual: previous.environment.weatherObservedAtVirtual,
      weatherObservedAtReal: previous.environment.weatherObservedAtReal, weatherSource: previous.environment.weatherSource } : {};
  const result: CompanionWorldPerception = { companionId: self.companionId, sceneId: scene.id, position: { ...self.position }, activity: self.activity, radius, awake,
    observedAtReal, observedAtVirtual, environment: { time: observedAtVirtual, light, temperature: outdoors ? environment.outdoorTemperature : environment.indoorTemperature, daylight: environment.daylight, ...weatherObservation },
    visibleObjectIds: seenObjects.map(object => object.id).sort(), visibleCompanionIds: seenPeople.map(person => person.companionId).sort(), objects, people, revision: previous?.revision ?? 0 };
  if (!previous || companionWorldPerceptionSignature(result) !== companionWorldPerceptionSignature(previous)) result.revision++;
  return result;
}
