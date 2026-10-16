import { afterEach, expect, it, vi } from 'vitest';
import { prepareWorldResources } from '../../src/renderer/companions/world/world-preparation';
function deferred() { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => vi.useRealTimers());
it('reports actual asset completion and waits for shaders and every initial image', async () => {
  const compile = deferred(), a = deferred(), b = deferred(), signal = new AbortController(), progress = vi.fn();
  const prepared = prepareWorldResources({ compile: compile.promise, assets: [a.promise, b.promise], signal: signal.signal, onProgress: progress });
  expect(progress).toHaveBeenLastCalledWith({ compiled: false, completed: 0, total: 2 });
  a.resolve(); await Promise.resolve(); expect(progress).toHaveBeenLastCalledWith({ compiled: false, completed: 1, total: 2 });
  compile.resolve(); await Promise.resolve(); expect(progress).toHaveBeenLastCalledWith({ compiled: true, completed: 1, total: 2 });
  b.reject(new Error('missing image')); expect(await prepared).toEqual({ failedAssets: 1, compileFailed: false, timedOut: false, cancelled: false });
});
it('bounds a stalled driver and stops progress from cancelled or late resources', async () => {
  vi.useFakeTimers(); const compile = deferred(), a = deferred(), signal = new AbortController(), progress = vi.fn();
  const prepared = prepareWorldResources({ compile: compile.promise, assets: [a.promise], signal: signal.signal, onProgress: progress, timeoutMs: 500 });
  await vi.advanceTimersByTimeAsync(500); expect((await prepared).timedOut).toBe(true);
  const calls = progress.mock.calls.length; a.resolve(); compile.resolve(); await Promise.resolve(); expect(progress).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  const next = deferred(); const cancelled = prepareWorldResources({ compile: next.promise, assets: [], signal: signal.signal, onProgress: progress });
  signal.abort(); expect((await cancelled).cancelled).toBe(true); expect(vi.getTimerCount()).toBe(0); next.reject(new Error('late driver shutdown')); await Promise.resolve();
});
