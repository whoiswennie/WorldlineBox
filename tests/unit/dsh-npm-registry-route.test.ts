import { describe, expect, it, vi } from 'vitest';
import { AUTOMATIC_NPM_MIRROR, OFFICIAL_NPM_REGISTRY, selectNpmMetadataRoute } from '../../src/main/dsh/npm-registry-route';

const metadata = JSON.stringify({ name:'zod', versions:{ '4.0.0':{ version:'4.0.0' } } });

describe('npm metadata route selection', () => {
  it('compares complete valid bodies and cancels the route with fast headers but a stalled body', async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn(async (url:string, options:{signal:AbortSignal}) => {
      if (url.startsWith(AUTOMATIC_NPM_MIRROR)) return new Response(metadata);
      return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => { cancelled(); controller.error(options.signal.reason); }, {once:true});
      } }));
    });
    const result = await selectNpmMetadataRoute(fetcher, new AbortController().signal);
    expect(result).toMatchObject({registry:AUTOMATIC_NPM_MIRROR,probed:true});
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects a fast HTML response rather than selecting an unusable mirror', async () => {
    const result = await selectNpmMetadataRoute(async url => new Response(url.startsWith(AUTOMATIC_NPM_MIRROR)?'<html>blocked</html>':metadata), new AbortController().signal);
    expect(result).toMatchObject({registry:OFFICIAL_NPM_REGISTRY,probed:true});
  });
  it('falls back to the official route when both probes fail', async () => {
    const result = await selectNpmMetadataRoute(async () => new Response('unavailable',{status:503}), new AbortController().signal);
    expect(result).toMatchObject({registry:OFFICIAL_NPM_REGISTRY,probed:false});
  });
  it('bounds downloaded probe metadata', async () => {
    const result = await selectNpmMetadataRoute(async () => new Response(new Uint8Array(16*1024*1024+1)), new AbortController().signal);
    expect(result.probed).toBe(false);
  });
  it('propagates cancellation and aborts both pending requests', async () => {
    const controller = new AbortController(); const signals:AbortSignal[] = [];
    const pending = selectNpmMetadataRoute(async (_url, input) => {
      signals.push(input.signal);
      return new Promise<Response>((_resolve,reject) => input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));
    },controller.signal);
    controller.abort(Error('network settings changed'));
    await expect(pending).rejects.toThrow('network settings changed');
    expect(signals).toHaveLength(2); expect(signals.every(value=>value.aborted)).toBe(true);
  });
});
