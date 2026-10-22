import { expect, it, vi } from 'vitest';
import { checkPixivNetwork } from '../../src/main/pixiv-network-check';
import type { HttpsDownloadFetch } from '../../src/main/dsh/https-download';

const html = '<link href="https://s.pximg.net/site.css"><script src="https://s.pximg.net/site.js"></script><img src="https://s.pximg.net/special/login-illusts/123.jpg">';
function fixture() {
  return vi.fn<HttpsDownloadFetch>(async url => {
    if (url.endsWith('.css')) return new Response('body{color:red}', { headers: { 'Content-Type': 'text/css' } });
    if (url.endsWith('.js')) return new Response('window.site=true', { headers: { 'Content-Type': 'application/javascript' } });
    if (url.includes('/ajax/')) return new Response(JSON.stringify({ error: false, body: [{ urls: { small: 'https://i.pximg.net/art.jpg' } }] }), { headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('.jpg')) return new Response('real-image-bytes', { headers: { 'Content-Type': 'image/jpeg' } });
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  });
}
it('checks actual CSS, JS, public API and image, with separate routes and no authenticated operations', async () => {
  const fetcher = fixture();
  const result = await checkPixivNetwork(fetcher, async url => url.includes('s.pximg.net') ? 'DIRECT' : 'http://127.0.0.1:7897', new AbortController().signal);
  expect(result.results.map(row => row.kind)).toEqual(['page', 'login', 'stylesheet', 'script', 'api', 'image', 'captcha']);
  expect(result.results.every(row => row.ok)).toBe(true);
  expect(result.results.find(row => row.kind === 'stylesheet')!.proxy).toBe('DIRECT');
  expect(result.results.find(row => row.kind === 'image')).toMatchObject({ url: 'https://i.pximg.net/art.jpg', bytes: 16, ok: true });
  expect(fetcher.mock.calls.every(([, input]) => input.headers?.Referer === 'https://www.pixiv.net/')).toBe(true);
});
it('does not mistake a reachable homepage for working CDN resources or malformed API data', async () => {
  const normal = fixture();
  const fetcher: HttpsDownloadFetch = async (url, input) => {
    if (url.includes('s.pximg.net')) throw Error('CDN timed out');
    if (url.includes('/ajax/')) return new Response('{"error":true,"body":[]}', { headers: { 'Content-Type': 'application/json' } });
    return normal(url, input);
  };
  const result = await checkPixivNetwork(fetcher, async () => 'DIRECT', new AbortController().signal);
  expect(result.results.find(row => row.kind === 'page')!.ok).toBe(true);
  expect(result.results.find(row => row.kind === 'stylesheet')).toMatchObject({ ok: false, error: 'CDN timed out' });
  expect(result.results.find(row => row.kind === 'api')!.ok).toBe(false);
  expect(result.results.find(row => row.kind === 'image')!.ok).toBe(false);
});
it('rejects unrelated resource hosts and HTML disguised as script/image and propagates cancellation', async () => {
  const fetcher = fixture();
  fetcher.mockImplementation(async () => new Response('<script src="https://pximg.net.attacker.example/private.js"></script><link href="https://127.0.0.1/private.css">', { headers: { 'Content-Type': 'text/html' } }));
  const result = await checkPixivNetwork(fetcher, async () => 'DIRECT', new AbortController().signal);
  expect(fetcher.mock.calls.every(([url]) => !url.includes('attacker') && !url.includes('127.0.0.1'))).toBe(true);
  expect(result.results.find(row => row.kind === 'captcha')!.ok).toBe(false);
  expect(result.results.find(row => row.kind === 'script')!.ok).toBe(false);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await expect(checkPixivNetwork(fetcher, async () => 'DIRECT', controller.signal)).rejects.toThrow('cancelled');
});
