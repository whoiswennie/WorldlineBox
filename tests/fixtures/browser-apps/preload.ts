import { contextBridge, ipcRenderer } from 'electron';
import { BROWSER_CHANGED } from '../../../src/shared/browser';
contextBridge.exposeInMainWorld('browserAppsFixture', {
  browser: {
    request: (input: unknown) => ipcRenderer.invoke('fixture:browser', input),
    onChanged: (listener: (state: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
      ipcRenderer.on(BROWSER_CHANGED, handler); return () => ipcRenderer.removeListener(BROWSER_CHANGED, handler);
    },
  },
  bot: { request: (input: unknown) => ipcRenderer.invoke('fixture:bot', input), onEvent: (listener: (event: unknown) => void) => { const timer = setInterval(() => listener({ type: 'changed' }), 200); return () => clearInterval(timer); } },
  proof: () => ipcRenderer.invoke('fixture:proof'),
});
