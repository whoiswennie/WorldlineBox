import type { PixivNetworkCheck } from '../shared/application-network';
import type { HttpsDownloadFetch } from './dsh/https-download';

type Kind = PixivNetworkCheck['results'][number]['kind'];
const REFERER = 'https://www.pixiv.net/';

/** Check public features only. No account login, posting, or changes to site data. */
export async function checkPixivNetwork(fetcher: HttpsDownloadFetch, proxyFor: (url: string) => Promise<string>, signal: AbortSignal): Promise<PixivNetworkCheck> {
  const results: PixivNetworkCheck['results'] = [];
  const check = async (kind: Kind, url: string | undefined, contentType: RegExp, wholeBody = false): Promise<string | undefined> => {
    signal.throwIfAborted();
    if (!url) { results.push({ kind, url: '', proxy: 'UNKNOWN', elapsedMs: 0, ok: false, error: 'No public sample was returned by Pixiv; this feature could not be verified.' }); return; }
    const started = Date.now(); let proxy = 'UNKNOWN'; let status: number | undefined; let bytes = 0;
    try {
      proxy = await proxyFor(url);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const response = await fetcher(url, { signal: requestSignal, redirect: 'manual', headers: { Referer: REFERER, Accept: '*/*' } });
      status = response.status;
      const reader = response.body?.getReader();
      if (!reader) throw Error(`HTTP ${status}: empty response`);
      const chunks: Uint8Array[] = [];
      try {
        if (!response.ok) throw Error(`HTTP ${status}`);
        if (!contentType.test(response.headers.get('content-type') ?? '')) throw Error('Unexpected content type; the requested resource was not returned.');
        for (;;) {
          requestSignal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw Error('Diagnostic response exceeds 2 MiB.');
          chunks.push(item.value);
          if (!wholeBody) break;
        }
        if (!bytes) throw Error('The resource returned no data.');
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      if (kind === 'api') {
        const data: unknown = JSON.parse(text);
        if (!data || typeof data !== 'object' || !('error' in data) || data.error !== false || !('body' in data) || !Array.isArray(data.body)) throw Error('Pixiv did not return public artwork page data.');
      }
      results.push({ kind, url, proxy, status, bytes, elapsedMs: Date.now() - started, ok: true });
      return text;
    } catch (error) {
      signal.throwIfAborted();
      results.push({ kind, url, proxy, status, bytes, elapsedMs: Date.now() - started, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
    }
  };
  const html = await check('page', REFERER, /text\/html/i, true);
  // Resolve only official HTTPS CDN resources, never arbitrary URLs from a response.
  const urls = (html?.match(/https:\/\/[^\s"'<>\\]+/g) ?? []).map(value => value.split('&quot;')[0]!);
  const cdn = (url: string) => {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && (parsed.hostname === 'pximg.net' || parsed.hostname.endsWith('.pximg.net')); }
    catch { return false; }
  };
  const stylesheet = urls.find(url => cdn(url) && /\.css(?:\?|$)/.test(url));
  const script = urls.find(url => cdn(url) && /\.js(?:\?|$)/.test(url));
  const illustration = /login-illusts\/(\d+)\./.exec(html ?? '')?.[1] ?? /\/artworks\/(\d+)/.exec(html ?? '')?.[1];
  const [, , , pages] = await Promise.all([
    check('login', 'https://accounts.pixiv.net/login', /text\/html/i),
    check('stylesheet', stylesheet, /text\/css/i),
    check('script', script, /(?:javascript|ecmascript)/i),
    check('api', illustration ? `https://www.pixiv.net/ajax/illust/${illustration}/pages` : undefined, /application\/json/i, true),
    check('captcha', 'https://www.google.com/recaptcha/api.js', /(?:javascript|ecmascript)/i),
  ]);
  let image: string | undefined;
  if (pages) {
    const data = JSON.parse(pages) as { body: { urls?: { small?: string; original?: string } }[] };
    const candidate = data.body[0]?.urls?.small ?? data.body[0]?.urls?.original;
    if (typeof candidate === 'string') image = candidate;
  }
  image ??= urls.find(url => cdn(url) && new URL(url).hostname === 'i.pximg.net' && /\.(?:jpg|png|webp)(?:\?|$)/.test(url));
  await check('image', image && cdn(image) ? image : undefined, /^image\//i);
  const order: Kind[] = ['page', 'login', 'stylesheet', 'script', 'api', 'image', 'captcha'];
  results.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { checkedAt: new Date().toISOString(), results };
}
