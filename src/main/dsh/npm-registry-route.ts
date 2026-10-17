import type { HttpsDownloadFetch } from './https-download';

export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
export const AUTOMATIC_NPM_MIRROR = 'https://registry.npmmirror.com';

export interface NpmMetadataRoute { registry: string; elapsedMs: number; probed: boolean }

/** Compare complete metadata responses: a fast TCP connection alone cannot select a route. */
export async function selectNpmMetadataRoute(fetcher: HttpsDownloadFetch, signal: AbortSignal): Promise<NpmMetadataRoute> {
  const registries = [OFFICIAL_NPM_REGISTRY, AUTOMATIC_NPM_MIRROR];
  const controllers = registries.map(() => new AbortController());
  const started = Date.now();
  try {
    return await Promise.any(registries.map(async (registry, index) => {
      const requestSignal = AbortSignal.any([signal, controllers[index]!.signal, AbortSignal.timeout(12_000)]);
      const response = await fetcher(`${registry}/zod`, { redirect:'manual', signal:requestSignal, headers:{Accept:'application/json'} });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('Metadata route unavailable.'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          requestSignal.throwIfAborted();
          const item = await reader.read(); if (item.done) break;
          if ((size += item.value.byteLength) > 16 * 1024 * 1024) throw Error('Metadata probe exceeds its size limit.');
          chunks.push(item.value);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {name?:unknown;versions?:unknown};
        if(value.name!=='zod'||!value.versions||typeof value.versions!=='object'||Array.isArray(value.versions)||!Object.keys(value.versions).length)throw Error('Invalid metadata route response.');
        return {registry,elapsedMs:Date.now()-started,probed:true};
      } finally { await reader.cancel().catch(()=>undefined); reader.releaseLock(); }
    }));
  } catch {
    signal.throwIfAborted();
    return {registry:OFFICIAL_NPM_REGISTRY,elapsedMs:Date.now()-started,probed:false};
  } finally { for (const controller of controllers) controller.abort(); }
}
