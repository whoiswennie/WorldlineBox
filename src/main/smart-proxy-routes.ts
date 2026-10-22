import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const PIXIV_CDN_PROBES = [
  { host: 's.pximg.net', url: 'https://s.pximg.net/common/images/apple-touch-icon.png' },
  { host: 'i.pximg.net', url: 'https://i.pximg.net/' },
] as const;
export type CdnProbe = (url: string, proxy: string | undefined) => Promise<boolean>;

/** Normal TLS verification, original SNI/Host, no mirrors, cookies or credentials. */
export const probeCdnRoute: CdnProbe = (url, proxy) => new Promise(resolve => {
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  const finish = (ok: boolean) => { resolve(ok); request.destroy(); agent?.destroy(); };
  const request = https.get(url, { agent: agent ?? false, signal: AbortSignal.timeout(5_000),
    headers: { Referer: 'https://www.pixiv.net/', 'User-Agent': 'WorldlineBox-Network-Check' } }, response => {
    response.on('error', () => undefined);
    // The image CDN root normally returns 404. This probe establishes transport
    // health; the explicit Pixiv check below downloads a real image separately.
    finish(response.statusCode === 200 || new URL(url).pathname === '/' && response.statusCode === 404);
  });
  request.on('error', () => { agent?.destroy(); resolve(false); });
});

/** Prefer the proxy; use direct for an exact public CDN host only after a verified success. */
export async function selectSmartCdnRoutes(proxy: string, probe: CdnProbe = probeCdnRoute): Promise<string[]> {
  const routes = await Promise.all(PIXIV_CDN_PROBES.map(async ({ host, url }) => {
    const [proxied, direct] = await Promise.all([probe(url, proxy), probe(url, undefined)]);
    return !proxied && direct ? host : undefined;
  }));
  return routes.filter((host): host is NonNullable<typeof host> => host !== undefined);
}
