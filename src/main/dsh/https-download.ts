export type HttpsDownloadFetch = (url: string, init: { signal: AbortSignal; redirect: 'manual'; headers?: Record<string, string> }) => Promise<Response>;

export function httpsDownloadUrl(value: string, base?: string): URL {
  let url: URL;
  try { url = new URL(value, base); }
  catch { throw new Error('The installer download URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Installer downloads and redirects must use HTTPS without URL credentials.');
  return url;
}

/** Track requested URLs instead of Response.url, which Electron net.fetch leaves empty. */
export async function fetchHttpsDownload(url: string, fetch: HttpsDownloadFetch, signal: AbortSignal): Promise<Response> {
  let current = httpsDownloadUrl(url).href;
  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    const response = await fetch(current, { signal, redirect: 'manual', headers: { 'accept-encoding': 'identity' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('The installer server returned a redirect without a destination.');
    if (redirects >= 5) throw new Error('The installer server returned too many redirects.');
    current = httpsDownloadUrl(location, current).href;
  }
}
