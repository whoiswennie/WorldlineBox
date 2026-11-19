import type { MusicControl } from '../../shared/music';

type Handler = (control: MusicControl, signal: AbortSignal) => Promise<Record<string, unknown>>;

export function createMusicEndpoint() {
  let handler: Handler | undefined;
  const waiting = new Set<(handler: Handler) => void>();
  let tail = Promise.resolve();
  return {
    isReady: () => handler !== undefined,
    register(next: Handler) {
      handler = next;
      for (const ready of waiting) ready(next);
      return () => { if (handler === next) handler = undefined; };
    },
    run(control: MusicControl, signal: AbortSignal) {
      const result = tail.then(async () => {
        signal.throwIfAborted();
        const active = handler ?? await new Promise<Handler>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); waiting.delete(ready); signal.removeEventListener('abort', abort); };
          const ready = (next: Handler) => { cleanup(); resolve(next); };
          const abort = () => { cleanup(); reject(signal.reason); };
          const timer = setTimeout(() => { cleanup(); reject(Error('音乐播放器尚未就绪。')); }, 12_000);
          waiting.add(ready);
          signal.addEventListener('abort', abort, { once: true });
        });
        return active(control, signal);
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
export type MusicEndpoint = ReturnType<typeof createMusicEndpoint>;
