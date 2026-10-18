import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  applyShadowPreferences,
  clampShadowLevel,
  loadShadowPreferences,
  setStoredShadowLevel,
  setStoredShadowValues,
  type ShadowLevel,
  type ShadowPreferences,
  type ShadowPreferencesStorage,
} from "./shadow-preferences";

type ElevationContextValue = {
  readonly preferences: ShadowPreferences;
  readonly setLevel: (level: ShadowLevel) => void;
  /** Continuous 0–100 axes (a87 2D pad). */
  readonly setValues: (size: number, intensity: number) => void;
};

const ElevationContext = createContext<ElevationContextValue | null>(null);

export type ElevationProviderProps = {
  readonly children: ReactNode;
  readonly storage?: ShadowPreferencesStorage;
  readonly initialPreferences?: ShadowPreferences;
};

/**
 * Elevation prefs (WorldlineBox-zcyg, a87): continuous size × intensity (0–100)
 * drive CSS `--elev-*` multipliers; either axis ~0 omits elevation shadows.
 */
export function ElevationProvider({
  children,
  storage,
  initialPreferences,
}: ElevationProviderProps) {
  const [preferences, setPreferences] = useState<ShadowPreferences>(
    () => initialPreferences ?? loadShadowPreferences(storage),
  );

  useEffect(() => {
    applyShadowPreferences(preferences);
  }, [preferences]);

  const setLevel = useCallback(
    (level: ShadowLevel) => {
      setPreferences(setStoredShadowLevel(clampShadowLevel(level), storage));
    },
    [storage],
  );

  const setValues = useCallback(
    (size: number, intensity: number) => {
      setPreferences(setStoredShadowValues(size, intensity, storage));
    },
    [storage],
  );

  const value = useMemo(
    () => ({ preferences, setLevel, setValues }),
    [preferences, setLevel, setValues],
  );

  return (
    <ElevationContext.Provider value={value}>
      {children}
    </ElevationContext.Provider>
  );
}

export function useElevation(): ElevationContextValue {
  const value = useContext(ElevationContext);
  if (!value) {
    throw new Error("useElevation must be used within ElevationProvider");
  }
  return value;
}
