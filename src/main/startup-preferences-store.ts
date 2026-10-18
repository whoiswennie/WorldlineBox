import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_STARTUP_PREFERENCES,
  loginItemRegistration,
  parseStartupPreferences,
  startupPlatformSupported,
  type LoginItemRegistration,
  type StartupPreferences,
  type StartupPreferencesSnapshot,
} from '../shared/startup-preferences';

export const STARTUP_PREFERENCES_FILE_NAME = 'startup-preferences.json';

export function startupPreferencesFilePath(userDataPath: string): string {
  return path.join(userDataPath, STARTUP_PREFERENCES_FILE_NAME);
}

export function readStartupPreferences(filePath: string): StartupPreferences {
  try {
    return parseStartupPreferences(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return DEFAULT_STARTUP_PREFERENCES;
  }
}

export function writeStartupPreferences(filePath: string, preferences: StartupPreferences): void {
  const stored = parseStartupPreferences(preferences);
  writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function applyStartupLoginItem(input: {
  platform: string;
  packaged: boolean;
  e2e: boolean;
  preferences: StartupPreferences;
  setLoginItemSettings: (settings: LoginItemRegistration) => void;
  getLoginItemStatus?: () => string | undefined;
  getLoginItemState?: () => {
    openAtLogin: boolean;
    executableWillLaunchAtLogin?: boolean;
    status?: string;
  };
}): StartupPreferencesSnapshot {
  const registration = loginItemRegistration(input);
  let approvalRequired = false;
  let openAtLogin = input.preferences.openAtLogin;
  let registrationFailed = false;
  if (registration !== undefined) {
    input.setLoginItemSettings(registration);
    const state = input.getLoginItemState?.();
    if (state !== undefined) {
      approvalRequired = input.platform === 'darwin' && state.status === 'requires-approval';
      openAtLogin = approvalRequired
        ? input.preferences.openAtLogin
        : effectiveLoginItemState(input.platform, state);
      registrationFailed = openAtLogin !== input.preferences.openAtLogin;
    } else {
      approvalRequired = input.getLoginItemStatus?.() === 'requires-approval';
    }
  }
  return {
    openAtLogin,
    supported: startupPlatformSupported(input.platform),
    approvalRequired,
    ...(registrationFailed ? { registrationFailed: true } : {}),
  };
}

export function startupPreferencesSnapshot(input: {
  platform: string;
  packaged: boolean;
  e2e: boolean;
  preferences: StartupPreferences;
  getLoginItemState: () => {
    openAtLogin: boolean;
    executableWillLaunchAtLogin?: boolean;
    status?: string;
  };
  onReadError?: (error: unknown) => void;
}): StartupPreferencesSnapshot {
  if (input.e2e || !input.packaged || !startupPlatformSupported(input.platform)) {
    return {
      openAtLogin: input.preferences.openAtLogin,
      supported: startupPlatformSupported(input.platform),
      approvalRequired: false,
    };
  }

  try {
    const state = input.getLoginItemState();
    const approvalRequired = input.platform === 'darwin' && state.status === 'requires-approval';
    const openAtLogin = approvalRequired
      ? input.preferences.openAtLogin
      : effectiveLoginItemState(input.platform, state);
    return {
      openAtLogin,
      supported: true,
      approvalRequired,
      ...(input.preferences.openAtLogin && !openAtLogin && !approvalRequired
        ? { registrationFailed: true }
        : {}),
    };
  } catch (error) {
    input.onReadError?.(error);
    return {
      openAtLogin: input.preferences.openAtLogin,
      supported: true,
      approvalRequired: false,
      registrationFailed: true,
    };
  }
}

function effectiveLoginItemState(
  platform: string,
  state: { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean; status?: string },
): boolean {
  if (platform === 'win32') {
    return state.openAtLogin && state.executableWillLaunchAtLogin !== false;
  }
  if (state.status === undefined) return state.openAtLogin;
  return state.status === 'enabled';
}
