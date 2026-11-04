import type { App, BrowserWindow } from 'electron';

export type RendererEffectsMode = 'full' | 'reduced';

/** Live blur needs both accelerated compositing and rasterization. Unknown or
 * software capabilities use a readable translucent surface without the cost
 * of repeatedly filtering the application behind an input/scroll surface. */
export function rendererEffectsMode(features: { gpu_compositing?: string; rasterization?: string }): RendererEffectsMode {
  const accelerated = (status: string | undefined) => !!status && /^enabled(?:_|$)/u.test(status) && !/software/iu.test(status);
  return accelerated(features.gpu_compositing) && accelerated(features.rasterization) ? 'full' : 'reduced';
}

/** Publish only a presentation capability; never expose GPU/device details or
 * change the application's acceleration policy. Reapply after every reload. */
export function bindRendererEffects(application: Pick<App, 'getGPUFeatureStatus' | 'on' | 'removeListener'>,
  window: Pick<BrowserWindow, 'webContents' | 'once' | 'isDestroyed'>): () => void {
  const contents = window.webContents;
  let disposed = false;
  const update = () => {
    if (disposed || window.isDestroyed() || contents.isDestroyed()) return;
    let mode: RendererEffectsMode = 'reduced';
    try { mode = rendererEffectsMode(application.getGPUFeatureStatus()); } catch { /* Capability discovery remains conservative. */ }
    // Both values originate in the closed enum above, not page input.
    try { void contents.executeJavaScript(`document.documentElement.dataset.uiEffects = ${JSON.stringify(mode)}`).catch(() => undefined); }
    catch { /* A window can be destroyed after the checks above. */ }
  };
  const dispose = () => {
    if (disposed) return; disposed = true;
    application.removeListener('gpu-info-update', update);
    // BrowserWindow's native webContents accessor is no longer safe in `closed`.
    if (!contents.isDestroyed()) contents.removeListener('dom-ready', update);
  };
  application.on('gpu-info-update', update);
  contents.on('dom-ready', update);
  window.once('closed', dispose);
  return dispose;
}
