import { describe, expect, it } from "vitest";

import {
  fitSemanticImage,
  SemanticImageLimitError,
  type SemanticImageSharpFactory,
} from "../../src/main/embedding-image-fit";

type EncodeCall = { edge: number; quality: number };

function scriptedSharp(script: {
  width?: number;
  height?: number;
  metadataError?: boolean;
  encode?: (call: EncodeCall) => Buffer;
  encodeError?: boolean;
}): { factory: SemanticImageSharpFactory; calls: EncodeCall[] } {
  const calls: EncodeCall[] = [];
  const factory: SemanticImageSharpFactory = () => {
    let edge = 0;
    let quality = 0;
    const api = {
      async metadata() {
        if (script.metadataError) throw new Error("metadata");
        return { width: script.width ?? 1, height: script.height ?? 1 };
      },
      rotate() { return api; },
      resize(options: { width: number; height: number; fit: "inside"; withoutEnlargement: true }) {
        edge = options.width;
        return api;
      },
      jpeg(options: { quality: number; mozjpeg?: boolean }) {
        quality = options.quality;
        return api;
      },
      async toBuffer() {
        const call = { edge, quality };
        calls.push(call);
        if (script.encodeError) throw new Error("decode");
        return script.encode?.(call) ?? Buffer.from("jpeg");
      },
    };
    return api;
  };
  return { factory, calls };
}

describe("fitSemanticImage", () => {
  it("passes through a jpeg already inside the edge and byte limits", async () => {
    const bytes = Buffer.from("already-small");
    const sharp = scriptedSharp({ width: 640, height: 360 });
    const fitted = await fitSemanticImage({
      bytes,
      mimeType: "image/jpeg",
      maxEdgePx: 768,
      maxBytes: 1_572_864,
      sharpFn: sharp.factory,
    });
    expect(fitted).toEqual({ bytes, mimeType: "image/jpeg" });
    expect(sharp.calls).toEqual([]);
  });

  it("recompresses when the longest edge is over the limit and keeps the first fitting quality", async () => {
    const sharp = scriptedSharp({
      width: 1920,
      height: 1080,
      encode: (call) => Buffer.alloc(call.quality === 85 ? 80 : 10),
    });
    const fitted = await fitSemanticImage({
      bytes: Buffer.from("wide"),
      mimeType: "image/png",
      maxEdgePx: 768,
      maxBytes: 40,
      sharpFn: sharp.factory,
    });
    expect(fitted.mimeType).toBe("image/jpeg");
    expect(fitted.bytes).toHaveLength(10);
    expect(sharp.calls).toEqual([
      { edge: 768, quality: 85 },
      { edge: 768, quality: 70 },
    ]);
  });

  it("shrinks the edge when every quality is still too large", async () => {
    const sharp = scriptedSharp({
      width: 4000,
      height: 3000,
      encode: (call) => (call.edge <= 108 ? Buffer.from("ok") : Buffer.alloc(50)),
    });
    const fitted = await fitSemanticImage({
      bytes: Buffer.from("huge"),
      mimeType: "image/jpeg",
      maxEdgePx: 256,
      maxBytes: 4,
      sharpFn: sharp.factory,
    });
    expect(fitted.bytes.toString()).toBe("ok");
    expect(sharp.calls.at(-1)).toEqual({ edge: 108, quality: 85 });
    expect(sharp.calls.some((call) => call.edge === 256)).toBe(true);
  });

  it("fails when the bytes cannot be decoded", async () => {
    const sharp = scriptedSharp({ metadataError: true, encodeError: true });
    await expect(fitSemanticImage({
      bytes: Buffer.from("broken"),
      mimeType: "image/jpeg",
      maxEdgePx: 768,
      maxBytes: 100,
      sharpFn: sharp.factory,
    })).rejects.toBeInstanceOf(SemanticImageLimitError);
  });

  it("fails when shrinking still cannot meet the byte limit", async () => {
    const sharp = scriptedSharp({
      width: 800,
      height: 800,
      encode: () => Buffer.alloc(32),
    });
    await expect(fitSemanticImage({
      bytes: Buffer.from("dense"),
      mimeType: "image/png",
      maxEdgePx: 128,
      maxBytes: 8,
      sharpFn: sharp.factory,
    })).rejects.toBeInstanceOf(SemanticImageLimitError);
  });
});
