import { nativeImage, type NativeImage, type WebContents } from 'electron';
import { companionOwnsDebugger } from './companion-viewport';
const captures = new WeakMap<WebContents, Promise<void>>();

/** Captures this existing tab only; never creates a second page or window. */
export async function companionScreenshot(contents: WebContents, signal: AbortSignal): Promise<NativeImage> {
  const previous = captures.get(contents) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), tail = previous.then(() => gate);
  captures.set(contents, tail);
  await previous;
  try { return await capture(contents, signal); }
  finally { release(); if (captures.get(contents) === tail) captures.delete(contents); }
}
async function capture(contents: WebContents, signal: AbortSignal): Promise<NativeImage> {
  signal.throwIfAborted();
  let abortNative: () => void = () => undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => { abortNative = () => reject(signal.reason); signal.addEventListener('abort', abortNative, { once: true }); });
    try {
      const image = await Promise.race([contents.capturePage(undefined, { stayHidden: true }), cancelled]);
      if (image.isEmpty()) throw Error('后台原生画面尚未生成。');
      return image;
    }
    finally { signal.removeEventListener('abort', abortNative); }
  }
  catch {
    signal.throwIfAborted();
    // Chromium's native surface may be unavailable for a covered WebContentsView.
    // Its built-in Page capture can request a frame from the same renderer.
    const reuse = companionOwnsDebugger(contents);
    if (contents.debugger.isAttached() && !reuse) throw Error('页面调试器正在使用中，暂时无法获取后台截图；请稍后重试。');
    if (!reuse) contents.debugger.attach('1.3');
    const cancel = () => { if (!reuse && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const metrics = await contents.debugger.sendCommand('Page.getLayoutMetrics') as { cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } };
      signal.throwIfAborted();
      const viewport = metrics.cssVisualViewport;
      if (!viewport || ![viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite) || viewport.clientWidth <= 0 || viewport.clientHeight <= 0
        || viewport.clientWidth > 8192 || viewport.clientHeight > 8192) throw Error('当前页面没有可用的截图视口。');
      const value: unknown = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true,
        clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: 1 } });
      signal.throwIfAborted();
      if (!value || typeof value !== 'object' || !('data' in value) || typeof value.data !== 'string' || value.data.length > 32 * 1024 * 1024) throw Error('页面截图无效或过大。');
      const image = nativeImage.createFromBuffer(Buffer.from(value.data, 'base64'));
      if (image.isEmpty()) throw Error('网页尚未产生有效画面。');
      return image;
    } finally { signal.removeEventListener('abort', cancel); cancel(); }
  }
}
