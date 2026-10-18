import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { isMacPlatform } from "./commands/command-types";
import type { ShortcutPlatform } from "../shared/shortcut-catalog";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  platformBindings,
  withPlatformBindings,
  type ShortcutBindings,
  type ShortcutOverride,
  type ShortcutPlatformBindings,
} from "../shared/shortcut-bindings";
import type { WorldlineBoxShortcutsApi } from "../shared/shortcut-api";
import { setShortcutRuntime } from "./shortcut-runtime";

type ShortcutsWindow = Window & {
  worldlinebox?: { shortcuts?: WorldlineBoxShortcutsApi };
};

export type ShortcutSettingsContextValue = {
  readonly platform: ShortcutPlatform;
  readonly bindings: ShortcutBindings;
  readonly version: number;
  readonly ready: boolean;
  readonly error: string | null;
  saveOverride(
    actionId: string,
    override: ShortcutOverride,
  ): Promise<{ ok: boolean; error?: string }>;
  saveOverrides(
    overrides: Readonly<Record<string, ShortcutOverride>>,
  ): Promise<{ ok: boolean; error?: string }>;
  resetAction(actionId: string): Promise<{ ok: boolean; error?: string }>;
  resetAll(): Promise<{ ok: boolean; error?: string }>;
  exportToFile(): Promise<{ ok: boolean; error?: string; canceled?: boolean }>;
  importFromFile(): Promise<{ ok: boolean; error?: string; canceled?: boolean }>;
  refresh(): Promise<void>;
};

const ShortcutSettingsContext =
  createContext<ShortcutSettingsContextValue | null>(null);

function resolveApi(): WorldlineBoxShortcutsApi | undefined {
  return (window as ShortcutsWindow).worldlinebox?.shortcuts;
}

function rendererPlatform(): ShortcutPlatform {
  return isMacPlatform(navigator.userAgent) ? "mac" : "windows";
}

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const platform = useMemo(() => rendererPlatform(), []);
  const [bindings, setBindings] = useState<ShortcutBindings>(
    DEFAULT_SHORTCUT_BINDINGS,
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const applyBindings = useCallback(
    (next: ShortcutBindings) => {
      setBindings(next);
      setShortcutRuntime(platform, next);
      setVersion((current) => current + 1);
    },
    [platform],
  );

  const refresh = useCallback(async () => {
    const api = resolveApi();
    if (!api) {
      applyBindings(DEFAULT_SHORTCUT_BINDINGS);
      setReady(true);
      return;
    }
    try {
      const next = await api.get();
      applyBindings(next);
      setError(null);
    } catch {
      applyBindings(DEFAULT_SHORTCUT_BINDINGS);
      setError("shortcut-load-failed");
    } finally {
      setReady(true);
    }
  }, [applyBindings]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const applyPlatformMap = useCallback(
    async (nextMap: ShortcutPlatformBindings) => {
      const api = resolveApi();
      if (!api) {
        const next = withPlatformBindings(bindings, platform, nextMap);
        applyBindings(next);
        return { ok: true };
      }
      try {
        const result = await api.set({ platform, bindings: nextMap });
        applyBindings(result.bindings);
        if (result.ok) {
          setError(null);
          return { ok: true };
        }
        setError(result.error);
        return { ok: false, error: result.error };
      } catch {
        setError("shortcut-save-failed");
        return { ok: false, error: "shortcut-save-failed" };
      }
    },
    [applyBindings, bindings, platform],
  );

  const saveOverride = useCallback(
    async (actionId: string, override: ShortcutOverride) => {
      const current = platformBindings(bindings, platform);
      return applyPlatformMap({ ...current, [actionId]: override });
    },
    [applyPlatformMap, bindings, platform],
  );

  const saveOverrides = useCallback(
    async (overrides: Readonly<Record<string, ShortcutOverride>>) => {
      const current = platformBindings(bindings, platform);
      return applyPlatformMap({ ...current, ...overrides });
    },
    [applyPlatformMap, bindings, platform],
  );

  const resetAction = useCallback(
    async (actionId: string) => {
      const current = { ...platformBindings(bindings, platform) };
      delete current[actionId];
      return applyPlatformMap(current);
    },
    [applyPlatformMap, bindings, platform],
  );

  const resetAll = useCallback(
    async () => applyPlatformMap({}),
    [applyPlatformMap],
  );

  const exportToFile = useCallback(async () => {
    const api = resolveApi();
    if (!api) return { ok: false, error: "shortcuts-unavailable" };
    const result = await api.exportToFile();
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          error: result.error,
          ...(result.canceled === true ? { canceled: true } : {}),
        };
  }, []);

  const importFromFile = useCallback(async () => {
    const api = resolveApi();
    if (!api) return { ok: false, error: "shortcuts-unavailable" };
    const result = await api.importFromFile();
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        ...(result.canceled === true ? { canceled: true } : {}),
      };
    }
    applyBindings(result.bindings);
    setError(null);
    return { ok: true };
  }, [applyBindings]);

  const value = useMemo<ShortcutSettingsContextValue>(
    () => ({
      platform,
      bindings,
      version,
      ready,
      error,
      saveOverride,
      saveOverrides,
      resetAction,
      resetAll,
      exportToFile,
      importFromFile,
      refresh,
    }),
    [
      bindings,
      error,
      platform,
      ready,
      refresh,
      resetAction,
      resetAll,
      exportToFile,
      importFromFile,
      saveOverride,
      saveOverrides,
      version,
    ],
  );

  return (
    <ShortcutSettingsContext.Provider value={value}>
      {children}
    </ShortcutSettingsContext.Provider>
  );
}

export function useShortcutSettings(): ShortcutSettingsContextValue {
  const context = useContext(ShortcutSettingsContext);
  if (context === null) {
    throw new Error("useShortcutSettings must be used inside ShortcutProvider");
  }
  return context;
}

export function useShortcutRuntimeVersion(): number {
  return useContext(ShortcutSettingsContext)?.version ?? 0;
}
