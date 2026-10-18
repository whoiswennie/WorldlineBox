import { ipcRenderer } from 'electron';

import {
  STARTUP_PREFERENCES_GET_CHANNEL,
  STARTUP_PREFERENCES_SET_CHANNEL,
} from '../../shared/protocol/channels';
import {
  DEFAULT_STARTUP_PREFERENCES_SNAPSHOT,
  parseStartupPreferencesSnapshot,
  type StartupPreferencesSnapshot,
} from '../../shared/startup-preferences';

export type WorldlineBoxStartupApi = {
  get(): Promise<StartupPreferencesSnapshot>;
  set(input: {
    openAtLogin: boolean;
  }): Promise<StartupPreferencesSnapshot>;
};

async function readSnapshot(payload: unknown): Promise<StartupPreferencesSnapshot> {
  return parseStartupPreferencesSnapshot(payload) ?? DEFAULT_STARTUP_PREFERENCES_SNAPSHOT;
}

export const startup: WorldlineBoxStartupApi = Object.freeze({
  async get() {
    return readSnapshot(await ipcRenderer.invoke(STARTUP_PREFERENCES_GET_CHANNEL));
  },
  async set(input) {
    return readSnapshot(await ipcRenderer.invoke(STARTUP_PREFERENCES_SET_CHANNEL, {
      openAtLogin: input.openAtLogin,
    }));
  },
});
