import type { StartupRendererState } from '../shared/startup-lifecycle';

export function notifyStartupState(state: StartupRendererState): void {
  window.worldlineboxStartup?.notify(state);
}

/** Keep the splash until the committed application has had a paint opportunity. */
export function afterStartupPaint(ready: () => void): () => void {
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(ready);
  });
  return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
}
