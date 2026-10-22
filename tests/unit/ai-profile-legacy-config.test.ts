import { expect, test, vi } from "vitest";

import {
  loadLegacyAiConfigFile,
  runAiProfileMigrationStartup,
  withLegacyAiConfig,
} from "../../src/main/ai-profile-legacy-config";

type LegacyConfig = { model?: string };

function nodeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

test("only a missing legacy config file is treated as an empty first run", () => {
  const migrate = vi.fn((config: LegacyConfig | null) => config?.model ?? "empty");

  expect(withLegacyAiConfig<LegacyConfig, string>(
    () => { throw nodeError("ENOENT"); },
    migrate,
  )).toBe("empty");
  expect(migrate).toHaveBeenCalledExactlyOnceWith(null);
});

test.each([
  ["invalid JSON", () => "{invalid", /JSON/u],
  ["invalid UTF-8", () => Uint8Array.of(0xff, 0xfe), /encoded data/u],
  ["unreadable file", () => { throw nodeError("EACCES"); }, /EACCES/u],
])("legacy config %s blocks migration and destructive cleanup", (_label, readFile, errorMessage) => {
  const writeMarker = vi.fn();
  const cleanupLegacy = vi.fn();
  const migrate = vi.fn((config: LegacyConfig | null) => {
    void config;
    writeMarker();
    cleanupLegacy();
  });

  expect(() => withLegacyAiConfig<LegacyConfig, void>(readFile, migrate))
    .toThrow(errorMessage);
  expect(migrate).not.toHaveBeenCalled();
  expect(writeMarker).not.toHaveBeenCalled();
  expect(cleanupLegacy).not.toHaveBeenCalled();
});

test("valid legacy JSON is parsed only after strict UTF-8 decoding", () => {
  expect(loadLegacyAiConfigFile<LegacyConfig>(
    () => new TextEncoder().encode(JSON.stringify({ model: "legacy-model" })),
  )).toEqual({ model: "legacy-model" });
});

test("completed migration loads saved profiles and retries cleanup without reading corrupt legacy config", () => {
  const catalog = {
    version: 1 as const,
    activeProfileId: "ai_000000000000000000000001",
    profiles: [{
      id: "ai_000000000000000000000001",
      name: "Saved profile",
      apiFormat: "openai_chat" as const,
      model: "saved-model",
      baseUrl: "",
    }],
  };
  const readLegacyConfig = vi.fn(() => "{invalid leftover json");
  const readCatalog = vi.fn(() => catalog);
  const cleanupLegacy = vi.fn()
    .mockImplementationOnce(() => { throw new Error("legacy file is locked"); })
    .mockImplementation(() => undefined);
  const recoverCompletedMigration = () => {
    const savedCatalog = readCatalog();
    try {
      cleanupLegacy();
    } catch {
      // Mirrors Main's best-effort cleanup: a later startup retries it.
    }
    return savedCatalog;
  };

  const firstLoad = runAiProfileMigrationStartup<LegacyConfig, typeof catalog>({
    markerVersion: 1,
    readLegacyConfig,
    migrate: () => { throw new Error("completed migrations must not rerun"); },
    recoverCompletedMigration,
  });
  const secondLoad = runAiProfileMigrationStartup<LegacyConfig, typeof catalog>({
    markerVersion: 1,
    readLegacyConfig,
    migrate: () => { throw new Error("completed migrations must not rerun"); },
    recoverCompletedMigration,
  });

  expect(firstLoad.profiles[0]?.model).toBe("saved-model");
  expect(secondLoad.profiles[0]?.model).toBe("saved-model");
  expect(readLegacyConfig).not.toHaveBeenCalled();
  expect(cleanupLegacy).toHaveBeenCalledTimes(2);
});
