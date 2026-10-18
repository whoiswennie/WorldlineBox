import { utilityProcess, type UtilityProcess } from 'electron';

import { currentNetworkEnvironment, onNetworkEnvironment } from './application-network';
import { networkChildEnvironment } from '../shared/network-environment';

/** Bind every managed utility to the application policy, including processes already running. */
export function forkNetworkUtility(modulePath: string, options: Electron.ForkOptions): UtilityProcess {
  const child = utilityProcess.fork(modulePath, [], {
    ...options,
    env: networkChildEnvironment({ ...(options.env ?? process.env) }, currentNetworkEnvironment()),
  });
  const stop = onNetworkEnvironment(environment => {
    try { child.postMessage({ type: 'worker.network-environment', environment }); }
    catch { /* A process racing its exit cannot retain an active network client. */ }
  });
  child.once('exit', stop);
  // A policy change may have happened while the utility was loading. Queue the
  // latest snapshot after its bootstrap has installed the parent-port handler.
  child.once('spawn', () => {
    const environment = currentNetworkEnvironment();
    if (environment) {
      try { child.postMessage({ type: 'worker.network-environment', environment }); }
      catch { /* A failed bootstrap is handled by the owning supervisor. */ }
    }
  });
  return child;
}
