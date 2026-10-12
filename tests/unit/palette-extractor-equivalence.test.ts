import { describe, expect, it } from 'vitest';

import { extractRepresentativePalette } from '../../src/worker/palette-extractor';
import { referenceExtractRepresentativePalette } from '../helpers/palette-extractor-reference';

/**
 * The histogram moved from a per-pixel `Map` to flat typed arrays
 * (WorldlineBox-3a9f1c). That is only acceptable while the emitted palette stays
 * byte-for-byte identical, so the pre-optimization implementation (kept in
 * `tests/helpers/palette-extractor-reference.ts`) is compared over a
 * deterministic pixel corpus.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type PixelPattern = 'uniform-noise' | 'flat' | 'few-colours' | 'gradient' | 'mostly-transparent' | 'two-tone-noise';

function buildPixels(
  random: () => number,
  pattern: PixelPattern,
  pixelCount: number,
  channels: number,
): Uint8Array {
  const pixels = new Uint8Array(pixelCount * channels);
  const paletteSize = pattern === 'few-colours' ? 3 : pattern === 'two-tone-noise' ? 2 : 0;
  const palette: Array<[number, number, number]> = [];
  for (let index = 0; index < paletteSize; index += 1) {
    palette.push([
      Math.trunc(random() * 256),
      Math.trunc(random() * 256),
      Math.trunc(random() * 256),
    ]);
  }
  const flat: [number, number, number] = [
    Math.trunc(random() * 256),
    Math.trunc(random() * 256),
    Math.trunc(random() * 256),
  ];
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * channels;
    let red: number;
    let green: number;
    let blue: number;
    if (pattern === 'uniform-noise') {
      red = Math.trunc(random() * 256);
      green = Math.trunc(random() * 256);
      blue = Math.trunc(random() * 256);
    } else if (pattern === 'flat') {
      [red, green, blue] = flat;
    } else if (pattern === 'few-colours') {
      [red, green, blue] = palette[Math.trunc(random() * paletteSize)]!;
    } else if (pattern === 'two-tone-noise') {
      const base = palette[Math.trunc(random() * paletteSize)]!;
      red = Math.min(255, base[0] + Math.trunc(random() * 8));
      green = Math.min(255, base[1] + Math.trunc(random() * 8));
      blue = Math.min(255, base[2] + Math.trunc(random() * 8));
    } else if (pattern === 'gradient') {
      // Long ramps keep many bins occupied while staying deterministic.
      red = (pixel * 7 + Math.trunc(random() * 3)) % 256;
      green = (pixel * 3 + Math.trunc(random() * 3)) % 256;
      blue = (pixel * 11 + Math.trunc(random() * 3)) % 256;
    } else {
      red = Math.trunc(random() * 256);
      green = Math.trunc(random() * 256);
      blue = Math.trunc(random() * 256);
    }
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    if (channels === 4) {
      pixels[offset + 3] = pattern === 'mostly-transparent'
        ? (pixel % 5 === 0 ? 255 : Math.trunc(random() * 16))
        : 255;
    }
  }
  return pixels;
}

describe('palette extraction equivalence', () => {
  const patterns: PixelPattern[] = [
    'uniform-noise',
    'flat',
    'few-colours',
    'gradient',
    'mostly-transparent',
    'two-tone-noise',
  ];

  it('matches the pre-optimization implementation across a deterministic corpus', () => {
    const random = mulberry32(0x5eed1234);
    let compared = 0;
    for (let caseIndex = 0; caseIndex < 240; caseIndex += 1) {
      const pattern = patterns[caseIndex % patterns.length]!;
      const channels = caseIndex % 3 === 0 && pattern !== 'mostly-transparent' ? 3 : 4;
      const pixelCount = 1 + Math.trunc(random() * 6000);
      const maxColors = 1 + Math.trunc(random() * 12);
      const pixels = buildPixels(random, pattern, pixelCount, channels);
      const expected = referenceExtractRepresentativePalette(pixels, channels, maxColors);
      const actual = extractRepresentativePalette(pixels, channels, maxColors);
      expect(actual, `case ${caseIndex} (${pattern}, channels=${channels}, maxColors=${maxColors})`)
        .toEqual(expected);
      compared += 1;
    }
    expect(compared).toBe(240);
  });

  it('matches for fully transparent buffers and single-bin buffers', () => {
    const transparent = new Uint8Array(64 * 4);
    expect(extractRepresentativePalette(transparent, 4, 6))
      .toEqual(referenceExtractRepresentativePalette(transparent, 4, 6));

    const singleBin = new Uint8Array(300 * 3);
    for (let pixel = 0; pixel < 300; pixel += 1) {
      singleBin[pixel * 3] = 16 + (pixel % 16);
      singleBin[pixel * 3 + 1] = 32 + (pixel % 16);
      singleBin[pixel * 3 + 2] = 48 + (pixel % 16);
    }
    expect(extractRepresentativePalette(singleBin, 3, 6))
      .toEqual(referenceExtractRepresentativePalette(singleBin, 3, 6));
  });

  it('stays fast on a large decoded frame', () => {
    // A decoded 2 MP RGBA frame is far larger than the 64x64 preview the
    // product extracts from; it exists to catch a return of per-pixel
    // allocation blowups. The authoritative benchmark is
    // `npm run test:perf:palette -- <image-directory>`.
    const random = mulberry32(0xabcdef01);
    const pixels = buildPixels(random, 'uniform-noise', 2_000_000, 4);
    const startedAt = performance.now();
    const palette = extractRepresentativePalette(pixels, 4, 6);
    const elapsedMs = performance.now() - startedAt;
    expect(palette.length).toBeGreaterThan(0);
    expect(elapsedMs, `2 MP extraction took ${elapsedMs.toFixed(1)} ms`).toBeLessThan(1500);
  });
});
