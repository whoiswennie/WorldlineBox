import type { WebContents } from 'electron';
const ownedDebuggers = new WeakSet<WebContents>();
export function companionOwnsDebugger(contents: WebContents) { return ownedDebuggers.has(contents); }

/** A hidden native view can have a zero Chromium viewport on Windows even
 * when its native bounds are set. Supply layout metrics without showing it. */
export async function companionViewport(contents: WebContents, bounds: { width: number; height: number }) {
  const viewport = await contents.executeJavaScript('({width:innerWidth,height:innerHeight})') as { width: number; height: number };
  if (viewport.width > 0 && viewport.height > 0) return async () => undefined;
  if (contents.debugger.isAttached()) throw Error('页面调试器正在使用中，请稍后重试后台操作。');
  contents.debugger.attach('1.3'); ownedDebuggers.add(contents);
  const dispose = async () => {
    ownedDebuggers.delete(contents);
    if (!contents.isDestroyed() && contents.debugger.isAttached()) {
      try { await contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'); }
      finally { if (contents.debugger.isAttached()) contents.debugger.detach(); }
    }
  };
  try {
    await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: Math.max(320, bounds.width || 1024),
      height: Math.max(240, bounds.height || 768), deviceScaleFactor: 1, mobile: false });
    return dispose;
  } catch (error) { await dispose(); throw error; }
}
