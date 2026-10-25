import { describe, expect, it } from 'vitest';

import {
  applyBaseColorAlphaToMaterial,
  applyBaseColorTextureAlpha,
  BASE_COLOR_ALPHA_CUTOFF,
  baseColorMapNeedsCutout,
  rgbaHasTransparentAlpha,
  textureImageHasTransparentAlpha,
  type BaseColorAlphaMaterial,
} from '../../src/renderer/3d-viewer/base-color-alpha';

function material(overrides: Partial<BaseColorAlphaMaterial> = {}): BaseColorAlphaMaterial {
  return {
    map: { image: undefined, onUpdate: null },
    transparent: false,
    alphaTest: 0,
    depthWrite: true,
    needsUpdate: false,
    ...overrides,
  };
}

describe('FBX basecolor alpha', () => {
  it('detects a non-opaque sample in an RGBA buffer', () => {
    const opaque = Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 255]);
    const punched = Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 0]);
    expect(rgbaHasTransparentAlpha(opaque, 2)).toBe(false);
    expect(rgbaHasTransparentAlpha(punched, 2)).toBe(true);
    expect(rgbaHasTransparentAlpha(opaque, 0)).toBe(false);
    expect(rgbaHasTransparentAlpha(opaque.subarray(0, 3), 1)).toBe(false);
  });

  it('reads alpha from a packed texture image', () => {
    expect(textureImageHasTransparentAlpha({
      width: 1,
      height: 2,
      data: Uint8ClampedArray.from([0, 0, 0, 255, 9, 9, 9, 10]),
    })).toBe(true);
    expect(textureImageHasTransparentAlpha({
      width: 1,
      height: 1,
      data: Uint8ClampedArray.from([0, 0, 0, 255]),
    })).toBe(false);
  });

  it('cuts out basecolor alpha instead of blending the dark texels', () => {
    const opaque = material();
    expect(applyBaseColorAlphaToMaterial(opaque, false)).toBe(false);
    expect(opaque.alphaTest).toBe(0);
    expect(opaque.transparent).toBe(false);
    expect(opaque.depthWrite).toBe(true);

    const punched = material();
    expect(applyBaseColorAlphaToMaterial(punched, true)).toBe(true);
    expect(punched.alphaTest).toBe(BASE_COLOR_ALPHA_CUTOFF);
    expect(punched.transparent).toBe(false);
    expect(punched.depthWrite).toBe(true);
    expect(punched.needsUpdate).toBe(true);

    const alreadyBlended = material({ transparent: true, depthWrite: false });
    expect(applyBaseColorAlphaToMaterial(alreadyBlended, true)).toBe(false);

    const masked = material({ alphaTest: 0.5 });
    expect(applyBaseColorAlphaToMaterial(masked, true)).toBe(false);
    expect(masked.transparent).toBe(false);
  });

  it('treats a PNG basecolor as cutout coverage even before pixels can be read', () => {
    expect(baseColorMapNeedsCutout({
      userData: { mimeType: 'image/png' },
    })).toBe(true);
    expect(baseColorMapNeedsCutout({
      image: { width: 1, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 255]) },
      userData: { mimeType: 'image/jpeg' },
    })).toBe(false);
  });

  it('applies the basecolor alpha of each material in a scene once', () => {
    const punched = material({
      map: {
        image: { width: 1, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 0]) },
        onUpdate: null,
      },
    });
    const solid = material({
      map: {
        image: { width: 1, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 255]) },
        onUpdate: null,
      },
    });
    const changed = applyBaseColorTextureAlpha({
      traverse(visitor) {
        visitor({ material: punched });
        visitor({ material: [punched, solid] });
      },
    });
    expect(changed).toBe(1);
    expect(punched.alphaTest).toBe(BASE_COLOR_ALPHA_CUTOFF);
    expect(punched.transparent).toBe(false);
    expect(solid.alphaTest).toBe(0);
  });

  it('waits for a basecolor image that is not decoded yet', () => {
    const pending = material({ map: { image: undefined, onUpdate: null } });
    expect(applyBaseColorTextureAlpha({
      traverse(visitor) {
        visitor({ material: pending });
        visitor({});
      },
    })).toBe(0);
    expect(pending.transparent).toBe(false);
    expect(pending.alphaTest).toBe(0);
    const onUpdate = pending.map?.onUpdate;
    expect(onUpdate).toBeTypeOf('function');
    onUpdate?.({
      image: { width: 1, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 0]) },
    });
    expect(pending.alphaTest).toBe(BASE_COLOR_ALPHA_CUTOFF);
    expect(pending.transparent).toBe(false);
    expect(pending.depthWrite).toBe(true);
    expect(pending.map?.onUpdate).toBeNull();
  });
});
