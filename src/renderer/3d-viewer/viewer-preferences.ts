/**
 * Persisted 3D viewer preferences (toolbar state, spec 3D-09 / 3D-10).
 *
 * The HDRI preset, environment light, display mode, double-sided drawing,
 * and the model info overlay survive restarts. Values are validated on read.
 * Storage is injected so tests can use a plain object.
 */

import {
  DEFAULT_LIGHT_INTENSITY,
  clampLightIntensity,
  parseLightIntensity,
} from './light-intensity';
import {
  DEFAULT_HDRI_PRESET_ID,
  parseHdriPresetId,
  type HdriPresetId,
} from './hdri-presets';
import {
  DEFAULT_DISPLAY_MODE,
  MODEL_DISPLAY_MODES,
  type ModelDisplayMode,
} from './model-display-mode';

export const VIEWER3D_PREFERENCES_KEY = 'worldlinebox.viewer3d.preferences';

export interface Viewer3dPreferences {
  presetId: HdriPresetId;
  /** Environment light intensity (replaces the old "exposure" semantics). */
  lightIntensity: number;
  /** Display mode (PBR / wireframe / gray-shaded, WorldlineBox-fkhe). */
  displayMode: ModelDisplayMode;
  /** Draw both faces. Off leaves each material's own side unchanged. */
  doubleSided: boolean;
  /** Model info overlay. Closed until the user opens it. */
  statsVisible: boolean;
}

export const DEFAULT_VIEWER3D_PREFERENCES: Viewer3dPreferences = {
  presetId: DEFAULT_HDRI_PRESET_ID,
  lightIntensity: DEFAULT_LIGHT_INTENSITY,
  displayMode: DEFAULT_DISPLAY_MODE,
  doubleSided: false,
  statsVisible: false,
};

export interface Viewer3dPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseViewer3dPreferences(input: unknown): Viewer3dPreferences {
  if (typeof input !== 'object' || input === null) {
    return DEFAULT_VIEWER3D_PREFERENCES;
  }
  const candidate = input as Record<string, unknown>;
  return {
    presetId: parseHdriPresetId(candidate.presetId),
    // Legacy records stored the value under `exposure`; the numeric range is
    // unchanged, so it migrates straight across.
    lightIntensity: parseLightIntensity(
      candidate.lightIntensity ?? candidate.exposure,
    ),
    displayMode: MODEL_DISPLAY_MODES.includes(candidate.displayMode as ModelDisplayMode)
      ? (candidate.displayMode as ModelDisplayMode)
      : DEFAULT_DISPLAY_MODE,
    doubleSided: candidate.doubleSided === true,
    statsVisible: candidate.statsVisible === true,
  };
}

export function loadViewer3dPreferences(
  storage?: Viewer3dPreferencesStorage,
): Viewer3dPreferences {
  if (!storage) return DEFAULT_VIEWER3D_PREFERENCES;
  const raw = storage.getItem(VIEWER3D_PREFERENCES_KEY);
  if (raw === null) return DEFAULT_VIEWER3D_PREFERENCES;
  try {
    return parseViewer3dPreferences(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_VIEWER3D_PREFERENCES;
  }
}

export function saveViewer3dPreferences(
  preferences: Viewer3dPreferences,
  storage?: Viewer3dPreferencesStorage,
): void {
  if (!storage) return;
  storage.setItem(
    VIEWER3D_PREFERENCES_KEY,
    JSON.stringify({
      presetId: preferences.presetId,
      lightIntensity: clampLightIntensity(preferences.lightIntensity),
      displayMode: preferences.displayMode,
      doubleSided: preferences.doubleSided === true,
      statsVisible: preferences.statsVisible === true,
    }),
  );
}
