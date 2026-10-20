// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { Mesh } from 'three';
import { createCompanionWorldHome } from '../../src/shared/companion-world-engine';
import { createWorldRoomModel } from '../../src/renderer/companions/world/world-room-model';

it('batches canonical furniture into bounded valid static meshes and releases all GPU resources', () => {
  const home = createCompanionWorldHome('resident'), model = createWorldRoomModel(home);
  const meshes = model.group.children.filter((child): child is Mesh => child instanceof Mesh);
  expect(meshes.length).toBeGreaterThan(8); expect(meshes.length).toBeLessThanOrEqual(24);
  expect(meshes.reduce((count, mesh) => count + mesh.geometry.attributes.position!.count, 0)).toBeGreaterThan(2000);
  for (const mesh of meshes) { expect([...mesh.geometry.attributes.position!.array].every(Number.isFinite)).toBe(true); }
  const disposals = meshes.map(mesh => vi.spyOn(mesh.geometry, 'dispose'));
  model.dispose(); disposals.forEach(dispose => expect(dispose).toHaveBeenCalledOnce()); expect(model.group.children).toHaveLength(0);
});
