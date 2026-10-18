import { useCallback, useEffect, useRef, useState } from "react";

import {
  clampViewerVolume,
  DEFAULT_VIEWER_VOLUME_PREFERENCES,
  loadViewerVolumePreferences,
  matchViewerVolumeKey,
  saveViewerVolumePreferences,
  stepViewerVolumeLevel,
  type ViewerVolumeDirection,
  type ViewerVolumePreferences,
} from "./viewer-volume-preferences";
import type { ShortcutEventLike } from "../shared/shortcut-resolution";
import { listenForShortcutInputs } from "./shortcut-runtime";
import { hasActiveModalDialog } from "./use-dialog-focus-trap";

const VIEWER_VOLUME_UPDATED_EVENT = "worldlinebox:viewer-volume-updated";

export function useViewerVolume(
  enabled = true,
): {
  volume: number;
  muted: boolean;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
} {
  const [prefs, setPrefs] = useState<ViewerVolumePreferences>(() =>
    loadViewerVolumePreferences(),
  );
  const prefsRef = useRef(prefs);

  useEffect(() => {
    const onPreferencesChanged = (event: Event) => {
      const next = (event as CustomEvent<ViewerVolumePreferences>).detail;
      if (!next) return;
      prefsRef.current = next;
      setPrefs(next);
    };
    window.addEventListener(VIEWER_VOLUME_UPDATED_EVENT, onPreferencesChanged);
    return () => window.removeEventListener(VIEWER_VOLUME_UPDATED_EVENT, onPreferencesChanged);
  }, []);

  /** Always derive next prefs from previous state so rapid drag updates never race. */
  const commit = useCallback(
    (updater: (prev: ViewerVolumePreferences) => ViewerVolumePreferences) => {
      const next = updater(prefsRef.current);
      prefsRef.current = next;
      saveViewerVolumePreferences(next);
      setPrefs(next);
      window.dispatchEvent(
        new CustomEvent(VIEWER_VOLUME_UPDATED_EVENT, { detail: next }),
      );
    },
    [],
  );

  const setVolume = useCallback(
    (volume: number) => {
      const clamped = clampViewerVolume(volume);
      commit(() => ({
        version: 1,
        volume: clamped,
        muted: clamped === 0,
      }));
    },
    [commit],
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      commit((prev) => {
        if (muted) {
          return { version: 1, volume: prev.volume, muted: true };
        }
        // Unmute must restore audible gain when the slider is parked at 0.
        const volume =
          prev.volume > 0
            ? prev.volume
            : DEFAULT_VIEWER_VOLUME_PREFERENCES.volume;
        return { version: 1, volume, muted: false };
      });
    },
    [commit],
  );

  const adjustVolume = useCallback(
    (direction: ViewerVolumeDirection) => {
      commit((prev) => {
        const nextVolume = stepViewerVolumeLevel(prev.volume, direction);
        return {
          version: 1,
          volume: nextVolume,
          muted: nextVolume === 0,
        };
      });
    },
    [commit],
  );

  useEffect(() => {
    if (!enabled) return;
    const onShortcutInput = (input: ShortcutEventLike, event: KeyboardEvent | MouseEvent) => {
      if (hasActiveModalDialog()) return;
      const direction = matchViewerVolumeKey({ ...input, target: event.target });
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      adjustVolume(direction);
    };
    return listenForShortcutInputs(window, onShortcutInput, true);
  }, [adjustVolume, enabled]);

  return {
    volume: prefs.volume,
    muted: prefs.muted,
    setVolume,
    setMuted,
  };
}
