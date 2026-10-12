import { z } from 'zod';

/**
 * Library-owned appearance for folders and collections (WorldlineBox-df3049).
 * Unknown stored values must degrade to the default chrome icon, not fail open.
 */

export const ENTITY_APPEARANCE_GLYPH_KINDS = ['emoji', 'icon'] as const;
export type EntityAppearanceGlyphKind = (typeof ENTITY_APPEARANCE_GLYPH_KINDS)[number];

export const ENTITY_APPEARANCE_TARGET_KINDS = [
  'managed-folder',
  'linked-folder',
  'collection',
  'smart-collection',
] as const;
export type EntityAppearanceTargetKind = (typeof ENTITY_APPEARANCE_TARGET_KINDS)[number];

export const ENTITY_APPEARANCE_COLOR_IDS = [
  'blue',
  'indigo',
  'purple',
  'pink',
  'orange',
  'green',
  'teal',
  'red',
] as const;
export type EntityAppearanceColorId = (typeof ENTITY_APPEARANCE_COLOR_IDS)[number];

export interface EntityAppearance {
  readonly glyphKind: EntityAppearanceGlyphKind | null;
  readonly glyphValue: string | null;
  readonly colorId: EntityAppearanceColorId | null;
}

export interface EntityAppearanceTarget {
  readonly kind: EntityAppearanceTargetKind;
  readonly id: string;
}

export interface EntityAppearanceGroup<T extends string = string> {
  readonly id: string;
  readonly labelKey: string;
  readonly items: readonly T[];
}

export const ENTITY_APPEARANCE_EMOJI_GROUPS: readonly EntityAppearanceGroup[] = [
  {
    id: 'faces',
    labelKey: 'appearance.group.faces',
    items: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
      '🙂', '😉', '😍', '🥰', '😘', '😋', '😜', '🤓', '😎', '🥳',
      '🤔', '😐', '🙄', '😏', '😴', '😪', '🥺', '😢', '😭', '😤',
      '😡', '🤬', '🤯', '😈', '💀', '💩', '🤡', '👻', '👽', '😺',
    ],
  },
  {
    id: 'gestures',
    labelKey: 'appearance.group.gestures',
    items: [
      '👋', '🤚', '✋', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👍',
      '👎', '✊', '👊', '👏', '🙌', '🤝', '🙏', '💪', '🫶', '👀',
    ],
  },
  {
    id: 'mood',
    labelKey: 'appearance.group.mood',
    items: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '💕', '💖', '💗', '💘', '💝', '❣️', '💞', '💓', '✨', '🌟',
      '💫', '💯', '💢', '💤',
    ],
  },
  {
    id: 'symbols',
    labelKey: 'appearance.group.symbols',
    items: [
      '✅', '❌', '❓', '❗', '⭕', '🚫', '⚠️', '💬',
      '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪',
    ],
  },
  {
    id: 'media',
    labelKey: 'appearance.group.media',
    items: [
      '🎨', '🖼️', '🎬', '🎥', '📷', '📹', '🎞️', '📺', '🎵', '🎶',
      '🎧', '🎤', '🎹', '🎸', '🥁', '📻', '📡', '🔦', '💡', '🕯️',
    ],
  },
  {
    id: 'design',
    labelKey: 'appearance.group.design',
    items: [
      '✏️', '🖊️', '🖌️', '📐', '📏', '✂️', '📎', '📌', '📍', '🔑',
      '🔒', '💎',
    ],
  },
  {
    id: 'tech',
    labelKey: 'appearance.group.tech',
    items: [
      '💻', '🖥️', '📱', '⌨️', '🎮', '🕹️', '🎲', '🧩', '🎯', '🏆',
      '⚔️', '🛡️', '🚀', '🤖', '👾', '💾',
    ],
  },
  {
    id: 'nature',
    labelKey: 'appearance.group.nature',
    items: [
      '🌲', '🌸', '🌻', '🍀', '🍁', '🌙', '☀️', '⭐', '🌈', '🔥',
      '💧', '❄️', '🌊', '⛰️', '🏝️', '🌍',
    ],
  },
  {
    id: 'animals',
    labelKey: 'appearance.group.animals',
    items: [
      '🐶', '🐱', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐧', '🦋',
      '🐝', '🐙',
    ],
  },
  {
    id: 'places',
    labelKey: 'appearance.group.places',
    items: [
      '🏠', '🏢', '🏭', '🏰', '🚗', '✈️', '🚢', '🚂', '⛺', '🎒',
      '💼', '🎁', '👑', '📦', '🛒', '🏷️',
    ],
  },
  {
    id: 'people',
    labelKey: 'appearance.group.people',
    items: [
      '👤', '👥', '🧙', '🧚', '🦸', '🥷', '👷', '👶',
    ],
  },
];

export const ENTITY_APPEARANCE_ICON_GROUPS: readonly EntityAppearanceGroup[] = [
  {
    id: 'abstract',
    labelKey: 'appearance.group.abstract',
    items: [
      'heart', 'star', 'sparkle', 'smile', 'frown', 'meh', 'thumbs-up', 'thumbs-down',
      'circle', 'square', 'triangle', 'hexagon', 'diamond', 'infinity', 'asterisk', 'hash',
      'award', 'medal', 'flag', 'bell', 'orbit', 'atom', 'clover', 'rainbow',
    ],
  },
  {
    id: 'media',
    labelKey: 'appearance.group.media',
    items: [
      'image', 'images', 'camera', 'video', 'film', 'clapperboard', 'aperture', 'music',
      'headphones', 'mic', 'radio', 'speaker', 'book-open', 'newspaper', 'file-image', 'file-video',
    ],
  },
  {
    id: 'design',
    labelKey: 'appearance.group.design',
    items: [
      'palette', 'brush', 'pen-tool', 'pencil', 'type', 'pipette', 'blend', 'layers',
      'component', 'layout-grid', 'crop', 'frame', 'swatch-book',
    ],
  },
  {
    id: 'game',
    labelKey: 'appearance.group.game',
    items: [
      'gamepad-2', 'dice-5', 'puzzle', 'target', 'trophy', 'sword', 'shield', 'rocket',
      'bot', 'ghost', 'skull', 'wand-2',
    ],
  },
  {
    id: 'nature',
    labelKey: 'appearance.group.nature',
    items: [
      'mountain', 'trees', 'tree-pine', 'flower-2', 'sun', 'moon', 'cloud', 'snowflake',
      'flame', 'droplet', 'waves', 'wind', 'leaf', 'sparkles',
    ],
  },
  {
    id: 'animals',
    labelKey: 'appearance.group.animals',
    items: [
      'paw-print', 'cat', 'dog', 'bird', 'fish', 'bug', 'rabbit',
    ],
  },
  {
    id: 'places',
    labelKey: 'appearance.group.places',
    items: [
      'home', 'building-2', 'landmark', 'factory', 'tent', 'map', 'map-pin', 'compass', 'globe',
    ],
  },
  {
    id: 'transport',
    labelKey: 'appearance.group.transport',
    items: [
      'car', 'plane', 'ship', 'train-front', 'bike',
    ],
  },
  {
    id: 'devices',
    labelKey: 'appearance.group.devices',
    items: [
      'laptop', 'monitor', 'smartphone', 'cpu', 'hard-drive', 'database',
    ],
  },
  {
    id: 'objects',
    labelKey: 'appearance.group.objects',
    items: [
      'lightbulb', 'zap', 'wrench', 'hammer', 'scissors', 'ruler', 'gem', 'crown', 'key', 'lock',
    ],
  },
  {
    id: 'people',
    labelKey: 'appearance.group.people',
    items: [
      'users', 'user', 'shopping-bag', 'briefcase', 'backpack', 'gift', 'calendar', 'bookmark',
    ],
  },
];

export const ENTITY_APPEARANCE_EMOJIS: readonly string[] = ENTITY_APPEARANCE_EMOJI_GROUPS.flatMap(
  (group) => group.items,
);
export const ENTITY_APPEARANCE_ICON_IDS: readonly string[] = ENTITY_APPEARANCE_ICON_GROUPS.flatMap(
  (group) => group.items,
);

const EMOJI_SET = new Set(ENTITY_APPEARANCE_EMOJIS);
const ICON_SET = new Set(ENTITY_APPEARANCE_ICON_IDS);
const COLOR_SET = new Set<string>(ENTITY_APPEARANCE_COLOR_IDS);

export const entityAppearanceSchema = z.strictObject({
  glyphKind: z.enum(ENTITY_APPEARANCE_GLYPH_KINDS).nullable(),
  glyphValue: z.string().max(32).nullable(),
  colorId: z.enum(ENTITY_APPEARANCE_COLOR_IDS).nullable(),
}).nullable();

export const entityAppearanceTargetSchema = z.strictObject({
  kind: z.enum(ENTITY_APPEARANCE_TARGET_KINDS),
  id: z.string().min(1).max(255),
});

export function isCatalogEmoji(value: string): boolean {
  return EMOJI_SET.has(value);
}

export function isCatalogIcon(value: string): boolean {
  return ICON_SET.has(value);
}

export function isCatalogColor(value: string): value is EntityAppearanceColorId {
  return COLOR_SET.has(value);
}

function emptyAppearance(appearance: EntityAppearance): boolean {
  return appearance.glyphKind === null
    && appearance.glyphValue === null
    && appearance.colorId === null;
}

/**
 * Drop unknown catalog values so a library with stale rows still opens.
 * An all-null result is represented as `null` (the default chrome look).
 */
export function sanitizeEntityAppearance(input: {
  glyphKind?: string | null;
  glyphValue?: string | null;
  colorId?: string | null;
} | null | undefined): EntityAppearance | null {
  if (!input) return null;
  const rawKind = input.glyphKind ?? null;
  const rawValue = input.glyphValue ?? null;
  const rawColor = input.colorId ?? null;
  let glyphKind: EntityAppearanceGlyphKind | null = null;
  let glyphValue: string | null = null;
  if (rawKind === 'emoji' && typeof rawValue === 'string' && isCatalogEmoji(rawValue)) {
    glyphKind = 'emoji';
    glyphValue = rawValue;
  } else if (rawKind === 'icon' && typeof rawValue === 'string' && isCatalogIcon(rawValue)) {
    glyphKind = 'icon';
    glyphValue = rawValue;
  }
  const colorId = typeof rawColor === 'string' && isCatalogColor(rawColor) ? rawColor : null;
  const appearance: EntityAppearance = { glyphKind, glyphValue, colorId };
  return emptyAppearance(appearance) ? null : appearance;
}

/**
 * Writes must name catalog entries. `null` clears the stored appearance.
 */
export function parseWritableAppearance(
  input: {
    glyphKind: EntityAppearanceGlyphKind | null;
    glyphValue: string | null;
    colorId: string | null;
  } | null,
): { ok: true; appearance: EntityAppearance | null } | { ok: false } {
  if (input === null) return { ok: true, appearance: null };
  const hasGlyph = input.glyphKind !== null || input.glyphValue !== null;
  if (hasGlyph) {
    if (input.glyphKind === 'emoji') {
      if (typeof input.glyphValue !== 'string' || !isCatalogEmoji(input.glyphValue)) {
        return { ok: false };
      }
    } else if (input.glyphKind === 'icon') {
      if (typeof input.glyphValue !== 'string' || !isCatalogIcon(input.glyphValue)) {
        return { ok: false };
      }
    } else {
      return { ok: false };
    }
  }
  if (input.colorId !== null && !isCatalogColor(input.colorId)) return { ok: false };
  const appearance: EntityAppearance = {
    glyphKind: hasGlyph ? input.glyphKind : null,
    glyphValue: hasGlyph ? input.glyphValue : null,
    colorId: input.colorId !== null && isCatalogColor(input.colorId) ? input.colorId : null,
  };
  return { ok: true, appearance: emptyAppearance(appearance) ? null : appearance };
}
