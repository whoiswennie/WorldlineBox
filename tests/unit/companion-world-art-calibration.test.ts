import { describe, expect, it } from 'vitest';
import { calibrateCompanionWorldSheet, getCompanionWorldFramePlacement, registerCompanionWorldBody } from '../../src/shared/companion-world-art-calibration';
import type { WorldArtFrame, WorldArtSheet, WorldCharacterArt } from '../../src/shared/companion-world-art';
import { WORLD_ART_ACTIONS, WORLD_ART_CHARACTER_IDS, worldCharacterArt } from '../../src/shared/companion-world-art';

function pixels(dx = 0, dy = 0, gesture = false) {
  const width = 80, height = 80, rgba = new Uint8Array(width * height * 4);
  const rect = (x: number, y: number, w: number, h: number, color: number[]) => {
    for (let row = y + dy; row < y + dy + h; row++) for (let col = x + dx; col < x + dx + w; col++) if (row >= 0 && col >= 0 && row < height && col < width) rgba.set([...color, 255], (row * width + col) * 4);
  };
  rect(25, 10, 18, 19, [240, 195, 165]); // face
  rect(27, 29, 15, 27, [28, 55, 91]); // compact trunk
  rect(30, 30, 3, 26, [210, 165, 80]); // stable clothing feature
  rect(26, 56, 6, 9, [38, 33, 45]); rect(37, 56, 6, 9, [38, 33, 45]);
  if (gesture) rect(0, 31, 27, 8, [240, 195, 165]); // very long moving arm
  else rect(22, 31, 5, 18, [240, 195, 165]);
  return { rgba, width, height };
}
function frame(x = 0, y = 0): WorldArtFrame {
  return { bounds: { x: 22 + x, y: 10 + y, width: 21, height: 55 }, contacts: {
    posture: 'standing', origin: { x: 40, y: 70 }, foot: { x: 34 + x, y: 64 + y }, seat: null, pelvis: null, bed: null, back: null } };
}
function sheet(frames: [WorldArtFrame, WorldArtFrame, WorldArtFrame] = [frame(), frame(), frame()]): WorldArtSheet {
  return { url: 'synthetic.webp', frameWidth: 80, frameHeight: 80, frameCount: 3, sha256: 'fixture', durationMs: 900, playback: 'loop', frames };
}
const character = { id: 'fixture', heightTiles: 2, neutralHeightPixels: 55, defaultOrigin: { x: 40, y: 70 }, cell: { width: 80, height: 80 }, actions: {} } satisfies WorldCharacterArt;

describe('sprite frame body registration', () => {
  it('matches the compact face and trunk despite a large arm gesture and unequal transparent framing', () => {
    const source = pixels(), target = pixels(13, 4, true);
    const registration = registerCompanionWorldBody(source, target, frame().bounds, { x: 13, y: 14, width: 43, height: 55 });
    expect(registration.dx).toBe(13); expect(registration.dy).toBe(4);
    expect(registration.samples).toBeGreaterThan(10);
  });
  it('corrects per-cell translation without using the changing silhouette centre of mass', () => {
    const asset = sheet([frame(), frame(13, 4), frame(-9, 0)]);
    const result = calibrateCompanionWorldSheet(asset, 'idle', [pixels(), pixels(13, 4, true), pixels(-9)]);
    expect(result.registrations.map(value => value.anchor.x)).toEqual([34, 47, 25]);
    expect(result.registrations.map(value => value.anchor.y)).toEqual([64, 68, 64]);
  });
  it.each(['walk', 'run', 'follow', 'exercise'])('preserves legitimate vertical body movement in %s rather than pinning every foot to the floor', action => {
    const asset = sheet([frame(), frame(8, -6), frame(-5, 2)]);
    const result = calibrateCompanionWorldSheet(asset, action, [pixels(), pixels(8, -6), pixels(-5, 2)]);
    expect(result.registrations.map(value => value.anchor.y)).toEqual([66, 66, 66]);
    expect(result.matches[1]!.dy).toBe(-6); // pixels still rise; only the registration ground plane stays put
  });
  it('returns exact source cells, one scale for the whole action, and a frame-specific registered root', () => {
    const asset = sheet(); asset.neutralHeightPixels = 50;
    asset.frames[1].registration = { anchor: { x: 25, y: 64 }, method: 'reviewed', bodyOffset: { x: -9, y: 0 }, score: 0 };
    const placed = getCompanionWorldFramePlacement(character, asset, 1);
    expect(placed).toEqual({ source: { x: 80, y: 0, width: 80, height: 80 }, sourceImage: { width: 240, height: 80 }, anchor: { x: 25, y: 64 }, scale: .04, pose: 'ground' });
    expect(getCompanionWorldFramePlacement(character, asset, 2).scale).toBe(placed.scale);
  });
  it('keeps semantic seat and bed attachment separate from ground roots', () => {
    const asset = sheet(); asset.frames[0].contacts.posture = 'sitting'; asset.frames[0].contacts.seat = { x: 30, y: 44 };
    asset.frames[1].contacts.posture = 'transition'; asset.frames[1].contacts.bed = { x: 35, y: 48 };
    expect(getCompanionWorldFramePlacement(character, asset, 0)).toMatchObject({ pose: 'seat', anchor: { x: 30, y: 44 } });
    expect(getCompanionWorldFramePlacement(character, asset, 1)).toMatchObject({ pose: 'bed', anchor: { x: 35, y: 48 } });
  });
  it('keeps a sleeping back on its reviewed bed point when face colours move or a hand obscures the cheek', () => {
    const asset = sheet([frame(), frame(13, 4), frame(-9)]);
    for (const [index, value] of asset.frames.entries()) {
      value.contacts.posture = 'lying'; value.contacts.bed = { x: 35 + index, y: 48 };
    }
    const result = calibrateCompanionWorldSheet(asset, 'sleep', [pixels(), pixels(13, 4, true), pixels(-9)]);
    expect(result.matches[1]!.dx).toBe(13);
    expect(result.registrations.map(value => value.anchor)).toEqual([{ x: 35, y: 48 }, { x: 36, y: 48 }, { x: 37, y: 48 }]);
    expect(result.registrations.every(value => value.method === 'reviewed')).toBe(true);
  });
  it('attaches each mechanical transition to its actual foot, pelvis or bed rather than translating by the moving face', () => {
    const asset = sheet([frame(), frame(13, 4), frame(-9)]); asset.playback = 'transition';
    asset.frames[1].contacts.posture = 'transition'; asset.frames[1].contacts.bed = { x: 45, y: 48 };
    asset.frames[2].contacts.posture = 'lying'; asset.frames[2].contacts.bed = { x: 32, y: 50 };
    const result = calibrateCompanionWorldSheet(asset, 'lieDown', [pixels(), pixels(13, 4), pixels(-9)]);
    expect(result.registrations.map(value => value.anchor)).toEqual([{ x: 34, y: 64 }, { x: 45, y: 48 }, { x: 32, y: 50 }]);
  });
  it('declares finite per-frame registration for every independently authored built-in action', () => {
    expect(WORLD_ART_CHARACTER_IDS).toHaveLength(15);
    let count = 0;
    for (const id of WORLD_ART_CHARACTER_IDS) for (const action of WORLD_ART_ACTIONS) {
      const art = worldCharacterArt(id)!, asset = art.actions[action]!;
      expect(asset, id + '/' + action).toBeDefined();
      for (let frameIndex = 0; frameIndex < 3; frameIndex++) {
        const registration = asset.frames[frameIndex]!.registration!;
        expect(registration, id + '/' + action + '/' + frameIndex).toBeDefined();
        expect(Number.isFinite(registration.anchor.x) && Number.isFinite(registration.anchor.y)).toBe(true);
        expect(getCompanionWorldFramePlacement(art, asset, frameIndex).source.x).toBe(frameIndex * asset.frameWidth);
        count++;
      }
    }
    expect(count).toBe(1395);
  });
});
