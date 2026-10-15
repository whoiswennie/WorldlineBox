import sharp from 'sharp';
import { expect, it } from 'vitest';
import { normalizeCompanionWorldActionSheet } from '../../scripts/companion-world-sheet';

async function source() {
  return sharp({ create: { width: 300, height: 100, channels: 4, background: '#00000000' } }).composite([
    { input: await sharp({ create: { width: 70, height: 30, channels: 4, background: '#ff0000' } }).png().toBuffer(), left: 20, top: 50 },
    { input: await sharp({ create: { width: 25, height: 50, channels: 4, background: '#00ff00' } }).png().toBuffer(), left: 125, top: 30 },
    { input: await sharp({ create: { width: 30, height: 70, channels: 4, background: '#0000ff' } }).png().toBuffer(), left: 220, top: 10 },
  ]).png().toBuffer();
}
const rectangles = [{ x: 0, y: 0, width: 110, height: 100 }, { x: 110, y: 0, width: 80, height: 100 }, { x: 190, y: 0, width: 110, height: 100 }];
it('preserves one action with uneven frame columns using one scale and complete transparent frames', async () => {
  const result = await normalizeCompanionWorldActionSheet(await source(), { sourceRects: rectangles });
  const decoded = await sharp(result.image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([decoded.info.width, decoded.info.height]).toEqual([1152, 384]);
  const scale = result.normalization!.scale;
  const heights: number[] = [];
  for (let frame = 0; frame < 3; frame++) {
    let low = 384, high = 0, count = 0;
    for (let y = 0; y < 384; y++) for (let x = 0; x < 384; x++) {
      const p = (y * 1152 + frame * 384 + x) * 4;
      if (decoded.data[p + 3]! > 230) { low = Math.min(low, y); high = Math.max(high, y); expect(decoded.data[p + frame]!).toBeGreaterThan(245); count++; }
      if (x === 0 || x === 383 || y === 0 || y === 383) expect(decoded.data[p + 3]).toBe(0);
    }
    expect(count).toBeGreaterThan(100); heights.push(high - low + 1);
  }
  // A reclining rectangle remains shorter than a standing rectangle. There is
  // no per-frame fit-to-bounds enlargement.
  heights.forEach((height, index) => expect(Math.abs(height - [30, 50, 70][index]! * scale)).toBeLessThan(3));
  expect(result.normalization?.sourceRects).toEqual(rectangles);
});
it('rejects overlapping frames, out-of-image cuts and omission of visible source pixels', async () => {
  const input = await source();
  await expect(normalizeCompanionWorldActionSheet(input, { sourceRects: [rectangles[0]!, rectangles[0]!, rectangles[2]!] })).rejects.toThrow('overlap');
  await expect(normalizeCompanionWorldActionSheet(input, { sourceRects: [...rectangles.slice(0, 2), { x: 220, y: 0, width: 110, height: 100 }] })).rejects.toThrow('leaves');
  await expect(normalizeCompanionWorldActionSheet(input, { sourceRects: rectangles.map(rect => ({ ...rect, height: 60 })) })).rejects.toThrow('cuts');
  await expect(normalizeCompanionWorldActionSheet(input, { sourceRects: [{ x: 0, y: 0, width: 100, height: 10 }, { x: 100, y: 0, width: 100, height: 10 }, { x: 200, y: 0, width: 100, height: 10 }] })).rejects.toThrow('discard');
});
