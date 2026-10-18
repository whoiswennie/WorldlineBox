import { contextBridge, ipcRenderer } from 'electron';
import { STARTUP_RENDERER_STATE_CHANNEL, type StartupRendererState } from '../shared/startup-lifecycle';

import { appUpdate } from './bridge/app-update';
import { dshLauncher } from './bridge/dsh-launcher';
import { browser } from './bridge/browser';
import { llm } from './bridge/llm';
import { music } from './bridge/music';
import { companions } from './bridge/companions';
import { companionWorld } from './bridge/companion-world-window';
import { COMPANION_WORLD_WINDOW_ARGUMENT } from '../shared/companion-world-window';
import { automation } from './bridge/automation';
import {
  armE2eBrowseSessionDelay,
  library,
  type E2eBrowseSessionDelayTarget,
} from './bridge/library';
import { mcp } from './bridge/mcp';
import { plugins } from './bridge/plugins';
import { shell } from './bridge/shell';
import { getE2eRequestCount } from './transport';
import type { RendererRequest } from '../shared/protocol/requests';

const e2eEnabled = process.env.WORLDLINEBOX_E2E === '1';

if (!process.argv.includes(COMPANION_WORLD_WINDOW_ARGUMENT)) {
  contextBridge.exposeInMainWorld('worldlineboxStartup', Object.freeze({
    notify(state: StartupRendererState): void {
      if (state === 'ready' || state === 'failed') ipcRenderer.send(STARTUP_RENDERER_STATE_CHANNEL, state);
    },
  }));
}

const e2eDiagnostics = Object.freeze({
  getRequestCount(type: RendererRequest['type']): number {
    return getE2eRequestCount(type);
  },
  delayNextBrowseSession(
    target: E2eBrowseSessionDelayTarget,
    delayMs: number,
  ): void {
    if (
      !e2eEnabled ||
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 5_000 ||
      (target.folderId === undefined) ===
        (target.smartCollectionId === undefined)
    ) {
      throw new Error('Invalid E2E browse-session delay.');
    }
    armE2eBrowseSessionDelay(target, delayMs);
  },
});

contextBridge.exposeInMainWorld(
  'worldlinebox',
  process.argv.includes(COMPANION_WORLD_WINDOW_ARGUMENT) ? Object.freeze({ companionWorld }) : Object.freeze({
    library,
    shell,
    appUpdate,
    dshLauncher,
    browser,
    llm,
    music,
    companions,
    companionWorld,
    automation,
    mcp,
    plugins,
    ...(e2eEnabled ? { e2e: e2eDiagnostics } : {}),
  }),
);
