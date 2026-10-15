import { expect, it, vi } from 'vitest';
import { Mesh, Points, type MeshStandardMaterial } from 'three';
import { createCompanionWorldCommons, createCompanionWorldHome } from '../../src/shared/companion-world-engine';
import { companionWorldParkLayout } from '../../src/shared/companion-world-park';
import { createWorldParkModel } from '../../src/renderer/companions/world/world-park-model';

it('batches the real park furniture, bounds animated water and releases every resource', () => {
  const homes = Array.from({ length: 15 }, (_, index) => createCompanionWorldHome('resident_' + index, index));
  const commons = createCompanionWorldCommons(homes), model = createWorldParkModel(commons), expected = companionWorldParkLayout(commons)!;
  expect(model.bounds).toEqual(expected); expect(model.stats.furnitureCount).toBe(12);
  expect(model.stats.drawCalls).toBeLessThanOrEqual(9); expect(model.stats.triangles).toBeGreaterThan(5000); expect(model.stats.triangles).toBeLessThan(55000);
  expect(model.stats.waterParticles).toBe(216); expect(model.animate(1000)).toBe(true);
  expect(model.group.children.every(child => (child instanceof Mesh || child instanceof Points) && !child.matrixAutoUpdate)).toBe(true);
  for (const child of model.group.children as Array<Mesh | Points>) {
    expect([...child.geometry.getAttribute('position').array].every(Number.isFinite)).toBe(true);
    child.geometry.computeBoundingBox(); const box = child.geometry.boundingBox!.clone().applyMatrix4(child.matrix);
    expect(box.min.x).toBeGreaterThan(expected.x - 2); expect(box.max.x).toBeLessThan(expected.x + expected.width + 2);
    expect(box.min.z).toBeGreaterThan(expected.y - 2); expect(box.max.z).toBeLessThan(expected.y + expected.height + 2);
  }
  for (const bench of expected.benches) expect(model.group.userData[bench.id]).toMatchObject({ anchor: bench.anchor, seatHeight: .57 });
  for (const tree of expected.trees) expect(model.group.userData[tree.id]).toMatchObject({ footprint: { ...tree.position, width: tree.width, depth: tree.depth } });
  const meshes = model.group.children as Mesh[], light = meshes.find(mesh => mesh.name === 'garden-lantern')!.material as MeshStandardMaterial, pools = meshes.find(mesh => mesh.name === 'garden-light-pools')!;
  const geometryDisposals = meshes.map(mesh => vi.spyOn(mesh.geometry, 'dispose')), materialDisposals = meshes.map(mesh => vi.spyOn(mesh.material as MeshStandardMaterial, 'dispose'));
  model.setNight(true); expect(light.emissiveIntensity).toBe(1.15); expect(pools.visible).toBe(true); model.setNight(false); expect(light.emissiveIntensity).toBe(0); expect(pools.visible).toBe(false);
  model.dispose(); model.dispose(); expect(model.animate(2000)).toBe(false); geometryDisposals.forEach(dispose => expect(dispose).toHaveBeenCalledOnce()); materialDisposals.forEach(dispose => expect(dispose).toHaveBeenCalledOnce()); expect(model.group.children).toHaveLength(0);
});

it('never invents a park or furniture inside a private home', () => {
  const model = createWorldParkModel(createCompanionWorldHome('resident', 0));
  expect(model.bounds).toBeUndefined(); expect(model.stats.drawCalls).toBe(0); expect(model.group.children).toHaveLength(0); model.dispose();
});
