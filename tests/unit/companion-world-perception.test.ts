import { describe, expect, it } from 'vitest';
import { companionWorldPerceptionSchema, companionWorldPerceptionSignature, sampleCompanionWorldPerception,
  COMPANION_WORLD_PERCEPTION_INTERVAL_MS, type SampleCompanionWorldPerceptionInput } from '../../src/shared/companion-world-perception';
import type { CompanionWorldScene } from '../../src/shared/companion-world';

const realAt = '2026-10-15T01:00:00.000Z', virtualAt = '2098-04-10T10:00:00.000Z';
const laterReal = '2026-10-15T01:00:01.000Z', laterVirtual = '2098-04-10T10:01:12.000Z';
type Actor = SampleCompanionWorldPerceptionInput['self'];
function actor(companionId: string, x: number, y: number, sceneId = 'park', activity: Actor['activity'] = 'idle'): Actor { return { companionId, sceneId, position: { x, y }, activity }; }
function object(id: string, x: number, y: number, kind: CompanionWorldScene['objects'][number]['kind'] = 'chair', width = 1, depth = 1): CompanionWorldScene['objects'][number] {
  return { id, kind, name: id, position: { x, y }, width, depth, anchor: { x, y: y + depth }, blocking: !['chair', 'door', 'habit'].includes(kind) };
}
function scene(id = 'park', objects: CompanionWorldScene['objects'] = [], kind: CompanionWorldScene['kind'] = 'park'): CompanionWorldScene {
  return { id, kind, name: id, width: 100, depth: 100, origin: { x: 0, y: 0 }, door: { x: 0, y: 0 }, objects };
}
function input(patch: Partial<SampleCompanionWorldPerceptionInput> = {}): SampleCompanionWorldPerceptionInput {
  return { self: actor('alice', 10, 10), scenes: [scene()], actors: [], environment: { light: 1, daylight: true, weather: 'clear', outdoorTemperature: 19, indoorTemperature: 22 }, virtualAt, realAt, ...patch };
}

describe('bounded subjective world perception', () => {
  it('has a one-second sampling contract and a strict serializable current schema', () => {
    const result = sampleCompanionWorldPerception(input());
    expect(COMPANION_WORLD_PERCEPTION_INTERVAL_MS).toBe(1000); expect(companionWorldPerceptionSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ companionId: 'alice', sceneId: 'park', awake: true, radius: 10, activity: 'idle', revision: 1,
      environment: { time: virtualAt, temperature: 19, light: 1, weather: 'clear', weatherSource: 'outdoors', weatherObservedAtVirtual: virtualAt, weatherObservedAtReal: realAt } });
    expect(() => companionWorldPerceptionSchema.parse({ ...result, omniscientActors: [] })).toThrow();
  });

  it('uses circular physical range and nearest furniture footprint, never a conveniently near anchor', () => {
    const near = object('near_edge', 20, 10), far = object('far', 21, 10), corner = object('diagonal', 18, 18), large = object('large_visible_edge', 20, 6, 'building', 8, 2);
    far.anchor = { x: 10, y: 10 };
    const result = sampleCompanionWorldPerception(input({ scenes: [scene('park', [near, far, corner, large])], actors: [actor('near_peer', 20, 10), actor('far_peer', 20.01, 10), actor('diagonal_peer', 18, 18)] }));
    expect(result.visibleObjectIds).toContain('near_edge'); expect(result.visibleObjectIds).toContain('large_visible_edge');
    expect(result.visibleObjectIds).not.toContain('far'); expect(result.visibleObjectIds).not.toContain('diagonal');
    expect(result.visibleCompanionIds).toEqual(['near_peer']);
  });

  it('isolates different scenes, even when local coordinates and an entrance are identical', () => {
    const result = sampleCompanionWorldPerception(input({ scenes: [scene('park', [object('public_door', 10, 11, 'door')]), scene('home_bob', [object('private_computer', 10, 10, 'computer')], 'home')],
      actors: [actor('self_duplicate', 10, 10, 'home_bob'), actor('bob', 10, 10, 'home_bob'), actor('alice', 10, 10)] }));
    expect(result.visibleObjectIds).toEqual(['public_door']); expect(result.visibleCompanionIds).toEqual([]); expect(JSON.stringify(result)).not.toContain('private_computer');
  });

  it('blocks bodies and objects behind solid trees or buildings, while recognizing the blocking object itself', () => {
    const tree = object('tree', 14, 9, 'tree', 2, 3), obscured = object('behind_tree', 18, 10);
    const result = sampleCompanionWorldPerception(input({ scenes: [scene('park', [tree, obscured])], actors: [actor('hidden', 18, 10), actor('unobscured', 10, 17)] }));
    expect(result.visibleObjectIds).toContain('tree'); expect(result.visibleObjectIds).not.toContain('behind_tree');
    expect(result.visibleCompanionIds).toEqual(['unobscured']);
  });

  it('does not peek through a blocked diagonal grid corner', () => {
    const result = sampleCompanionWorldPerception(input({ self: actor('alice', 10, 10), scenes: [scene('park', [object('east_tree', 11, 10, 'tree'), object('south_tree', 10, 11, 'tree')])], actors: [actor('hidden', 12, 12)] }));
    expect(result.visibleCompanionIds).toEqual([]); expect(result.visibleObjectIds).toEqual(['east_tree', 'south_tree']);
  });

  it('sees the desktop computer from its real working anchor instead of treating the desk as a high wall', () => {
    const home = scene('home_alice', [object('desk', 2, 2, 'desk', 5, 2), { ...object('computer', 4, 2, 'computer'), blocking: false }], 'home');
    const result = sampleCompanionWorldPerception(input({ self: actor('alice', 4, 4, home.id), scenes: [home] }));
    expect(result.visibleObjectIds).toContain('desk'); expect(result.visibleObjectIds).toContain('computer');
  });

  it('looks over low beds and sofas while retaining opaque buildings and trees', () => {
    for (const kind of ['bed', 'sofa'] as const) {
      const result = sampleCompanionWorldPerception(input({ scenes: [scene('park', [object('low_furniture', 14, 9, kind, 2, 3)])], actors: [actor('bob', 18, 10)] }));
      expect(result.visibleCompanionIds, kind).toEqual(['bob']);
    }
    for (const kind of ['building', 'tree'] as const) {
      const result = sampleCompanionWorldPerception(input({ scenes: [scene('park', [object('tall_obstacle', 14, 9, kind, 2, 3)])], actors: [actor('bob', 18, 10)] }));
      expect(result.visibleObjectIds, kind).toContain('tall_obstacle'); expect(result.visibleCompanionIds, kind).toEqual([]);
    }
  });

  it('contracts sight in darkness, uses actual nearby night lamps, and turns their contribution off in daytime', () => {
    const dark = { light: 0, daylight: false, weather: 'clear' as const, outdoorTemperature: 16, indoorTemperature: 21 }, actors = [actor('bob', 16, 10)];
    const baseline = sampleCompanionWorldPerception(input({ environment: dark, actors })); expect(baseline.radius).toBe(4); expect(baseline.visibleCompanionIds).toEqual([]);
    const lit = sampleCompanionWorldPerception(input({ environment: dark, scenes: [scene('park', [object('actual_lamp', 16, 10, 'lamp')])], actors }));
    expect(lit.radius).toBeGreaterThan(7); expect(lit.radius).toBeLessThanOrEqual(10); expect(lit.visibleCompanionIds).toEqual(['bob']);
    const tooFar = sampleCompanionWorldPerception(input({ environment: dark, scenes: [scene('park', [object('far_lamp', 20, 10, 'lamp')])], actors })); expect(tooFar.radius).toBe(4);
    const day = sampleCompanionWorldPerception(input({ environment: { ...dark, daylight: true }, scenes: [scene('park', [object('actual_lamp', 16, 10, 'lamp')])], actors })); expect(day.radius).toBe(4);
  });

  it('does not borrow light through a solid tree and provides a minimum indoor local light', () => {
    const environment = { light: 0, daylight: false, weather: 'rain' as const, outdoorTemperature: 9, indoorTemperature: 22 };
    const obscured = sampleCompanionWorldPerception(input({ environment, scenes: [scene('park', [object('tree', 13, 9, 'tree', 1, 3), object('lamp', 16, 10, 'lamp')])] })); expect(obscured.radius).toBe(4);
    const indoors = sampleCompanionWorldPerception(input({ self: actor('alice', 10, 10, 'home_alice'), environment, scenes: [scene('home_alice', [], 'home')] }));
    expect(indoors.environment).toMatchObject({ light: .65, temperature: 22 }); expect(indoors.radius).toBeGreaterThan(7); expect(indoors.environment.weather).toBeUndefined();
  });

  it('keeps unseen objects and people frozen at the last observation instead of refreshing their real hidden state', () => {
    const before = sampleCompanionWorldPerception(input({ scenes: [scene('park', [object('bench', 12, 10, 'bench', 3)])], actors: [actor('bob', 11, 10)] }));
    const changedBench = { ...object('bench', 12, 10, 'bench', 3), name: '改过名字且被占用', occupantId: 'secret', reservedBy: 'secret' };
    const after = sampleCompanionWorldPerception(input({ self: actor('alice', 80, 80), scenes: [scene('park', [changedBench])], actors: [actor('bob', 70, 70, 'park', 'working')], previous: before, realAt: laterReal, virtualAt: laterVirtual }));
    expect(after.visibleObjectIds).toEqual([]); expect(after.visibleCompanionIds).toEqual([]);
    expect(after.objects[0]).toEqual({ ...before.objects[0]!, visible: false }); expect(after.people[0]).toEqual({ ...before.people[0]!, visible: false });
    expect(JSON.stringify(after)).not.toContain('secret'); expect(after.objects[0]!.name).toBe('bench');
  });

  it('does not update visual facts while sleeping, but marks prior facts unseen and preserves weather provenance', () => {
    const before = sampleCompanionWorldPerception(input({ scenes: [scene('park', [object('nearby', 12, 10)])], actors: [actor('bob', 11, 10)] }));
    const sleeping = sampleCompanionWorldPerception(input({ self: actor('alice', 10, 10, 'park', 'sleeping'), scenes: [scene('park', [object('new_object', 11, 10)])], actors: [actor('new_peer', 11, 10)], previous: before,
      environment: { light: .1, daylight: false, weather: 'rain', outdoorTemperature: 7, indoorTemperature: 22 }, virtualAt: laterVirtual, realAt: laterReal }));
    expect(sleeping.awake).toBe(false); expect(sleeping.visibleObjectIds).toEqual([]); expect(sleeping.visibleCompanionIds).toEqual([]);
    expect(sleeping.objects).toEqual([{ ...before.objects[0]!, visible: false }]); expect(sleeping.people).toEqual([{ ...before.people[0]!, visible: false }]);
    expect(sleeping.environment).toMatchObject({ time: laterVirtual, temperature: 7, weather: 'clear', weatherSource: 'outdoors', weatherObservedAtVirtual: virtualAt, weatherObservedAtReal: realAt });
  });

  it('invalidates an observed empty old furniture location without learning its hidden new location or removing distant memories', () => {
    const far = object('far_memory', 80, 80), near = object('near_memory', 12, 10);
    const first = sampleCompanionWorldPerception(input({ self: actor('alice', 80, 80), scenes: [scene('park', [far, near])] }));
    const previous = sampleCompanionWorldPerception(input({ scenes: [scene('park', [far, near])], previous: first })); expect(previous.objects).toHaveLength(2);
    const moved = { ...near, position: { x: 70, y: 70 }, anchor: { x: 70, y: 71 } };
    const result = sampleCompanionWorldPerception(input({ scenes: [scene('park', [moved])], previous, realAt: laterReal, virtualAt: laterVirtual }));
    expect(result.objects.map(object => object.id)).toEqual(['far_memory']); expect(result.objects[0]).toEqual({ ...previous.objects.find(object => object.id === 'far_memory')!, visible: false });
    expect(result.visibleObjectIds).toEqual([]); expect(JSON.stringify(result)).not.toContain('70');
    const blocked = sampleCompanionWorldPerception(input({ scenes: [scene('park', [object('new_wall', 11, 9, 'tree', 1, 3)])], previous, realAt: laterReal, virtualAt: laterVirtual }));
    expect(blocked.objects.some(object => object.id === 'near_memory' && !object.visible)).toBe(true);
  });

  it('observes indoor weather only at an unobstructed nearby door and retains explicit old weather elsewhere', () => {
    const home = scene('home_alice', [object('door', 10, 15, 'door')], 'home'), environment = { light: .5, daylight: true, weather: 'rain' as const, outdoorTemperature: 11, indoorTemperature: 22 };
    const unknown = sampleCompanionWorldPerception(input({ self: actor('alice', 1, 1, home.id), scenes: [home], environment })); expect(unknown.environment.weather).toBeUndefined();
    const atDoor = sampleCompanionWorldPerception(input({ self: actor('alice', 10, 14, home.id), scenes: [home], environment, previous: unknown }));
    expect(atDoor.environment).toMatchObject({ weather: 'rain', weatherSource: 'door', weatherObservedAtVirtual: virtualAt });
    const away = sampleCompanionWorldPerception(input({ self: actor('alice', 1, 1, home.id), scenes: [home], environment: { ...environment, weather: 'clear' }, previous: atDoor, realAt: laterReal, virtualAt: laterVirtual }));
    expect(away.environment).toMatchObject({ weather: 'rain', weatherSource: 'door', weatherObservedAtVirtual: virtualAt });
  });

  it('invalidates weather from the former future after the world clock moves backward, without inventing clear weather or erasing spatial memory', () => {
    const previous = sampleCompanionWorldPerception(input({ scenes: [scene('park', [object('remembered_bench', 12, 10, 'bench', 3)])],
      environment: { light: .5, daylight: true, weather: 'rain', outdoorTemperature: 12, indoorTemperature: 22 } }));
    const home = scene('home_alice', [], 'home'), earlier = '2098-04-09T10:00:00.000Z';
    const result = sampleCompanionWorldPerception(input({ self: actor('alice', 10, 10, home.id), scenes: [home], virtualAt: earlier, realAt: laterReal, previous }));
    expect(result.environment.weather).toBeUndefined(); expect(result.environment.weatherSource).toBeUndefined(); expect(result.environment.weatherObservedAtVirtual).toBeUndefined(); expect(result.environment.weatherObservedAtReal).toBeUndefined();
    expect(result.environment).toMatchObject({ time: earlier, temperature: 22 }); expect(result.objects).toEqual(previous.objects.map(object => ({ ...object, visible: false })));
    const again = sampleCompanionWorldPerception(input({ self: actor('alice', 10, 10, home.id), scenes: [home], virtualAt: earlier, realAt: laterReal, previous: result }));
    expect(again.environment.weather).toBeUndefined(); expect(companionWorldPerceptionSchema.safeParse(again).success).toBe(true);
  });

  it('copies static furniture appearance only, without leaking occupancy, reservations or live private routes', () => {
    const furniture = { ...object('computer', 11, 10, 'computer'), occupantId: 'private_owner', reservedBy: 'secret_work' };
    const result = sampleCompanionWorldPerception(input({ scenes: [scene('park', [furniture])], actors: [{ ...actor('bob', 12, 10), route: [{ sceneId: 'home_secret', x: 10, y: 10 }], state: { energy: 1 }, privateNotes: 'private' } as Actor] }));
    expect(result.objects[0]).not.toHaveProperty('occupantId'); expect(result.objects[0]).not.toHaveProperty('reservedBy'); expect(result.people[0]).not.toHaveProperty('state'); expect(result.people[0]).not.toHaveProperty('route');
    expect(companionWorldPerceptionSchema.safeParse(result).success).toBe(true);
  });

  it('bounds current and remembered knowledge, prioritizes current sightings and orders them independently of input order', () => {
    const many = Array.from({ length: 400 }, (_, index) => object('old_' + index, 10 + index % 20 / 10, 10 + Math.floor(index / 20) / 10));
    const peers = Array.from({ length: 100 }, (_, index) => actor('peer_' + index, 10 + index / 100, 11));
    const before = sampleCompanionWorldPerception(input({ scenes: [scene('park', many)], actors: peers }));
    expect(before.objects).toHaveLength(256); expect(before.visibleObjectIds).toHaveLength(256); expect(before.people).toHaveLength(64);
    const newer = many.map(object => ({ ...object, id: object.id.replace('old_', 'new_') }));
    const after = sampleCompanionWorldPerception(input({ scenes: [scene('park', newer)], actors: peers, previous: before, realAt: laterReal, virtualAt: laterVirtual }));
    expect(after.objects).toHaveLength(256); expect(after.objects.every(object => object.id.startsWith('new_') && object.visible)).toBe(true);
    const reordered = sampleCompanionWorldPerception(input({ scenes: [scene('park', [...newer].reverse())], actors: [...peers].reverse(), previous: after, realAt: laterReal, virtualAt: laterVirtual }));
    expect(reordered).toEqual(after); expect(companionWorldPerceptionSchema.safeParse(after).success).toBe(true);
  });

  it('changes revision for meaningful activity, scene, visible sets and environment bands rather than every clock or tiny movement', () => {
    const before = sampleCompanionWorldPerception(input({ self: actor('alice', 10.1, 10.1), actors: [actor('bob', 12.1, 10)] }));
    const tinyStep = sampleCompanionWorldPerception(input({ self: actor('alice', 10.2, 10.1), actors: [actor('bob', 12.2, 10)], previous: before, realAt: laterReal, virtualAt: laterVirtual }));
    expect(tinyStep.revision).toBe(before.revision); expect(companionWorldPerceptionSignature(tinyStep)).toBe(companionWorldPerceptionSignature(before)); expect(tinyStep.people[0]!.lastObservedAt).toBe(laterVirtual);
    const walking = sampleCompanionWorldPerception(input({ self: actor('alice', 10.2, 10.1, 'park', 'walking'), actors: [actor('bob', 12.2, 10)], previous: tinyStep })); expect(walking.revision).toBe(before.revision + 1);
    const moved = sampleCompanionWorldPerception(input({ self: actor('alice', 12.2, 10.1), actors: [actor('bob', 12.2, 10)], previous: tinyStep })); expect(moved.revision).toBe(before.revision + 1);
    const warmer = sampleCompanionWorldPerception(input({ previous: before, environment: { light: 1, daylight: true, weather: 'clear', outdoorTemperature: 22, indoorTemperature: 22 } })); expect(warmer.revision).toBe(before.revision + 1);
  });

  it('does not accept a different companion prior record as its own memory', () => {
    const other = sampleCompanionWorldPerception(input({ scenes: [scene('park', [object('private_known', 11, 10)])] }));
    const result = sampleCompanionWorldPerception(input({ self: actor('bob', 10, 10), previous: other })); expect(result.objects).toEqual([]); expect(result.revision).toBe(1);
  });
});
