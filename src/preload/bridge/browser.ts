import { ipcRenderer } from 'electron';
import { BROWSER_CAPTURE_OPEN_ASSETS, BROWSER_CAPTURE_REQUEST, browserCaptureRequestSchema, browserCaptureResponseSchema, type BrowserCaptureRequest } from '../../shared/browser-capture';
import { BROWSER_CHANGED, BROWSER_FOCUS, BROWSER_REQUEST, browserResponseSchema, browserStateSchema, type BrowserRequest, type BrowserState, type WorldlineBoxBrowserApi } from '../../shared/browser';
export const browser: WorldlineBoxBrowserApi = Object.freeze({
  onCaptureOpenAssets(listener: () => void) {
    const handler = () => listener();
    ipcRenderer.on(BROWSER_CAPTURE_OPEN_ASSETS, handler);
    return () => ipcRenderer.removeListener(BROWSER_CAPTURE_OPEN_ASSETS, handler);
  },
  async capture(request: BrowserCaptureRequest) {
    const input = browserCaptureRequestSchema.parse(request);
    const result = browserCaptureResponseSchema.safeParse(await ipcRenderer.invoke(BROWSER_CAPTURE_REQUEST, input));
    return result.success ? result.data : { ok: false as const, error: '采集功能返回了无效数据。' };
  },
  async request(request: BrowserRequest) { const result = browserResponseSchema.safeParse(await ipcRenderer.invoke(BROWSER_REQUEST, request)); return result.success ? result.data : { ok: false as const, error: '浏览器返回了无效数据。' }; },
  onChanged(listener: (state: BrowserState) => void) { const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { const result = browserStateSchema.safeParse(value); if (result.success) listener(result.data); }; ipcRenderer.on(BROWSER_CHANGED, handler); return () => ipcRenderer.removeListener(BROWSER_CHANGED, handler); },
  onFocus(listener: (target: 'address' | 'find') => void) { const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { if (value === 'address' || value === 'find') listener(value); }; ipcRenderer.on(BROWSER_FOCUS, handler); return () => ipcRenderer.removeListener(BROWSER_FOCUS, handler); },
});
