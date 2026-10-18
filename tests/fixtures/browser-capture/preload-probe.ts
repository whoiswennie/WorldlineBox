import '../../../src/preload/browser-capture';
import { ipcRenderer } from 'electron';

let nodeBuiltinsAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Probe the sandbox's actual restricted require at runtime.
  require('node:fs');
  nodeBuiltinsAvailable = true;
} catch { /* The sandbox must reject Node built-ins. */ }
void ipcRenderer.invoke('worldlinebox:fixture:capture-preload-probe', {
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
  nodeBuiltinsAvailable,
});
