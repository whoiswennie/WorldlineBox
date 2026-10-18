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
  applyRadiusPreferences,
  clampRadiusLevel,
  loadRadiusPreferences,
  setStoredRadiusLevel,
  type RadiusLevel,
  type RadiusPreferences,
  type RadiusPreferencesStorage,
} from "./radius-preferences";

type RadiusContextValue = {
  readonly preferences: RadiusPreferences;
  readonly setLevel: (level: RadiusLevel) => void;
};

const RadiusContext = createContext<RadiusContextValue | null>(null);

export type RadiusProviderProps = {
  readonly children: ReactNode;
  readonly storage?: RadiusPreferencesStorage;
  readonly initialPreferences?: RadiusPreferences;
};

/** Corner-radius tiers (0–3) drive CSS `--ui-radius-*` tokens. */
export function RadiusProvider({
  children,
  storage,
  initialPreferences,
}: RadiusProviderProps) {
  const [preferences, setPreferences] = useState<RadiusPreferences>(
    () => initialPreferences ?? loadRadiusPreferences(storage),
  );

  useEffect(() => {
    applyRadiusPreferences(preferences);
  }, [preferences]);

  const setLevel = useCallback(
    (level: RadiusLevel) => {
      setPreferences(setStoredRadiusLevel(clampRadiusLevel(level), storage));
    },
    [storage],
  );

  const value = useMemo(
    () => ({ preferences, setLevel }),
    [preferences, setLevel],
  );

  return (
    <RadiusContext.Provider value={value}>{children}</RadiusContext.Provider>
  );
}

export function useRadius(): RadiusContextValue {
  const value = useContext(RadiusContext);
  if (!value) {
    throw new Error("useRadius must be used within RadiusProvider");
  }
  return value;
}
