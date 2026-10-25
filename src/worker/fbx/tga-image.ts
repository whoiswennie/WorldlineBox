/**
 * Uncompressed and RLE truecolor TGA → straight RGBA.
 *
 * FBX files from DCC tools often embed coverage in a 32-bit TGA. The
 * converter keeps those pixels as straight RGBA instead of a glTF image.
 */

export interface DecodedTga {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
}

export function decodeTgaRgba(bytes: Buffer): DecodedTga | null {
  if (bytes.length < 18) return null;
  const idLength = bytes[0] ?? 0;
  const colorMapType = bytes[1] ?? 0;
  const imageType = bytes[2] ?? 0;
  if (imageType !== 2 && imageType !== 10) return null;
  if (colorMapType !== 0 && colorMapType !== 1) return null;
  const width = bytes.readUInt16LE(12);
  const height = bytes.readUInt16LE(14);
  const depth = bytes[16] ?? 0;
  const descriptor = bytes[17] ?? 0;
  if (width <= 0 || height <= 0) return null;
  if (width * height > 64 * 1024 * 1024) return null;
  if (depth !== 24 && depth !== 32) return null;
  const channels = depth / 8;
  let offset = 18 + idLength;
  if (colorMapType === 1) {
    const mapLength = bytes.readUInt16LE(5);
    const entryBits = bytes[7] ?? 0;
    offset += mapLength * Math.ceil(entryBits / 8);
  }
  if (offset > bytes.length) return null;

  const rgba = Buffer.alloc(width * height * 4);
  const topOrigin = (descriptor & 0x20) !== 0;
  const writePixel = (
    pixel: number,
    blue: number,
    green: number,
    red: number,
    alpha: number,
  ): void => {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const destY = topOrigin ? y : height - 1 - y;
    const dest = (destY * width + x) * 4;
    rgba[dest] = red;
    rgba[dest + 1] = green;
    rgba[dest + 2] = blue;
    rgba[dest + 3] = alpha;
  };

  const pixelCount = width * height;
  if (imageType === 2) {
    if (offset + pixelCount * channels > bytes.length) return null;
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const at = offset + pixel * channels;
      writePixel(
        pixel,
        bytes[at] ?? 0,
        bytes[at + 1] ?? 0,
        bytes[at + 2] ?? 0,
        channels === 4 ? bytes[at + 3] ?? 255 : 255,
      );
    }
    return { width, height, rgba };
  }

  let pixel = 0;
  while (pixel < pixelCount) {
    if (offset >= bytes.length) return null;
    const header = bytes[offset] ?? 0;
    offset += 1;
    const run = (header & 0x7f) + 1;
    if ((header & 0x80) !== 0) {
      if (offset + channels > bytes.length) return null;
      const blue = bytes[offset] ?? 0;
      const green = bytes[offset + 1] ?? 0;
      const red = bytes[offset + 2] ?? 0;
      const alpha = channels === 4 ? bytes[offset + 3] ?? 255 : 255;
      offset += channels;
      for (let step = 0; step < run && pixel < pixelCount; step += 1) {
        writePixel(pixel, blue, green, red, alpha);
        pixel += 1;
      }
    } else {
      if (offset + run * channels > bytes.length) return null;
      for (let step = 0; step < run && pixel < pixelCount; step += 1) {
        const at = offset + step * channels;
        writePixel(
          pixel,
          bytes[at] ?? 0,
          bytes[at + 1] ?? 0,
          bytes[at + 2] ?? 0,
          channels === 4 ? bytes[at + 3] ?? 255 : 255,
        );
        pixel += 1;
      }
      offset += run * channels;
    }
  }
  return { width, height, rgba };
}
