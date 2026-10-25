import { describe, expect, it } from "vitest";

import {
  appendRgbaTextureChunk,
  RGBA_CHUNK_TYPE,
  readRgbaTextureChunk,
} from "../../src/shared/fbx-rgba-chunk";

function emptyGlb(): Buffer {
  const json = Buffer.from("{}", "utf8");
  const jsonPad = (json.length + 3) & ~3;
  const glb = Buffer.alloc(12 + 8 + jsonPad + 8);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonPad, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  glb.writeUInt32LE(0, 12 + 8 + jsonPad);
  glb.writeUInt32LE(0x004e4942, 12 + 8 + jsonPad + 4);
  return glb;
}

describe("fbx rgba texture chunk", () => {
  it('ignores malformed metadata and pixel offsets outside the RGBA payload', () => {
    function malformed(metadata: unknown): ArrayBuffer {
      const mesh = emptyGlb();
      const json = Buffer.from(JSON.stringify(metadata));
      const padded = (json.length + 3) & ~3;
      const chunk = Buffer.alloc(8 + 4 + padded + 4);
      chunk.writeUInt32LE(chunk.length - 8, 0);
      chunk.writeUInt32LE(RGBA_CHUNK_TYPE, 4);
      chunk.writeUInt32LE(json.length, 8);
      json.copy(chunk, 12);
      const glb = Buffer.concat([mesh, chunk]);
      glb.writeUInt32LE(glb.length, 8);
      return Uint8Array.from(glb).buffer;
    }
    for (const metadata of [null, { images: {} }, { images: [null] }]) {
      expect(readRgbaTextureChunk(malformed(metadata))).toEqual([]);
    }
    for (const byteOffset of [-4, 0.5, 8]) {
      expect(readRgbaTextureChunk(malformed({ images: [{
        textureIndex: 0, width: 1, height: 1, byteOffset, byteLength: 4,
      }] }))).toEqual([]);
    }
  });
  it("round-trips decoded pixels without changing the mesh chunk", () => {
    const mesh = emptyGlb();
    const packed = appendRgbaTextureChunk(mesh, [{
      textureIndex: 0,
      width: 1,
      height: 1,
      rgba: Uint8Array.from([10, 20, 30, 0]),
    }]);
    expect(packed.subarray(0, 4).toString("utf8")).toBe("glTF");
    expect(packed.readUInt32LE(8)).toBe(packed.length);
    const bytes = new Uint8Array(packed.byteLength);
    bytes.set(packed);
    const images = readRgbaTextureChunk(bytes.buffer);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ textureIndex: 0, width: 1, height: 1 });
    expect(Array.from(images[0]!.rgba)).toEqual([10, 20, 30, 0]);
  });
});
