// ---------------------------------------------------------------------------
// Per-device shortcut override storage schema.
//
// Only deviations from the catalog defaults are stored. A missing action id
// means "use the default"; null means "the user explicitly unassigned the
// primary chord". Unknown ids are preserved so a downgrade/upgrade does not
// destroy data.
// ---------------------------------------------------------------------------

import { z } from "zod";

import {
  findShortcutAction,
  type ShortcutChord,
  type ShortcutPlatform,
} from "./shortcut-catalog";

export const SHORTCUT_BINDINGS_VERSION = 1 as const;

export type ShortcutOverride = ShortcutChord | null;

export type ShortcutPlatformBindings = Readonly<
  Record<string, ShortcutOverride>
>;

export type ShortcutBindings = {
  readonly version: typeof SHORTCUT_BINDINGS_VERSION;
  readonly platforms: {
    readonly mac: ShortcutPlatformBindings;
    readonly windows: ShortcutPlatformBindings;
  };
};

export const DEFAULT_SHORTCUT_BINDINGS: ShortcutBindings = Object.freeze({
  version: SHORTCUT_BINDINGS_VERSION,
  platforms: Object.freeze({
    mac: Object.freeze({}),
    windows: Object.freeze({}),
  }),
});

const shortcutChordSchema = z.strictObject({
  key: z.string().min(1),
  code: z.string().min(1).optional(),
  metaKey: z.boolean().optional(),
  ctrlKey: z.boolean().optional(),
  altKey: z.boolean().optional(),
  shiftKey: z.boolean().optional(),
});

function parsePlatformBindings(input: unknown): ShortcutPlatformBindings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const next: Record<string, ShortcutOverride> = {};
  for (const [actionId, value] of Object.entries(input as Record<string, unknown>)) {
    if (actionId.length === 0) continue;
    if (value === null) {
      next[actionId] = null;
      continue;
    }
    const parsed = shortcutChordSchema.safeParse(value);
    if (parsed.success) next[actionId] = parsed.data;
  }
  return next;
}

export function parseShortcutChord(input: unknown): ShortcutChord | null {
  const parsed = shortcutChordSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * Best-effort parse: a single malformed entry is dropped, while valid entries
 * and unknown action ids survive. A completely malformed file falls back to
 * the empty default.
 */
export function parseShortcutBindings(input: unknown): ShortcutBindings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return DEFAULT_SHORTCUT_BINDINGS;
  }
  const record = input as {
    version?: unknown;
    platforms?: unknown;
  };
  if (record.version !== SHORTCUT_BINDINGS_VERSION) {
    return DEFAULT_SHORTCUT_BINDINGS;
  }
  const platforms =
    record.platforms && typeof record.platforms === "object" && !Array.isArray(record.platforms)
      ? (record.platforms as Record<string, unknown>)
      : {};
  return {
    version: SHORTCUT_BINDINGS_VERSION,
    platforms: {
      mac: dropFixedActionOverrides(parsePlatformBindings(platforms.mac)),
      windows: dropFixedActionOverrides(parsePlatformBindings(platforms.windows)),
    },
  };
}

function dropFixedActionOverrides(
  bindings: ShortcutPlatformBindings,
): ShortcutPlatformBindings {
  const next: Record<string, ShortcutOverride> = {};
  for (const [actionId, override] of Object.entries(bindings)) {
    const action = findShortcutAction(actionId);
    if (action?.customizable === false) continue;
    next[actionId] = override;
  }
  return next;
}

export function platformBindings(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
): ShortcutPlatformBindings {
  return bindings.platforms[platform];
}

export function withPlatformBindings(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
  next: ShortcutPlatformBindings,
): ShortcutBindings {
  return {
    version: SHORTCUT_BINDINGS_VERSION,
    platforms: {
      ...bindings.platforms,
      [platform]: next,
    },
  };
}

export function setShortcutOverride(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
  actionId: string,
  override: ShortcutOverride,
): ShortcutBindings {
  const current = platformBindings(bindings, platform);
  return withPlatformBindings(bindings, platform, {
    ...current,
    [actionId]: override,
  });
}

export function setShortcutOverrides(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
  overrides: Readonly<Record<string, ShortcutOverride>>,
): ShortcutBindings {
  const current = platformBindings(bindings, platform);
  return withPlatformBindings(bindings, platform, {
    ...current,
    ...overrides,
  });
}

export function clearShortcutOverride(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
  actionId: string,
): ShortcutBindings {
  const current = { ...platformBindings(bindings, platform) };
  delete current[actionId];
  return withPlatformBindings(bindings, platform, current);
}

export function clearPlatformOverrides(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
): ShortcutBindings {
  return withPlatformBindings(bindings, platform, {});
}

export function hasShortcutOverride(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
  actionId: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    platformBindings(bindings, platform),
    actionId,
  );
}

export function shortcutPlatformFromProcess(platform: string): ShortcutPlatform {
  return platform === "darwin" ? "mac" : "windows";
}

export function shortcutPlatformFromUserAgent(userAgent: string): ShortcutPlatform {
  return userAgent.includes("Mac") && !userAgent.includes("Mobile")
    ? "mac"
    : "windows";
}
