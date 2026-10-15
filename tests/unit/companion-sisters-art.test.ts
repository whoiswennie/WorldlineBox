import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import data from '../../src/shared/companion-world-art-data.json';
import provenance from '../../assets/companions/appearance/manifest.json';
import { WORLD_ART_ACTIONS, worldCharacterArt } from '../../src/shared/companion-world-art';
import { getCompanionWorldFramePlacement } from '../../src/shared/companion-world-art-calibration';

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

it('binds every independent sister action to the delivered canonical identity rather than obsolete art or a temporary board', () => {
  const hashes = new Set<string>();
  for (const id of ['sister', 'flash'] as const) {
    const character = provenance.characters.find(value => value.id === id)!;
    for (const ref of character.references) expect(sha(ref.path)).toBe(ref.sha256);
    for (const action of WORLD_ART_ACTIONS) {
      const source = data[id].actions[action].source;
      expect(source.kind).toBe('builtin-imagegen'); expect(source.action).toBe(action);
      expect(source.references).toEqual(character.references);
      expect(source.prompt).toContain('Original action intent:'); expect(source.prompt).toContain(action);
      hashes.add(source.sha256);
    }
  }
  expect(hashes.size).toBe(62);
  const flash = provenance.characters.find(value => value.id === 'flash')!;
  expect(flash.assets[0]).toMatchObject({ method: 'user-provided-exact', width: 1260, height: 703, sha256: '187836c4856532f8db0515c3c5820e2315fa616a4d92705265a239f4c74ccc27' });
  expect(existsSync('assets/companions/deepseek-sister.jpg')).toBe(false);
  expect(existsSync('assets/companions/deepseek-flash.jpg')).toBe(false);
  expect(existsSync('assets/companions/deepseek.jpg')).toBe(true);
});

it('displays the smaller lie-down/wake framing at the idle anatomical height with one scale for the complete transition', () => {
  for (const id of ['sister', 'flash']) {
    const character = worldCharacterArt(id)!;
    const idle = provenance.scaleReviews.find(value => value.avatar === id && value.action === 'idle')!;
    for (const action of ['lieDown', 'wake', 'sitDown', 'standUp'] as const) {
      const review = provenance.scaleReviews.find(value => value.avatar === id && value.action === action)!;
      const asset = character.actions[action]!;
      const scales = [0, 1, 2].map(index => getCompanionWorldFramePlacement(character, asset, index).scale);
      expect(new Set(scales).size).toBe(1);
      expect(scales[0]! * review.span!).toBeCloseTo(getCompanionWorldFramePlacement(character, character.actions.idle!, 0).scale * idle.span!, 3);
    }
    const sleep = character.actions.sleep!;
    expect(sleep.neutralHeightPixels).toBeGreaterThan(sleep.frames[0].bounds.height * 1.3);
    for (const [index, frame] of sleep.frames.entries()) {
      expect(getCompanionWorldFramePlacement(character, sleep, index).anchor).toEqual(frame.contacts.bed);
    }
  }
});
