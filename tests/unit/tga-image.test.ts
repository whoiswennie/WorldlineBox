import { describe, expect, it } from "vitest";

import { decodeTgaRgba } from "../../src/worker/fbx/tga-image";

function uncompressedTga(args: {
  width: number;
  height: number;
  pixels: ReadonlyArray<readonly [number, number, number, number]>;
  topOrigin?: boolean;
}): Buffer {
  const header = Buffer.alloc(18);
  header[2] = 2;
  header.writeUInt16LE(args.width, 12);
  header.writeUInt16LE(args.height, 14);
  header[16] = 32;
  header[17] = (args.topOrigin ? 0x20 : 0) | 8;
  const body = Buffer.alloc(args.pixels.length * 4);
  args.pixels.forEach(([red, green, blue, alpha], index) => {
    body[index * 4] = blue;
    body[index * 4 + 1] = green;
    body[index * 4 + 2] = red;
    body[index * 4 + 3] = alpha;
  });
  return Buffer.concat([header, body]);
}

describe("decodeTgaRgba", () => {
  it("keeps alpha and flips a bottom-origin image upright", () => {
    const decoded = decodeTgaRgba(uncompressedTga({
      width: 2,
      height: 2,
      pixels: [
        [255, 0, 0, 255],
        [0, 0, 0, 0],
        [0, 255, 0, 255],
        [0, 0, 255, 128],
      ],
    }));
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.rgba)).toEqual([
      0, 255, 0, 255,
      0, 0, 255, 128,
      255, 0, 0, 255,
      0, 0, 0, 0,
    ]);
  });

  it("rejects a texture that is not truecolor TGA", () => {
    expect(decodeTgaRgba(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
