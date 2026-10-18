import { ipcRenderer } from 'electron';
import { createBuiltinContentChrome } from '../../extension/builtin-content';
import { setContentStyleInstaller } from '../../extension/content-style';
import { BROWSER_CAPTURE_CONTENT_EVENT, BROWSER_CAPTURE_CONTENT_REQUEST } from '../shared/browser-capture';
import { createBrowserCaptureGestureGate } from './browser-capture-gesture';

// A sandbox preload runs in Electron's isolated world. Never expose this shim,
// ipcRenderer, or an equivalent message bridge to the page's main world.
if (!process.sandboxed || !process.contextIsolated) {
  throw new Error('Browser capture requires a sandboxed, isolated preload.');
}
// Constructable stylesheets belong to these extension-created shadow roots.
// Unlike inline <style>, they work on restrictive sites without altering CSP.
setContentStyleInstaller((root, css) => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
});
const gesture = createBrowserCaptureGestureGate();
const observeDrag = (event: Event) => gesture.observe(event);
const dragEvents = ['dragstart', 'dragover', 'drop', 'dragend'] as const;
// Register before the original content script. Merely observe trusted input;
// do not cancel events or alter the website's normal drag behavior.
for (const type of dragEvents) window.addEventListener(type, observeDrag, true);
const content = createBuiltinContentChrome({
  request(request) {
    if (!gesture.authorize(request)) return Promise.reject(new Error('需要真实拖拽手势才能读取目录或保存媒体。'));
    return ipcRenderer.invoke(BROWSER_CAPTURE_CONTENT_REQUEST, request);
  },
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      gesture.nativeEvent(value);
      listener(value);
    };
    ipcRenderer.on(BROWSER_CAPTURE_CONTENT_EVENT, receive);
    return () => ipcRenderer.removeListener(BROWSER_CAPTURE_CONTENT_EVENT, receive);
  },
}, location.href);

Object.defineProperty(globalThis, 'chrome', { value: content.chrome, configurable: false, writable: false });
window.addEventListener('unload', () => {
  for (const type of dragEvents) window.removeEventListener(type, observeDrag, true);
  content.dispose();
}, { once: true });
