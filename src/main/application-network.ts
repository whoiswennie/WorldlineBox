import path from 'node:path';
import { app, session } from 'electron';
import { LauncherNetwork } from './dsh/launcher-network';
import { applyNodeNetworkEnvironment, networkEnvironmentSchema, type NetworkEnvironment } from '../shared/network-environment';
import { ApplicationNetworkDiagnostics } from './application-network-diagnostics';
import { ChildNetworkRelay } from './child-network-relay';
import type { ApplicationNetworkFailure, ApplicationNetworkState } from '../shared/application-network';

let initialized: Promise<LauncherNetwork> | undefined;
let environment: NetworkEnvironment | undefined;
const listeners = new Set<(value: NetworkEnvironment) => void>();
const diagnostics = new ApplicationNetworkDiagnostics(failure => failureReporter?.(failure));
let failureReporter: ((failure: ApplicationNetworkFailure) => void) | undefined;
const observedSessions = new WeakSet<Electron.Session>();
let childRelay: ChildNetworkRelay | undefined;
let stopRelayPolicy: (() => void) | undefined;
export async function closeApplicationNetwork(): Promise<void> {
  stopRelayPolicy?.(); stopRelayPolicy = undefined;
  await childRelay?.close(); childRelay = undefined;
}
export function setApplicationNetworkFailureReporter(reporter: (failure: ApplicationNetworkFailure) => void): void { failureReporter = reporter; }
export function applicationNetworkState(network: LauncherNetwork): ApplicationNetworkState {
  return { ...network.state(), recentFailures: diagnostics.state() };
}
export function onApplicationNetworkDiagnostics(listener: () => void): () => void { return diagnostics.subscribe(listener); }
export function clearApplicationNetworkDiagnostics(): void { diagnostics.clear(); }
function observeFailures(scope: Electron.Session): void {
  if (observedSessions.has(scope)) return;
  observedSessions.add(scope);
  const storage = scope.getStoragePath() ?? '';
  const module = scope === session.defaultSession ? 'application' : /worldlinebox-browser[\\/]?$/i.test(storage) ? 'browser' : 'session';
  scope.webRequest.onErrorOccurred(details => diagnostics.record({ url: details.url, error: details.error, resourceType: details.resourceType, module }));
}
export function currentNetworkEnvironment(): NetworkEnvironment | undefined { return environment; }
export function onNetworkEnvironment(listener: (value: NetworkEnvironment) => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function getApplicationNetwork(): Promise<LauncherNetwork> {
  return initialized ??= (async () => {
    // Retain the existing location so the selected DSH CLI reads the exact same saved settings.
    const network = new LauncherNetwork(path.join(app.getPath('userData'), 'dsh-launcher'), () => undefined);
    await network.init(); await network.attachSession(session.defaultSession);
    observeFailures(session.defaultSession);
    observeFailures(session.fromPartition('persist:worldlinebox-dsh-network'));
    const relay = new ChildNetworkRelay(destination => network.resolveProxy(destination));
    childRelay = relay;
    // Resolve system/PAC rules per destination. Reusing the npm route for every
    // Node request would send AI, sync and update traffic through the wrong route.
    await network.setEnvironmentHandler(async value => {
      const runtime = await relay.environment(value);
      const next = networkEnvironmentSchema.parse({ HTTP_PROXY: runtime.HTTP_PROXY, HTTPS_PROXY: runtime.HTTPS_PROXY,
        ALL_PROXY: runtime.ALL_PROXY, NO_PROXY: runtime.NO_PROXY, npm_config_registry: runtime.npm_config_registry,
        PIP_INDEX_URL: runtime.PIP_INDEX_URL, NODE_USE_ENV_PROXY: '1' });
      applyNodeNetworkEnvironment(next); environment = next;
      for (const listener of listeners) listener(next);
    });
    network.setChildEnvironmentHandler(value => relay.environment(value));
    let revision = network.state().revision;
    stopRelayPolicy = network.subscribe(() => {
      const next = network.state().revision;
      if (next !== revision) { revision = next; childRelay?.policyChanged(); }
    });
    app.on('session-created', scope => {
      observeFailures(scope);
      void network.attachSession(scope).catch(error => console.error('Application proxy could not be applied to a new session.', error));
    });
    return network;
  })();
}
