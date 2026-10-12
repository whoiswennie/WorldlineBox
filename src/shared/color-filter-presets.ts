/** Named color chips and HSL-box matching for discovery filtering. */

import {
  hexToHsl,
  hueDelta,
  isColorHex,
  normalizeColorHex,
  type ColorHsl,
} from "./color-hsl";

export type ColorPresetId =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "purple"
  | "pink"
  | "black"
  | "white";

export type ColorPreset = {
  id: ColorPresetId;
  /** CSS swatch for the dimension popover. */
  swatch: string;
  kind: "hue" | "neutral";
};

export const COLOR_PRESETS: readonly ColorPreset[] = [
  { id: "red", swatch: "#E11D48", kind: "hue" },
  { id: "orange", swatch: "#F97316", kind: "hue" },
  { id: "yellow", swatch: "#EAB308", kind: "hue" },
  { id: "green", swatch: "#22C55E", kind: "hue" },
  { id: "cyan", swatch: "#06B6D4", kind: "hue" },
  { id: "blue", swatch: "#3B82F6", kind: "hue" },
  { id: "purple", swatch: "#A855F7", kind: "hue" },
  { id: "pink", swatch: "#EC4899", kind: "hue" },
  { id: "black", swatch: "#111111", kind: "neutral" },
  { id: "white", swatch: "#F4F4F5", kind: "neutral" },
];

export const DEFAULT_COLOR_SIMILARITY = 30;
export const MIN_COLOR_SIMILARITY = 0;
export const MAX_COLOR_SIMILARITY = 100;

const PRESET_IDS = new Set<string>(COLOR_PRESETS.map((preset) => preset.id));

export function colorPresetById(id: string): ColorPreset | undefined {
  return COLOR_PRESETS.find((preset) => preset.id === id);
}

export function isColorPresetId(value: string): value is ColorPresetId {
  return PRESET_IDS.has(value);
}

export function parseColorFilterIds(raw: string): ColorPresetId[] {
  return parseColorFilterValues(raw).filter(isColorPresetId);
}

/** Preset ids and `#RRGGBB` tokens, dropping unknowns. */
export function parseColorFilterValues(raw: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const normalized = isColorPresetId(trimmed)
      ? trimmed
      : normalizeColorHex(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

export type ColorMatchWindows = {
  hueSpan: number;
  satDelta: number;
  lightDelta: number;
  chromaticSatFloor: number;
  neutralSatMax: number;
};

function clampSimilarity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COLOR_SIMILARITY;
  return Math.min(
    MAX_COLOR_SIMILARITY,
    Math.max(MIN_COLOR_SIMILARITY, Math.round(value)),
  );
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function colorMatchWindows(similarity: number): ColorMatchWindows {
  const t = clampSimilarity(similarity) / 100;
  return {
    hueSpan: lerp(55, 10, t),
    satDelta: lerp(0.5, 0.1, t),
    lightDelta: lerp(0.42, 0.1, t),
    chromaticSatFloor: lerp(0.08, 0.22, t),
    neutralSatMax: lerp(0.55, 0.28, t),
  };
}

export function isChromaticHsl(color: ColorHsl): boolean {
  return color.saturation >= 0.12 && color.lightness > 0.08 && color.lightness < 0.92;
}

export function resolveColorFilterTarget(
  value: string,
  swatches?: Readonly<Record<string, string>>,
): ColorHsl | null {
  if (isColorPresetId(value)) {
    const override = swatches?.[value];
    const hex = override && isColorHex(override)
      ? override
      : colorPresetById(value)?.swatch;
    return hex ? hexToHsl(hex) : null;
  }
  const hex = normalizeColorHex(value);
  return hex ? hexToHsl(hex) : null;
}

export function sampleMatchesTarget(
  sample: ColorHsl,
  target: ColorHsl,
  similarity: number = DEFAULT_COLOR_SIMILARITY,
): boolean {
  const windows = colorMatchWindows(similarity);
  if (!isChromaticHsl(target)) {
    return (
      sample.saturation <= windows.neutralSatMax &&
      Math.abs(sample.lightness - target.lightness) <= windows.lightDelta
    );
  }
  const minSat = Math.max(
    windows.chromaticSatFloor,
    target.saturation - windows.satDelta,
  );
  if (sample.saturation < minSat) return false;
  if (Math.abs(sample.saturation - target.saturation) > windows.satDelta) {
    return false;
  }
  if (Math.abs(sample.lightness - target.lightness) > windows.lightDelta) {
    return false;
  }
  return hueDelta(sample.hue, target.hue) <= windows.hueSpan;
}

export function sampleMatchesColorFilter(
  sample: ColorHsl,
  values: readonly string[],
  options?: {
    similarity?: number;
    swatches?: Readonly<Record<string, string>>;
  },
): boolean {
  const similarity = options?.similarity ?? DEFAULT_COLOR_SIMILARITY;
  for (const value of values) {
    const target = resolveColorFilterTarget(value, options?.swatches);
    if (target && sampleMatchesTarget(sample, target, similarity)) return true;
  }
  return false;
}

function hueWindowSql(
  column: string,
  center: number,
  span: number,
): { sql: string; params: number[] } {
  if (span >= 180) return { sql: "1 = 1", params: [] };
  const lo = center - span;
  const hi = center + span;
  if (lo >= 0 && hi < 360) {
    return {
      sql: `(${column} >= ? AND ${column} < ?)`,
      params: [lo, hi],
    };
  }
  if (lo < 0) {
    return {
      sql: `(${column} >= ? OR ${column} < ?)`,
      params: [360 + lo, hi],
    };
  }
  return {
    sql: `(${column} >= ? OR ${column} < ?)`,
    params: [lo, hi - 360],
  };
}

function targetMatchSql(
  hueColumn: string,
  saturationColumn: string,
  lightnessColumn: string,
  target: ColorHsl,
  similarity: number,
): { sql: string; params: number[] } {
  const windows = colorMatchWindows(similarity);
  if (!isChromaticHsl(target)) {
    return {
      sql: `(COALESCE(${saturationColumn}, 0) <= ? AND ${lightnessColumn} IS NOT NULL AND abs(${lightnessColumn} - ?) <= ?)`,
      params: [windows.neutralSatMax, target.lightness, windows.lightDelta],
    };
  }
  const minSat = Math.max(
    windows.chromaticSatFloor,
    target.saturation - windows.satDelta,
  );
  const hue = hueWindowSql(hueColumn, target.hue, windows.hueSpan);
  return {
    sql: `(${saturationColumn} IS NOT NULL AND ${saturationColumn} >= ? AND abs(${saturationColumn} - ?) <= ? AND ${lightnessColumn} IS NOT NULL AND abs(${lightnessColumn} - ?) <= ? AND ${hue.sql})`,
    params: [
      minSat,
      target.saturation,
      windows.satDelta,
      target.lightness,
      windows.lightDelta,
      ...hue.params,
    ],
  };
}

export type ColorFilterSqlInput = {
  hueColumn: string;
  saturationColumn?: string;
  lightnessColumn?: string;
  values: readonly string[];
  exclude: boolean;
  similarity?: number;
  swatches?: Readonly<Record<string, string>>;
};

/**
 * Build SQL fragment + params matching any selected colour target.
 * Chromatic chips require saturation so greyscale (hue often stored as 0)
 * cannot satisfy "red".
 */
export function colorFilterSql(
  hueColumnOrInput: string | ColorFilterSqlInput,
  ids?: readonly string[],
  exclude?: boolean,
  lightnessColumn?: string,
): { sql: string; params: number[] } | null {
  const input: ColorFilterSqlInput = typeof hueColumnOrInput === "string"
    ? {
        hueColumn: hueColumnOrInput,
        values: ids ?? [],
        exclude: exclude === true,
        lightnessColumn,
      }
    : hueColumnOrInput;
  const hueColumn = input.hueColumn;
  const saturationColumn = input.saturationColumn ?? "palette_meta.dominant_saturation";
  const lightColumn = input.lightnessColumn ?? "palette_meta.dominant_lightness";
  const similarity = input.similarity ?? DEFAULT_COLOR_SIMILARITY;
  const clauses: string[] = [];
  const params: number[] = [];
  for (const value of input.values) {
    const target = resolveColorFilterTarget(value, input.swatches);
    if (!target) continue;
    const built = targetMatchSql(
      hueColumn,
      saturationColumn,
      lightColumn,
      target,
      similarity,
    );
    clauses.push(built.sql);
    params.push(...built.params);
  }
  if (clauses.length === 0) return null;
  const matchAny = clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`;
  if (input.exclude) {
    return {
      sql: `(NOT ${matchAny} OR (${hueColumn} IS NULL AND ${lightColumn} IS NULL AND ${saturationColumn} IS NULL))`,
      params,
    };
  }
  return { sql: matchAny, params };
}
