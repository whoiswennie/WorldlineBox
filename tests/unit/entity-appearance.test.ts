import { describe, expect, it } from 'vitest';

import {
  ENTITY_APPEARANCE_COLOR_IDS,
  ENTITY_APPEARANCE_EMOJIS,
  ENTITY_APPEARANCE_ICON_IDS,
  parseWritableAppearance,
  sanitizeEntityAppearance,
} from '../../src/shared/entity-appearance';
import { APPEARANCE_ICON_PATHS } from '../../src/renderer/appearance-icon-paths';

describe('entity appearance catalog', () => {
  it('keeps unique first-batch emoji, icon, and color ids', () => {
    expect(ENTITY_APPEARANCE_EMOJIS).toHaveLength(200);
    expect(new Set(ENTITY_APPEARANCE_EMOJIS).size).toBe(200);
    expect(ENTITY_APPEARANCE_ICON_IDS).toHaveLength(124);
    expect(new Set(ENTITY_APPEARANCE_ICON_IDS).size).toBe(124);
    expect(ENTITY_APPEARANCE_COLOR_IDS).toHaveLength(8);
    expect(new Set(ENTITY_APPEARANCE_COLOR_IDS).size).toBe(8);
  });

  it('has a decorative path for every catalog icon', () => {
    for (const iconId of ENTITY_APPEARANCE_ICON_IDS) {
      expect(APPEARANCE_ICON_PATHS[iconId], iconId).toBeTruthy();
    }
  });
});

describe('sanitizeEntityAppearance', () => {
  it('keeps catalog emoji, icon, and color values', () => {
    expect(sanitizeEntityAppearance({
      glyphKind: 'emoji',
      glyphValue: '🎨',
      colorId: 'blue',
    })).toEqual({ glyphKind: 'emoji', glyphValue: '🎨', colorId: 'blue' });
    expect(sanitizeEntityAppearance({
      glyphKind: 'icon',
      glyphValue: 'palette',
      colorId: 'purple',
    })).toEqual({ glyphKind: 'icon', glyphValue: 'palette', colorId: 'purple' });
  });

  it('drops unknown values so a library still opens as the default look', () => {
    expect(sanitizeEntityAppearance({
      glyphKind: 'emoji',
      glyphValue: '🏳️',
      colorId: 'neon',
    })).toBeNull();
    expect(sanitizeEntityAppearance({
      glyphKind: 'icon',
      glyphValue: 'trash',
      colorId: 'blue',
    })).toEqual({ glyphKind: null, glyphValue: null, colorId: 'blue' });
  });
});

describe('parseWritableAppearance', () => {
  it('accepts catalog writes and null clears', () => {
    expect(parseWritableAppearance({
      glyphKind: 'emoji',
      glyphValue: '🐶',
      colorId: null,
    })).toEqual({
      ok: true,
      appearance: { glyphKind: 'emoji', glyphValue: '🐶', colorId: null },
    });
    expect(parseWritableAppearance(null)).toEqual({ ok: true, appearance: null });
    expect(parseWritableAppearance({
      glyphKind: null,
      glyphValue: null,
      colorId: null,
    })).toEqual({ ok: true, appearance: null });
  });

  it('rejects values outside the catalog', () => {
    expect(parseWritableAppearance({
      glyphKind: 'emoji',
      glyphValue: 'not-an-emoji',
      colorId: null,
    })).toEqual({ ok: false });
    expect(parseWritableAppearance({
      glyphKind: 'icon',
      glyphValue: 'settings',
      colorId: 'blue',
    })).toEqual({ ok: false });
    expect(parseWritableAppearance({
      glyphKind: null,
      glyphValue: null,
      colorId: 'chartreuse',
    })).toEqual({ ok: false });
  });
});
