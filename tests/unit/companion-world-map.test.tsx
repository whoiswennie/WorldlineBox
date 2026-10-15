// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { createCompanionWorldCommons, createCompanionWorldHome } from '../../src/shared/companion-world-engine';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import { WorldNeighborhoodMap } from '../../src/renderer/companions/world/WorldNeighborhoodMap';
import { worldMapGarden, worldNeighborhoodLayout, worldOutdoorRoute } from '../../src/renderer/companions/world/world-map-layout';

it('uses actual building and entrance coordinates and expands with additional homes', () => {
  const homes = Array.from({ length: 40 }, (_, index) => createCompanionWorldHome('resident-' + index, index));
  const commons = createCompanionWorldCommons(homes), layout = worldNeighborhoodLayout(commons, homes);
  expect(layout.homes).toHaveLength(40); expect(layout.height).toBe(commons.depth);
  for (const home of layout.homes) {
    const building = commons.objects.find(object => object.id === home.ownerId + '_building')!;
    const entrance = commons.objects.find(object => object.id === home.ownerId + '_entrance')!;
    expect(home.entrance).toEqual(entrance.anchor);
    expect(home.center).toEqual({ x: building.position.x + building.width / 2, y: building.position.y + building.depth / 2 });
    for (const x of layout.streets.vertical) expect(x <= building.position.x || x >= building.position.x + building.width).toBe(true);
    for (const y of layout.streets.horizontal) expect(y <= building.position.y || y >= building.position.y + building.depth).toBe(true);
  }
});

it('does not invent an outdoor home for an absent host building or draw private portal route segments', () => {
  const homes = [createCompanionWorldHome('one', 0), createCompanionWorldHome('two', 1)];
  const commons = createCompanionWorldCommons(homes);
  commons.objects = commons.objects.filter(object => object.id !== 'two_building');
  expect(worldNeighborhoodLayout(commons, homes).homes.map(home => home.ownerId)).toEqual(['one']);
  const actor = { sceneId: commons.id, position: { x: 14, y: 20 }, route: [{ sceneId: commons.id, x: 14, y: 21 }, { sceneId: 'home_one', x: 10, y: 15 }, { sceneId: commons.id, x: 90, y: 50 }] };
  expect(worldOutdoorRoute(actor, commons.id)).toEqual([{ x: 14, y: 20 }, { x: 14, y: 21 }]);
  expect(worldOutdoorRoute({ ...actor, sceneId: 'home_one' }, commons.id)).toEqual([]);
});

it('renders family entries and the exact host outdoor position, direction and route without exposing indoor actors', () => {
  const homes = [createCompanionWorldHome('one', 0), createCompanionWorldHome('two', 1)], commons = createCompanionWorldCommons(homes), at = '2026-10-15T02:00:00.000Z';
  const actor = { companionId: 'one', sceneId: commons.id, homeSceneId: homes[0]!.id, position: { x: 14.25, y: 21 }, facing: 'east' as const, frame: 0 as const, activity: 'walking' as const,
    activityStartedAtReal: at, artAction: 'walk' as const, locomotion: 'walk' as const, movementSpeed: 2.4,
    state: { energy: 80, mood: 'calm' as const, expression: 'gentle' as const, affect: { pleasure: 0, arousal: 0, dominance: 0 }, thermalComfort: 1 }, route: [{ sceneId: commons.id, x: 38, y: 21 }], routinePhase: 'awake' as const };
  const snapshot: CompanionWorldSnapshot = { settings: { revision: 1, mode: 'realtime', dayDurationMinutes: 20, timeZone: 'Asia/Shanghai' }, clock: { realNow: at, virtualNow: at, hour: 10, day: 1, daylight: true, speed: 1 },
    environment: { weather: 'clear', light: 1, outdoorTemperature: 22, indoorTemperature: 22 }, actors: [actor, { ...actor, companionId: 'two', sceneId: homes[1]!.id }], scenes: [commons, ...homes], residents: [], events: [], visits: [], works: [], relationships: [], lastEventSequence: 0, backlog: false };
  const html = renderToStaticMarkup(<WorldNeighborhoodMap snapshot={snapshot} scene={commons} companions={[{ id: 'one', name: '甲', avatar: 'sister' }, { id: 'two', name: '乙', avatar: 'flash' }]} onOpenHome={() => undefined} onFollow={() => undefined} />);
  const holder = document.createElement('div'); holder.innerHTML = html;
  expect(holder.querySelectorAll('[data-world-map-home]')).toHaveLength(2);
  expect(holder.querySelectorAll('[data-world-map-actor]')).toHaveLength(1);
  expect(holder.querySelector('[data-world-map-actor]')?.getAttribute('data-world-position')).toBe('14.25,21');
  expect(holder.querySelector('[data-world-map-actor]')?.getAttribute('data-world-facing')).toBe('east');
  expect(holder.querySelector('[data-world-map-route]')?.getAttribute('points')).toBe('14.25,21 38,21');
  expect(html).toContain('观察乙的小屋'); expect(html).not.toContain('<canvas');
  const garden = worldMapGarden(commons)!;
  expect(holder.querySelector('[data-world-map-garden]')?.textContent).toContain('公共花园');
  for (const object of [...garden.trees, ...garden.benches]) {
    expect(holder.querySelector(`[data-world-map-furniture="${object.id}"]`)).not.toBeNull();
    expect(object.position.x).toBeGreaterThanOrEqual(garden.x); expect(object.position.y).toBeGreaterThanOrEqual(garden.y);
    expect(object.position.x + object.width).toBeLessThanOrEqual(garden.x + garden.width);
    expect(object.position.y + object.depth).toBeLessThanOrEqual(garden.y + garden.height);
  }
});
