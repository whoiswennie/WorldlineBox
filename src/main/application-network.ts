import path from 'node:path';
import { app, session } from 'electron';
import { LauncherNetwork } from './dsh/launcher-network';
import { applyNodeNetworkEnvironment, networkEnvironmentSchema, type NetworkEnvironment } from '../shared/network-environment';

let initialized: Promise<LauncherNetwork> | undefined;
let environment: NetworkEnvironment | undefined;
const listeners = new Set<(value: NetworkEnvironment) => void>();
export function currentNetworkEnvironment(): NetworkEnvironment | undefined { return environment; }
export function onNetworkEnvironment(listener: (value: NetworkEnvironment) => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function getApplicationNetwork(): Promise<LauncherNetwork> {
  return initialized ??= (async () => {
    // Retain the existing location so the selected DSH CLI reads the exact same saved settings.
    const network = new LauncherNetwork(path.join(app.getPath('userData'), 'dsh-launcher'), () => undefined);
    await network.init(); await network.attachSession(session.defaultSession);
    await network.setEnvironmentHandler(value => {
      const next = networkEnvironmentSchema.parse({ HTTP_PROXY: value.HTTP_PROXY, HTTPS_PROXY: value.HTTPS_PROXY,
        ALL_PROXY: value.ALL_PROXY, NO_PROXY: value.NO_PROXY, npm_config_registry: value.npm_config_registry,
        PIP_INDEX_URL: value.PIP_INDEX_URL, NODE_USE_ENV_PROXY: '1' });
      applyNodeNetworkEnvironment(next); environment = next;
      for (const listener of listeners) listener(next);
    });
    app.on('session-created', scope => { void network.attachSession(scope).catch(error => console.error('Application proxy could not be applied to a new session.', error)); });
    return network;
  })();
}
