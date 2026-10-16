/** Only the main document may release its initially hidden native window. */
export const STARTUP_RENDERER_STATE_CHANNEL = 'worldlinebox:startup:renderer-state';
export type StartupRendererState = 'ready' | 'failed';

declare global {
  interface Window {
    worldlineboxStartup?: { notify(state: StartupRendererState): void };
  }
}
