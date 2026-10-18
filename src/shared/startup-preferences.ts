import { z } from 'zod';

export const STARTUP_PREFERENCES_VERSION = 1 as const;

export type StartupPreferences = {
  readonly version: typeof STARTUP_PREFERENCES_VERSION;
  readonly openAtLogin: boolean;
};

export const DEFAULT_STARTUP_PREFERENCES: StartupPreferences = {
  version: STARTUP_PREFERENCES_VERSION,
  openAtLogin: false,
};

const startupPreferencesSchema = z.object({
  version: z.literal(STARTUP_PREFERENCES_VERSION),
  openAtLogin: z.boolean(),
});

export type StartupPreferencesSnapshot = {
  readonly openAtLogin: boolean;
  /** darwin and win32 can register a login item. */
  readonly supported: boolean;
  /** macOS SMAppService returned requires-approval. */
  readonly approvalRequired: boolean;
  /** The OS rejected or does not currently have the requested login item. */
  readonly registrationFailed?: boolean;
};

export const DEFAULT_STARTUP_PREFERENCES_SNAPSHOT: StartupPreferencesSnapshot = {
  openAtLogin: false,
  supported: false,
  approvalRequired: false,
};

const startupPreferencesSnapshotSchema = z.object({
  openAtLogin: z.boolean(),
  supported: z.boolean(),
  approvalRequired: z.boolean(),
  registrationFailed: z.boolean().optional(),
});

export type LoginItemRegistration = {
  readonly openAtLogin: boolean;
  readonly args?: readonly string[];
  readonly enabled?: boolean;
};

export function parseStartupPreferences(input: unknown): StartupPreferences {
  const parsed = startupPreferencesSchema.safeParse(input);
  return parsed.success ? parsed.data : DEFAULT_STARTUP_PREFERENCES;
}

export function parseStartupPreferencesSnapshot(input: unknown): StartupPreferencesSnapshot | undefined {
  const parsed = startupPreferencesSnapshotSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function startupPlatformSupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * OS login-item payload. Unpackaged and automated sessions do not register,
 * because the running executable is not the installed WorldlineBox app.
 * Windows always sends an empty argument list so a previously stored
 * launch argument is cleared.
 */
export function loginItemRegistration(input: {
  platform: string;
  packaged: boolean;
  e2e: boolean;
  preferences: StartupPreferences;
}): LoginItemRegistration | undefined {
  if (input.e2e || !input.packaged || !startupPlatformSupported(input.platform)) {
    return undefined;
  }
  if (input.platform === 'darwin') {
    return { openAtLogin: input.preferences.openAtLogin };
  }
  return {
    openAtLogin: input.preferences.openAtLogin,
    args: [],
    enabled: input.preferences.openAtLogin,
  };
}

export function shouldShowMainWindowOnReady(input: {
  updateHandoff: boolean;
  applicationQuitting: boolean;
  e2eHideWindow: boolean;
}): boolean {
  return !input.updateHandoff
    && !input.applicationQuitting
    && !input.e2eHideWindow;
}

/** A second launch may reveal the existing window only while the app is staying up. */
export function shouldHandleSecondaryLaunch(input: {
  updateHandoff: boolean;
  applicationQuitting: boolean;
}): boolean {
  return !input.updateHandoff && !input.applicationQuitting;
}
