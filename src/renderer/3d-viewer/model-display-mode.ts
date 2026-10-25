import {
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Material,
  type Scene,
  type Side,
} from 'three';

/**
 * Model display modes (WorldlineBox-fkhe): PBR / PBR+wireframe / gray-shaded /
 * gray-shaded+wireframe / pure wireframe.
 *
 * Pure function over a three Scene so it is unit-testable without a renderer:
 * - `pbr` restores materials (wireframe off, no override);
 * - `pbr-wireframe` toggles `material.wireframe` on the real materials so
 *   textures stay visible under the overlay;
 * - the shaded modes install `scene.overrideMaterial` (a neutral standard
 *   material), which never mutates the model's own materials;
 * - `wireframe` uses a basic unlit material for crisp lines.
 */
export const MODEL_DISPLAY_MODES = [
  'pbr',
  'pbr-wireframe',
  'shaded',
  'shaded-wireframe',
  'wireframe',
] as const;

export type ModelDisplayMode = (typeof MODEL_DISPLAY_MODES)[number];

export const DEFAULT_DISPLAY_MODE: ModelDisplayMode = 'pbr';

export interface DisplayModeOptions {
  /** Draw both faces. The material's own side is restored when this is off. */
  readonly doubleSided?: boolean;
}

const originalSides = new WeakMap<Material, Side>();

/** Neutral gray used by the shaded (gray) modes. */
export const SHADED_GRAY = 0x9aa0a6;
/** Wire color for the pure-wireframe mode. */
export const WIREFRAME_GRAY = 0xcccccc;

function setWireframeOn(material: Material, wireframe: boolean): void {
  if ('wireframe' in material) material.wireframe = wireframe;
}

function setAllWireframe(material: Material | Material[], wireframe: boolean): void {
  if (Array.isArray(material)) {
    for (const entry of material) setWireframeOn(entry, wireframe);
  } else {
    setWireframeOn(material, wireframe);
  }
}

function resetScene(scene: Scene): void {
  if (scene.overrideMaterial !== null) {
    scene.overrideMaterial.dispose();
    scene.overrideMaterial = null;
  }
  scene.traverse((object) => {
    const mesh = object as { material?: Material | Material[] };
    if (mesh.material !== undefined) setAllWireframe(mesh.material, false);
  });
}

function applySide(material: Material, doubleSided: boolean): void {
  if (doubleSided) {
    if (!originalSides.has(material)) originalSides.set(material, material.side);
    if (material.side !== DoubleSide) {
      material.side = DoubleSide;
      material.needsUpdate = true;
    }
    return;
  }
  const original = originalSides.get(material);
  if (original === undefined) return;
  originalSides.delete(material);
  if (material.side !== original) {
    material.side = original;
    material.needsUpdate = true;
  }
}

function applySideToAll(material: Material | Material[], doubleSided: boolean): void {
  if (Array.isArray(material)) {
    for (const entry of material) applySide(entry, doubleSided);
  } else {
    applySide(material, doubleSided);
  }
}

/** Apply a display mode; always idempotent and safe to call repeatedly. */
export function applyDisplayMode(
  scene: Scene,
  mode: ModelDisplayMode,
  options: DisplayModeOptions = {},
): void {
  const doubleSided = options.doubleSided === true;
  resetScene(scene);
  scene.traverse((object) => {
    const mesh = object as { material?: Material | Material[] };
    if (mesh.material !== undefined) applySideToAll(mesh.material, doubleSided);
  });
  const side: Side = doubleSided ? DoubleSide : FrontSide;
  switch (mode) {
    case 'pbr':
      return;
    case 'pbr-wireframe':
      scene.traverse((object) => {
        const mesh = object as { material?: Material | Material[] };
        if (mesh.material !== undefined) setAllWireframe(mesh.material, true);
      });
      return;
    case 'shaded':
      scene.overrideMaterial = new MeshStandardMaterial({
        color: SHADED_GRAY,
        roughness: 0.85,
        metalness: 0,
        side,
      });
      return;
    case 'shaded-wireframe':
      scene.overrideMaterial = new MeshStandardMaterial({
        color: SHADED_GRAY,
        roughness: 0.85,
        metalness: 0,
        wireframe: true,
        side,
      });
      return;
    case 'wireframe':
      scene.overrideMaterial = new MeshBasicMaterial({
        color: WIREFRAME_GRAY,
        wireframe: true,
        side,
      });
      return;
  }
}
