import type { WorldArtFrame, WorldArtPoint, WorldArtSheet, WorldCharacterArt } from './companion-world-art';

export interface WorldArtFramePlacement {
  source: WorldArtPoint & { width: number; height: number };
  sourceImage: { width: number; height: number };
  anchor: WorldArtPoint;
  scale: number;
  pose: 'ground' | 'seat' | 'bed';
}
export function companionWorldFramePose(frame: WorldArtFrame): WorldArtFramePlacement['pose'] {
  return frame.contacts.posture === 'lying' || frame.contacts.posture === 'transition' && frame.contacts.bed ? 'bed'
    : frame.contacts.posture === 'sitting' || frame.contacts.posture === 'transition' && frame.contacts.seat ? 'seat' : 'ground';
}
export function getCompanionWorldFramePlacement(character: WorldCharacterArt, asset: WorldArtSheet, frameIndex: number): WorldArtFramePlacement {
  const index = Math.max(0, Math.min(2, Math.floor(frameIndex))), frame = asset.frames[index]!, pose = companionWorldFramePose(frame);
  const contact = pose === 'bed' ? frame.contacts.bed : pose === 'seat' ? frame.contacts.seat : frame.contacts.foot;
  return { source: { x: index * asset.frameWidth, y: 0, width: asset.frameWidth, height: asset.frameHeight },
    sourceImage: { width: asset.frameWidth * asset.frameCount, height: asset.frameHeight },
    anchor: { ...(frame.registration?.anchor ?? contact ?? frame.contacts.origin) }, pose,
    scale: character.heightTiles / Math.max(1, asset.neutralHeightPixels ?? character.neutralHeightPixels) };
}

interface FramePixels { rgba: Uint8Array; width: number; height: number }
interface Region extends WorldArtPoint { width: number; height: number }
export interface WorldArtBodyRegistration { dx: number; dy: number; score: number; samples: number; core: Region }
const rounded = (n: number) => Math.round(n * 1000) / 1000;
const at = (frame: FramePixels, x: number, y: number) => (y * frame.width + x) * 4;
const opaque = (frame: FramePixels, x: number, y: number) => x >= 0 && y >= 0 && x < frame.width && y < frame.height && frame.rgba[at(frame, x, y) + 3]! > 40;

/** Head/neck seed only; extremities, long hair, tails and held objects never determine the registration centroid. */
function faceRegion(frame: FramePixels, bounds: Region): Region {
  const step = 3, width = Math.ceil(frame.width / step), height = Math.ceil(frame.height / step), mask = new Uint8Array(width * height);
  const lower = bounds.y + bounds.height * .64;
  for (let y = Math.max(0, Math.floor(bounds.y / step)); y < Math.min(height, lower / step); y++) for (let x = 0; x < width; x++) {
    const p = at(frame, Math.min(frame.width - 1, x * step), Math.min(frame.height - 1, y * step));
    const r = frame.rgba[p]!, g = frame.rgba[p + 1]!, b = frame.rgba[p + 2]!;
    if (frame.rgba[p + 3]! > 160 && r > 165 && g > 135 && b > 110 && r - g > 3 && r - g < 80 && g - b > -8 && g - b < 65 && r - b > 8 && r - b < 115) mask[y * width + x] = 1;
  }
  let best: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    const group = [i]; mask[i] = 0;
    for (let j = 0; j < group.length; j++) {
      const n = group[j]!, x = n % width, y = Math.floor(n / width);
      for (const adjacent of [x ? n - 1 : -1, x < width - 1 ? n + 1 : -1, y ? n - width : -1, y < height - 1 ? n + width : -1]) if (adjacent >= 0 && mask[adjacent]) { mask[adjacent] = 0; group.push(adjacent); }
    }
    if (group.length > best.length) best = group;
  }
  if (best.length < 8) return { x: bounds.x + bounds.width * .2, y: bounds.y + bounds.height * .2, width: bounds.width * .4, height: bounds.height * .23 };
  const xs = best.map(n => n % width * step), ys = best.map(n => Math.floor(n / width) * step);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) + step, height: Math.max(...ys) - Math.min(...ys) + step };
}

/** Robust colour matching of the compact face/neck/trunk, not the full silhouette's centre of mass. */
export function registerCompanionWorldBody(reference: FramePixels, target: FramePixels, referenceBounds: Region, targetBounds: Region): WorldArtBodyRegistration {
  const face = faceRegion(reference, referenceBounds), targetFace = faceRegion(target, targetBounds);
  const core: Region = { x: Math.max(referenceBounds.x, face.x - face.width * .12), y: face.y + face.height * .25,
    width: Math.min(referenceBounds.width * .65, face.width * 1.24), height: Math.min(referenceBounds.height * .48, face.height * 1.75) };
  const samples: Array<{ x: number; y: number; p: number }> = [];
  for (let y = Math.ceil(core.y); y < Math.min(reference.height, core.y + core.height); y += 5) for (let x = Math.ceil(core.x); x < Math.min(reference.width, core.x + core.width); x += 5) if (opaque(reference, x, y)) samples.push({ x, y, p: at(reference, x, y) });
  const predictedX = Math.round(targetFace.x + targetFace.width / 2 - face.x - face.width / 2), predictedY = Math.round(targetBounds.y - referenceBounds.y);
  const score = (dx: number, dy: number) => {
    if (!samples.length) return Number.POSITIVE_INFINITY;
    let cost = 0;
    for (const sample of samples) {
      const x = sample.x + dx, y = sample.y + dy;
      if (!opaque(target, x, y)) { cost += 100; continue; }
      const q = at(target, x, y), p = sample.p;
      // Cap changed hands/mouth/eyes so a gesture cannot drag the entire body.
      cost += Math.min(100, (Math.abs(reference.rgba[p]! - target.rgba[q]!) + Math.abs(reference.rgba[p + 1]! - target.rgba[q + 1]!) + Math.abs(reference.rgba[p + 2]! - target.rgba[q + 2]!)) / 3);
    }
    return cost / samples.length;
  };
  let best = { dx: predictedX, dy: predictedY, score: Number.POSITIVE_INFINITY };
  const improve = (value: number, dx: number, dy: number) => value < best.score || value === best.score &&
    Math.abs(dx - predictedX) + Math.abs(dy - predictedY) < Math.abs(best.dx - predictedX) + Math.abs(best.dy - predictedY);
  const range = Math.ceil(Math.max(18, referenceBounds.height * .09));
  for (let dx = predictedX - range; dx <= predictedX + range; dx += 3) for (let dy = predictedY - 12; dy <= predictedY + 12; dy += 3) {
    const value = score(dx, dy); if (improve(value, dx, dy)) best = { dx, dy, score: value };
  }
  const coarse = best;
  for (let dx = coarse.dx - 3; dx <= coarse.dx + 3; dx++) for (let dy = coarse.dy - 3; dy <= coarse.dy + 3; dy++) { const value = score(dx, dy); if (improve(value, dx, dy)) best = { dx, dy, score: value }; }
  return { ...best, score: rounded(best.score), samples: samples.length, core: Object.fromEntries(Object.entries(core).map(([key, value]) => [key, rounded(value)])) as unknown as Region };
}

export function calibrateCompanionWorldSheet(asset: WorldArtSheet, action: string, frames: [FramePixels, FramePixels, FramePixels]): { registrations: [NonNullable<WorldArtFrame['registration']>, NonNullable<WorldArtFrame['registration']>, NonNullable<WorldArtFrame['registration']>]; matches: WorldArtBodyRegistration[] } {
  const reference = asset.frames[0], referencePose = companionWorldFramePose(reference), base = referencePose === 'seat' ? reference.contacts.seat : referencePose === 'bed' ? reference.contacts.bed : reference.contacts.foot;
  const anchor = base ?? reference.contacts.origin, dynamic = ['walk', 'run', 'follow', 'exercise', 'turn'].includes(action), transition = asset.playback === 'transition';
  const matches = frames.map((frame, index) => index ? registerCompanionWorldBody(frames[0], frame, reference.bounds, asset.frames[index]!.bounds) : { dx: 0, dy: 0, score: 0, samples: 0, core: reference.bounds });
  const registrations = asset.frames.map((frame, index) => {
    const match = matches[index]!, pose = companionWorldFramePose(frame), contact = pose === 'seat' ? frame.contacts.seat : pose === 'bed' ? frame.contacts.bed : frame.contacts.foot;
    // Grounded idle gestures share the measured floor; locomotion retains its
    // airborne frames. Seat/bed contacts preserve actual bending and rolling.
    const y = dynamic ? asset.defaultOrigin?.y ?? Math.max(...asset.frames.map(value => value.contacts.foot?.y ?? anchor.y)) : transition || pose !== referencePose ? contact?.y ?? anchor.y : pose === 'ground' ? frame.bounds.y + frame.bounds.height - 1 : contact?.y ?? anchor.y;
    return { anchor: { x: rounded(anchor.x + match.dx), y: rounded(y) }, method: 'body-core' as const,
      bodyOffset: { x: match.dx, y: match.dy }, score: match.score };
  }) as [NonNullable<WorldArtFrame['registration']>, NonNullable<WorldArtFrame['registration']>, NonNullable<WorldArtFrame['registration']>];
  return { registrations, matches };
}
