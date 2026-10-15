import sharp from 'sharp';

export interface CompanionArtSourceRect { x: number; y: number; width: number; height: number }
export interface CompanionArtSourceLayout { sourceRects?: readonly CompanionArtSourceRect[]; sourcePadding?: number }

/** One action's three drawings may have uneven authoring columns. Cut only
 * explicitly reviewed disjoint rectangles, then apply ONE scale to all three. */
export async function normalizeCompanionWorldActionSheet(input: Buffer, layout: CompanionArtSourceLayout = {}) {
  const metadata = await sharp(input).metadata();
  if (!metadata.hasAlpha || !metadata.width || !metadata.height) throw new Error('Expected a transparent action sheet.');
  if (!layout.sourceRects) {
    if (Math.abs(metadata.width / metadata.height - 3) > .025) throw new Error('Expected one transparent three-frame row.');
    return { image: await sharp(input).resize(1152, 384).png().toBuffer(), normalization: undefined };
  }
  const rects = layout.sourceRects, padding = layout.sourcePadding ?? 24;
  if (rects.length !== 3 || !Number.isInteger(padding) || padding < 1 || padding > 96) throw new Error('Supply three reviewed source rectangles and valid padding.');
  for (const rect of rects) if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > metadata.width || rect.y + rect.height > metadata.height) throw new Error('Source rectangle leaves the original action image.');
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const a = rects[i]!, b = rects[j]!;
    if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) throw new Error('Source frames must not overlap.');
  }
  // Every opaque source pixel must be assigned exactly once. A manual cut
  // cannot silently crop an extremity or omit a fourth drawing.
  const decoded = await sharp(input).ensureAlpha().raw().toBuffer();
  for (const rect of rects) {
    let cut = 0;
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) if ((x === rect.x || x === rect.x + rect.width - 1 || y === rect.y || y === rect.y + rect.height - 1) && decoded[(y * metadata.width + x) * 4 + 3]! > 16) cut++;
    if (cut > 8) throw new Error('Source rectangle cuts through a visible drawing.');
  }
  for (let y = 0; y < metadata.height; y++) for (let x = 0; x < metadata.width; x++) if (decoded[(y * metadata.width + x) * 4 + 3]! > 16 && !rects.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)) throw new Error('Reviewed source rectangles discard visible pixels.');
  const scale = Math.min((384 - padding * 2) / Math.max(...rects.map(rect => rect.width)), (384 - padding * 2) / Math.max(...rects.map(rect => rect.height)));
  const placements = rects.map((rect, index) => { const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale)); return { left: index * 384 + Math.floor((384 - width) / 2), top: Math.floor((384 - height) / 2), width, height }; });
  const pieces = await Promise.all(rects.map(async (rect, index) => ({ input: await sharp(input).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).resize(placements[index]!.width, placements[index]!.height).png().toBuffer(), left: placements[index]!.left, top: placements[index]!.top })));
  const image = await sharp({ create: { width: 1152, height: 384, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(pieces).png().toBuffer();
  return { image, normalization: { method: 'reviewed-source-rectangles-uniform-scale' as const, sourceWidth: metadata.width, sourceHeight: metadata.height, sourceRects: rects, padding, scale, placements } };
}
