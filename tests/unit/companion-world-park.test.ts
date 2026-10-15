import { describe, expect, it } from 'vitest';
import { companionWorldCellWalkable, createCompanionWorldCommons, createCompanionWorldHome, findCompanionWorldPath } from '../../src/shared/companion-world-engine';
import { companionWorldParkCircuit, companionWorldParkContains, companionWorldParkLayout } from '../../src/shared/companion-world-park';

describe('one physically reachable public garden', () => {
  it('keeps the garden lots free and both seating anchors reachable as households grow', () => {
    const homes = Array.from({ length: 40 }, (_, index) => createCompanionWorldHome('resident_' + index, index));
    const commons = createCompanionWorldCommons(homes), garden = companionWorldParkLayout(commons)!;
    expect(garden.benches).toHaveLength(2); expect(garden.trees).toHaveLength(3);
    expect(commons.objects.filter(object => object.kind === 'fountain')).toHaveLength(1);
    expect(commons.objects.filter(object => object.kind === 'lamp')).toHaveLength(6);
    for (const object of commons.objects.filter(object => object.kind === 'fountain' || object.kind === 'lamp')) {
      expect(companionWorldCellWalkable(commons, object.position)).toBe(false);
      expect(companionWorldCellWalkable(commons, object.anchor)).toBe(true);
    }
    for (const building of commons.objects.filter(object => object.kind === 'building')) {
      expect(building.position.x + building.width <= garden.x || building.position.x >= garden.x + garden.width
        || building.position.y + building.depth <= garden.y || building.position.y >= garden.y + garden.height).toBe(true);
    }
    for (const home of homes) for (const bench of garden.benches) {
      const from = { x: home.origin.x + 10, y: home.origin.y + 16 }, route = findCompanionWorldPath(commons, from, bench.anchor)!;
      expect(route.length).toBeGreaterThan(0); expect(route.at(-1)).toEqual({ ...bench.anchor, sceneId: commons.id });
      expect(route.every(point => companionWorldCellWalkable(commons, point))).toBe(true);
      for (let index = 0; index < route.length; index++) {
        const previous = index ? route[index - 1]! : from;
        expect(Math.abs(route[index]!.x - previous.x) + Math.abs(route[index]!.y - previous.y)).toBe(1);
      }
    }
  }, 20000);

  it('walks a closed cardinal promenade that never crosses furniture or leaves the real garden', () => {
    const commons = createCompanionWorldCommons([]), bounds = companionWorldParkLayout(commons)!, circuit = companionWorldParkCircuit(commons);
    expect(circuit).toHaveLength(4);
    let length = 0;
    for (let index = 0; index < circuit.length; index++) {
      const route = findCompanionWorldPath(commons, circuit[index]!, circuit[(index + 1) % circuit.length]!)!;
      length += route.length;
      expect(route.every(point => companionWorldParkContains(bounds, point) && companionWorldCellWalkable(commons, point))).toBe(true);
    }
    expect(length).toBeGreaterThan(100);
    expect(companionWorldParkLayout(createCompanionWorldHome('indoor', 0))).toBeUndefined();
    const blocked = structuredClone(commons);
    blocked.objects.push({ id: 'promenade_block', kind: 'building', name: '封闭区域', position: { x: bounds.x, y: bounds.y },
      width: bounds.width, depth: bounds.height, anchor: { x: bounds.x, y: bounds.y }, blocking: true });
    expect(companionWorldParkCircuit(blocked)).toEqual([]);
  });

  it('physically escapes a solid added around an old saved position and never re-enters that solid', () => {
    const commons = createCompanionWorldCommons([]), from = { x: 120, y: 54 }, target = { x: 106, y: 62 };
    expect(companionWorldCellWalkable(commons, from)).toBe(false);
    expect(findCompanionWorldPath(commons, from, target)).toBeUndefined();
    const route = findCompanionWorldPath(commons, from, target, true)!;
    expect(route.length).toBeGreaterThan(0); expect(route.at(-1)).toEqual({ ...target, sceneId: commons.id });
    let outside = false, previous = from;
    for (const point of route) {
      expect(Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y)).toBe(1);
      if (companionWorldCellWalkable(commons, point)) outside = true;
      if (outside) expect(companionWorldCellWalkable(commons, point)).toBe(true);
      previous = point;
    }
    expect(outside).toBe(true);
  });
});
