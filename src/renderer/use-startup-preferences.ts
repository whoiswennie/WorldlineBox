import { useEffect, useState } from "react";

import {
  DEFAULT_STARTUP_PREFERENCES_SNAPSHOT,
  type StartupPreferencesSnapshot,
} from "../shared/startup-preferences";

type StartupApi = {
  get(): Promise<StartupPreferencesSnapshot>;
  set(input: {
    openAtLogin: boolean;
  }): Promise<StartupPreferencesSnapshot>;
};

function startupApi(): StartupApi | undefined {
  return (window as Window & { worldlinebox?: { startup?: StartupApi } }).worldlinebox?.startup;
}

export function useStartupPreferences(): {
  available: boolean;
  snapshot: StartupPreferencesSnapshot;
  setOpenAtLogin: (openAtLogin: boolean) => void;
} {
  const available = startupApi() !== undefined;
  const [snapshot, setSnapshot] = useState<StartupPreferencesSnapshot>(
    DEFAULT_STARTUP_PREFERENCES_SNAPSHOT,
  );

  useEffect(() => {
    const api = startupApi();
    if (api === undefined) return undefined;
    let cancelled = false;
    void api.get().then((next) => {
      if (!cancelled) setSnapshot(next);
    }).catch(() => {
      // Keep the default snapshot. The settings page stays usable.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    available,
    snapshot,
    setOpenAtLogin: (openAtLogin) => {
      const api = startupApi();
      setSnapshot((current) => ({ ...current, openAtLogin }));
      if (api === undefined) return;
      void api.set({ openAtLogin }).then(setSnapshot).catch(() => {
        void api.get().then(setSnapshot);
      });
    },
  };
}
