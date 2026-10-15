import { expect, it } from 'vitest';
import { worldCharacterArt, WORLD_ART_ACTIONS } from '../../src/shared/companion-world-art';
import { getCompanionWorldFramePlacement } from '../../src/shared/companion-world-art-calibration';

for (const id of ['guga', 'gugugaga']) it(id + ' keeps reviewed seat and bed anchors instead of translating a rolling face', () => {
  const character = worldCharacterArt(id)!;
  expect(Object.keys(character.actions)).toHaveLength(WORLD_ART_ACTIONS.length);
  for (const action of ['read', 'work', 'sit', 'rest', 'sleep', 'sitDown', 'standUp', 'lieDown', 'wake', 'phoneTypingSeated', 'phoneCallingSeated'] as const) {
    const asset = character.actions[action]!;
    asset.frames.forEach((frame, index) => {
      const placement = getCompanionWorldFramePlacement(character, asset, index);
      const contact = placement.pose === 'bed' ? frame.contacts.bed : placement.pose === 'seat' ? frame.contacts.seat : frame.contacts.foot;
      if (contact) expect(placement.anchor).toEqual(contact);
      expect(placement.scale).toBe(getCompanionWorldFramePlacement(character, asset, 0).scale);
    });
  }
});
