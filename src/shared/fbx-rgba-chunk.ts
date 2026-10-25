/**
 * Decoded FBX textures travel beside the mesh buffers.
 *
 * glTF images only carry PNG and JPEG. Formats the browser cannot decode,
 * such as TGA, are decoded to straight RGBA and stored in a GLB chunk the
 * mesh loader ignores. The viewer uploads those pixels directly.
 */

export const RGBA_CHUNK_TYPE = 0x41424752;

export interface RgbaTextureImage {
  readonly textureIndex: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

interface StoredImage {
  textureIndex: number;
  width: number;
  height: number;
  byteOffset: number;
  byteLength: number;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

export function appendRgbaTextureChunk(
  glb: Buffer,
  images: readonly RgbaTextureImage[],
): Buffer {
  if (images.length === 0) return glb;
  let pixelBytes = 0;
  const listed: StoredImage[] = images.map((image) => {
    const entry = {
      textureIndex: image.textureIndex,
      width: image.width,
      height: image.height,
      byteOffset: pixelBytes,
      byteLength: image.rgba.byteLength,
    };
    pixelBytes += align4(image.rgba.byteLength);
    return entry;
  });
  const json = Buffer.from(JSON.stringify({ images: listed }), 'utf8');
  const jsonPad = align4(json.length);
  const pixels = Buffer.alloc(pixelBytes);
  images.forEach((image, index) => {
    Buffer.from(image.rgba).copy(pixels, listed[index]!.byteOffset);
  });
  const payloadLength = 4 + jsonPad + pixels.length;
  const out = Buffer.alloc(glb.length + 8 + payloadLength);
  glb.copy(out, 0);
  let cursor = glb.length;
  out.writeUInt32LE(payloadLength, cursor);
  out.writeUInt32LE(RGBA_CHUNK_TYPE, cursor + 4);
  cursor += 8;
  out.writeUInt32LE(json.length, cursor);
  json.copy(out, cursor + 4);
  pixels.copy(out, cursor + 4 + jsonPad);
  out.writeUInt32LE(out.length, 8);
  return out;
}

export function readRgbaTextureChunk(data: ArrayBuffer): RgbaTextureImage[] {
  if (data.byteLength < 20) return [];
  const view = new DataView(data);
  if (
    view.getUint8(0) !== 0x67
    || view.getUint8(1) !== 0x6c
    || view.getUint8(2) !== 0x54
    || view.getUint8(3) !== 0x46
  ) {
    return [];
  }
  const total = Math.min(view.getUint32(8, true), data.byteLength);
  let chunkIndex = 12;
  while (chunkIndex + 8 <= total) {
    const chunkLength = view.getUint32(chunkIndex, true);
    const chunkType = view.getUint32(chunkIndex + 4, true);
    const payload = chunkIndex + 8;
    if (payload + chunkLength > total) return [];
    if (chunkType === RGBA_CHUNK_TYPE) {
      return readPayload(data, payload, chunkLength);
    }
    chunkIndex = payload + chunkLength;
  }
  return [];
}

function readPayload(
  data: ArrayBuffer,
  payload: number,
  chunkLength: number,
): RgbaTextureImage[] {
  if (chunkLength < 4) return [];
  const view = new DataView(data);
  const jsonLength = view.getUint32(payload, true);
  if (jsonLength <= 0 || 4 + jsonLength > chunkLength) return [];
  const jsonBytes = new Uint8Array(data, payload + 4, jsonLength);
  let parsed: { images?: StoredImage[] };
  try {
    parsed = JSON.parse(new TextDecoder().decode(jsonBytes)) as { images?: StoredImage[] };
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.images)) return [];
  const pixelStart = payload + 4 + align4(jsonLength);
  const images: RgbaTextureImage[] = [];
  for (const image of parsed.images) {
    if (
      !image || typeof image !== 'object'
      || !Number.isSafeInteger(image.textureIndex)
      || image.textureIndex < 0
      || !Number.isInteger(image.width)
      || !Number.isInteger(image.height)
      || image.width <= 0
      || image.height <= 0
      || !Number.isSafeInteger(image.byteOffset)
      || image.byteOffset < 0
      || !Number.isSafeInteger(image.byteLength)
      || image.byteLength !== image.width * image.height * 4
    ) {
      continue;
    }
    const start = pixelStart + image.byteOffset;
    const end = start + image.byteLength;
    if (end > payload + chunkLength) continue;
    images.push({
      textureIndex: image.textureIndex,
      width: image.width,
      height: image.height,
      rgba: new Uint8Array(data.slice(start, end)),
    });
  }
  return images;
}
