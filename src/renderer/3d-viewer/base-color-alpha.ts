/**
 * FBX basecolor maps often store coverage in the texture alpha (foliage,
 * decals, glass). The ufbx → glTF conversion marks a material opaque unless
 * the FBX opacity factor is below 1 or a separate opacity map exists, and
 * glTF OPAQUE sampling drops baseColorTexture alpha. After the scene is
 * loaded, discard texels below the cutoff when the alpha channel has a
 * non-opaque sample, or the texture mime type can carry alpha. A fully
 * opaque image still passes the cutoff. Blending would keep the dark color
 * stored in nearly clear texels.
 */

const ALPHA_SAMPLE_BUDGET = 512 * 512;
/** glTF MASK default. Pixels below this are discarded instead of blended. */
export const BASE_COLOR_ALPHA_CUTOFF = 0.5;

const ALPHA_CAPABLE_MIME = new Set(['image/png', 'image/webp', 'image/gif']);

export type BaseColorAlphaMaterial = {
  map: {
    image?: unknown;
    onUpdate: ((texture: unknown) => void) | null;
    userData?: { mimeType?: unknown };
  } | null;
  transparent: boolean;
  alphaTest: number;
  depthWrite: boolean;
  needsUpdate: boolean;
};

type RgbaImage = {
  width: number;
  height: number;
  data: ArrayLike<number>;
};

type DrawableImage = CanvasImageSource & {
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
};

export function rgbaHasTransparentAlpha(
  data: ArrayLike<number>,
  pixelCount: number,
): boolean {
  if (pixelCount <= 0 || data.length < pixelCount * 4) return false;
  const step = pixelCount > ALPHA_SAMPLE_BUDGET
    ? Math.ceil(pixelCount / ALPHA_SAMPLE_BUDGET)
    : 1;
  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const alpha = data[pixel * 4 + 3];
    if (typeof alpha === 'number' && alpha < 255) return true;
  }
  return false;
}

export function textureImageHasTransparentAlpha(image: unknown): boolean {
  const packed = readRgbaImage(image);
  if (!packed) return false;
  return rgbaHasTransparentAlpha(packed.data, packed.width * packed.height);
}

/**
 * Cut the basecolor map's alpha out of the surface. Blending those texels
 * keeps the dark RGB stored in nearly-clear pixels and turns foliage cards
 * into dark rectangles. A fully opaque map is unchanged by the cutoff.
 * Materials that already blend, or that already cut out, keep their mode.
 */
export function applyBaseColorAlphaToMaterial(
  material: BaseColorAlphaMaterial,
  imageHasTransparentAlpha: boolean,
): boolean {
  if (!imageHasTransparentAlpha || !material.map) return false;
  if (material.transparent || material.alphaTest > 0) return false;
  material.alphaTest = BASE_COLOR_ALPHA_CUTOFF;
  material.needsUpdate = true;
  return true;
}

export function baseColorMapNeedsCutout(map: {
  image?: unknown;
  userData?: { mimeType?: unknown };
}): boolean {
  if (textureImageHasTransparentAlpha(map.image)) return true;
  const mime = textureMime(map);
  return mime !== null && ALPHA_CAPABLE_MIME.has(mime);
}

export function applyBaseColorTextureAlpha(
  root: { traverse: (visitor: (object: object) => void) => void },
): number {
  const seen = new Set<BaseColorAlphaMaterial>();
  let changed = 0;
  root.traverse((object) => {
    const material = (object as { material?: unknown }).material;
    const materials = Array.isArray(material) ? material : [material];
    for (const current of materials) {
      if (!isBaseColorAlphaMaterial(current) || seen.has(current)) continue;
      seen.add(current);
      const map = current.map;
      if (!map) continue;
      const apply = (): void => {
        if (applyBaseColorAlphaToMaterial(current, baseColorMapNeedsCutout(map))) {
          changed += 1;
        }
      };
      if (imageHasPixels(map.image) || textureMime(map) !== null) {
        apply();
        continue;
      }
      const prior = map.onUpdate;
      map.onUpdate = (texture: unknown) => {
        const image = (texture as { image?: unknown } | null)?.image ?? map.image;
        if (!imageHasPixels(image)) return;
        map.onUpdate = prior;
        if (prior) prior(texture);
        if (applyBaseColorAlphaToMaterial(current, baseColorMapNeedsCutout({
          ...map,
          image,
        }))) {
          changed += 1;
        }
      };
    }
  });
  return changed;
}

function isBaseColorAlphaMaterial(value: unknown): value is BaseColorAlphaMaterial {
  if (!value || typeof value !== 'object') return false;
  const material = value as Partial<BaseColorAlphaMaterial>;
  return typeof material.transparent === 'boolean'
    && typeof material.alphaTest === 'number'
    && typeof material.depthWrite === 'boolean'
    && 'map' in material
    && 'needsUpdate' in material;
}

function readRgbaImage(image: unknown): RgbaImage | null {
  if (!image || typeof image !== 'object') return null;
  const packed = image as Partial<RgbaImage>;
  if (
    typeof packed.width === 'number'
    && typeof packed.height === 'number'
    && packed.width > 0
    && packed.height > 0
    && isArrayLike(packed.data)
    && packed.data.length >= packed.width * packed.height * 4
  ) {
    return { width: packed.width, height: packed.height, data: packed.data };
  }
  return readDrawableImage(image as DrawableImage);
}

function readDrawableImage(image: DrawableImage): RgbaImage | null {
  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  if (width <= 0 || height <= 0 || typeof document === 'undefined') return null;
  const sampleWidth = Math.min(width, 256);
  const sampleHeight = Math.max(1, Math.min(256, Math.round(height * (sampleWidth / width))));
  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  try {
    context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
    const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight);
    return { width: sampleWidth, height: sampleHeight, data: pixels.data };
  } catch {
    return null;
  }
}

function textureMime(map: { userData?: { mimeType?: unknown } }): string | null {
  const mime = map.userData?.mimeType;
  return typeof mime === 'string' ? mime.toLowerCase() : null;
}

function imageHasPixels(image: unknown): boolean {
  if (!image || typeof image !== 'object') return false;
  const record = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  return (record.naturalWidth ?? record.width ?? 0) > 0
    && (record.naturalHeight ?? record.height ?? 0) > 0;
}

function isArrayLike(value: unknown): value is ArrayLike<number> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as ArrayLike<number>).length === 'number';
}
