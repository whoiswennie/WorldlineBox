/**
 * Upload OpenImageIO-decoded FBX textures.
 *
 * The mesh file still carries vertices and indices. Textures the browser
 * cannot decode are raw pixels in a side chunk, not PNG images inside glTF.
 */

import {
  DataTexture,
  LinearSRGBColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  type MeshStandardMaterial,
  type Texture,
} from 'three';

import {
  readRgbaTextureChunk,
  type RgbaTextureImage,
} from '../../shared/fbx-rgba-chunk';

const COLOR_SLOTS = new Set(['baseColor', 'emissive']);

export function applyDecodedRgbaTextures(
  root: { traverse: (visitor: (object: object) => void) => void },
  file: ArrayBuffer,
): number {
  const images = new Map(
    readRgbaTextureChunk(file).map((image) => [image.textureIndex, image]),
  );
  if (images.size === 0) return 0;
  let applied = 0;
  root.traverse((object) => {
    const materialValue = (object as { material?: unknown }).material;
    const materials = Array.isArray(materialValue) ? materialValue : [materialValue];
    for (const material of materials) {
      if (!isTexturedMaterial(material)) continue;
      const slots = material.userData.serpentRgbaTextures;
      if (!slots || typeof slots !== 'object') continue;
      for (const [slot, index] of Object.entries(slots)) {
        if (typeof index !== 'number') continue;
        const image = images.get(index);
        if (!image) continue;
        assignSlot(material, slot, makeDataTexture(image, COLOR_SLOTS.has(slot)));
        applied += 1;
      }
      const scale = material.userData.serpentNormalScale;
      if (typeof scale === 'number') material.normalScale.set(scale, scale);
      material.needsUpdate = true;
    }
  });
  return applied;
}

function makeDataTexture(image: RgbaTextureImage, srgb: boolean): DataTexture {
  const texture = new DataTexture(image.rgba, image.width, image.height, RGBAFormat);
  texture.flipY = false;
  texture.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function assignSlot(
  material: MeshStandardMaterial,
  slot: string,
  texture: Texture,
): void {
  switch (slot) {
    case 'baseColor':
      material.map = texture;
      break;
    case 'normal':
      material.normalMap = texture;
      break;
    case 'occlusion':
      material.aoMap = texture;
      break;
    case 'emissive':
      material.emissiveMap = texture;
      break;
    case 'metallicRoughness':
      material.metalnessMap = texture;
      material.roughnessMap = texture;
      break;
    default:
      break;
  }
}

function isTexturedMaterial(value: unknown): value is MeshStandardMaterial & {
  userData: {
    serpentRgbaTextures?: unknown;
    serpentNormalScale?: unknown;
  };
} {
  if (!value || typeof value !== 'object') return false;
  const material = value as Partial<MeshStandardMaterial>;
  return 'map' in material && 'needsUpdate' in material && material.userData !== undefined;
}
