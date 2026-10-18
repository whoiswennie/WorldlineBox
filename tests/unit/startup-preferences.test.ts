import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyStartupLoginItem,
  readStartupPreferences,
  startupPreferencesFilePath,
  writeStartupPreferences,
} from '../../src/main/startup-preferences-store';
import {
  DEFAULT_STARTUP_PREFERENCES,
  loginItemRegistration,
  parseStartupPreferences,
  shouldHandleSecondaryLaunch,
  shouldShowMainWindowOnReady,
} from '../../src/shared/startup-preferences';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('startup preferences', () => {
  it('falls back when the stored file is missing or invalid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-startup-preferences-'));
    tempDirectories.push(root);
    const filePath = startupPreferencesFilePath(root);
    expect(readStartupPreferences(filePath)).toEqual(DEFAULT_STARTUP_PREFERENCES);
    writeStartupPreferences(filePath, { version: 1, openAtLogin: true });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      openAtLogin: true,
    });
    expect(readStartupPreferences(filePath)).toEqual({
      version: 1,
      openAtLogin: true,
    });
    expect(parseStartupPreferences({ version: 2, openAtLogin: true })).toEqual(DEFAULT_STARTUP_PREFERENCES);
  });

  it('ignores a leftover silent-launch field from an earlier preference file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-startup-preferences-'));
    tempDirectories.push(root);
    const filePath = startupPreferencesFilePath(root);
    await writeFile(filePath, `${JSON.stringify({
      version: 1,
      openAtLogin: true,
      silentLaunch: true,
    })}\n`);
    expect(readStartupPreferences(filePath)).toEqual({
      version: 1,
      openAtLogin: true,
    });
  });

  it('registers login items only for packaged macOS and Windows apps', () => {
    const preferences = { version: 1 as const, openAtLogin: true };
    expect(loginItemRegistration({
      platform: 'darwin',
      packaged: true,
      e2e: false,
      preferences,
    })).toEqual({ openAtLogin: true });
    expect(loginItemRegistration({
      platform: 'win32',
      packaged: true,
      e2e: false,
      preferences,
    })).toEqual({
      openAtLogin: true,
      args: [],
      enabled: true,
    });
    expect(loginItemRegistration({
      platform: 'win32',
      packaged: true,
      e2e: false,
      preferences: { ...preferences, openAtLogin: false },
    })).toEqual({
      openAtLogin: false,
      args: [],
      enabled: false,
    });
    expect(loginItemRegistration({
      platform: 'linux',
      packaged: true,
      e2e: false,
      preferences,
    })).toBeUndefined();
    expect(loginItemRegistration({
      platform: 'darwin',
      packaged: false,
      e2e: false,
      preferences,
    })).toBeUndefined();
    expect(loginItemRegistration({
      platform: 'darwin',
      packaged: true,
      e2e: true,
      preferences,
    })).toBeUndefined();
  });

  it('applies the registration and records macOS approval', () => {
    const calls: unknown[] = [];
    const snapshot = applyStartupLoginItem({
      platform: 'darwin',
      packaged: true,
      e2e: false,
      preferences: { version: 1, openAtLogin: true },
      setLoginItemSettings: (settings) => {
        calls.push(settings);
      },
      getLoginItemStatus: () => 'requires-approval',
    });
    expect(calls).toEqual([{ openAtLogin: true }]);
    expect(snapshot).toEqual({
      openAtLogin: true,
      supported: true,
      approvalRequired: true,
    });
  });

  it('does not present a window during update handoff or quit', () => {
    expect(shouldShowMainWindowOnReady({
      updateHandoff: false,
      applicationQuitting: false,
      e2eHideWindow: false,
    })).toBe(true);
    expect(shouldShowMainWindowOnReady({
      updateHandoff: true,
      applicationQuitting: false,
      e2eHideWindow: false,
    })).toBe(false);
    expect(shouldShowMainWindowOnReady({
      updateHandoff: false,
      applicationQuitting: true,
      e2eHideWindow: false,
    })).toBe(false);
    expect(shouldHandleSecondaryLaunch({
      updateHandoff: false,
      applicationQuitting: false,
    })).toBe(true);
    expect(shouldHandleSecondaryLaunch({
      updateHandoff: true,
      applicationQuitting: false,
    })).toBe(false);
    expect(shouldHandleSecondaryLaunch({
      updateHandoff: false,
      applicationQuitting: true,
    })).toBe(false);
  });
});
