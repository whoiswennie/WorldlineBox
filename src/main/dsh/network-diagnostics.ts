import type { DshNetworkSourceKind, DshNetworkState } from '../../shared/dsh-launcher';
import type { HttpsDownloadFetch } from './https-download';

type Check = NonNullable<DshNetworkState['checks']>['results'][number];

/** Test the actual selected destinations, with bounded bodies, deadlines and explicit fallback attempts. */
export async function checkNetworkSource(kind: DshNetworkSourceKind, candidates: string[], fetcher: HttpsDownloadFetch,
  proxyFor: (url: string) => Promise<string>, signal: AbortSignal): Promise<Check> {
  const attempts: Check['attempts'] = [];
  for (const url of candidates.slice(0, 4)) {
    signal.throwIfAborted();
    const started = Date.now(); let proxy = 'UNKNOWN'; let status: number | undefined;
    try {
      proxy = await proxyFor(url);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
      const response = await fetcher(url, { signal: requestSignal, redirect: 'manual', headers: { Accept: kind === 'python' ? 'text/html' : 'application/json', 'User-Agent': 'WorldlineBox-DSH-Launcher' } });
      status = response.status;
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(`HTTP ${status}`); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          requestSignal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
          size += item.value.byteLength;
          if (kind === 'python') break; // Reachability of the HTML index; do not download its full package catalogue.
          if (size > 1024 * 1024) throw Error('Response exceeds 1 MiB.');
          chunks.push(item.value);
        }
        if (kind !== 'python') {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (kind === 'github' ? !Array.isArray(json) : !json || typeof json !== 'object' || !('name' in json) || json.name !== 'zod' || !('version' in json))
            throw Error('The endpoint returned unexpected package/release data.');
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      attempts.push({ url, proxy, status, elapsedMs: Date.now() - started, ok: true });
      return { kind, ok: true, attempts };
    } catch (error) {
      signal.throwIfAborted();
      attempts.push({ url, proxy, ...(status === undefined ? {} : { status }), elapsedMs: Date.now() - started,
        ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    }
  }
  return { kind, ok: false, attempts };
}
