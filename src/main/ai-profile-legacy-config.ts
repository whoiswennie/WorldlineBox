/** Read a legacy config file while treating only a missing file as no config. */
export function loadLegacyAiConfigFile<TConfig extends object>(
  readFile: () => string | Uint8Array,
): TConfig | null {
  let contents: string | Uint8Array;
  try {
    contents = readFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }

  const text = typeof contents === "string"
    ? contents
    : new TextDecoder("utf-8", { fatal: true }).decode(contents);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Legacy AI config must contain a JSON object.");
  }
  return parsed as TConfig;
}

/** Do not start migration (and therefore never mark or clean up) until parsing succeeded. */
export function withLegacyAiConfig<TConfig extends object, TResult>(
  readFile: () => string | Uint8Array,
  migrate: (legacyConfig: TConfig | null) => TResult,
): TResult {
  return migrate(loadLegacyAiConfigFile<TConfig>(readFile));
}

/** A completed migration must not depend on a leftover legacy file being readable. */
export function runAiProfileMigrationStartup<TConfig extends object, TResult>(input: {
  markerVersion: number | null;
  readLegacyConfig: () => string | Uint8Array;
  migrate: (legacyConfig: TConfig | null) => TResult;
  recoverCompletedMigration: () => TResult;
}): TResult {
  if (input.markerVersion === 1) return input.recoverCompletedMigration();
  return withLegacyAiConfig<TConfig, TResult>(input.readLegacyConfig, input.migrate);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
