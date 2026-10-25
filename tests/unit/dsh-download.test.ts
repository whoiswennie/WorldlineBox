import { describe, expect, it, vi } from 'vitest';
import { fetchHttpsDownload, type HttpsDownloadFetch } from '../../src/main/dsh/https-download';
const packageUrl = 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.2.tgz';

describe('DSH HTTPS download routing', () => {
  it('tracks HTTPS redirects without relying on the empty Electron Response.url', async () => {
    const responses = [new Response('', { status: 302, headers: { location: '/releases/fixed.tgz' } }), new Response('installer')];
    const fetch = vi.fn<HttpsDownloadFetch>(async () => responses.shift()!);
    const signal = new AbortController().signal;
    const response = await fetchHttpsDownload(packageUrl, fetch, signal);
    expect(response.url).toBe('');
    expect(await response.text()).toBe('installer');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([packageUrl, 'https://registry.npmjs.org/releases/fixed.tgz']);
    expect(fetch.mock.calls.every(([, init]) => init.redirect === 'manual' && init.signal === signal)).toBe(true);
  });

  it('rejects insecure requests, downgraded redirects, credentials and redirect loops before continuing', async () => {
    const fetch = vi.fn<HttpsDownloadFetch>(async () => new Response('', { status: 302, headers: { location: 'http://example.com/payload' } }));
    const signal = new AbortController().signal;
    await expect(fetchHttpsDownload('http://example.com/payload', fetch, signal)).rejects.toThrow('HTTPS');
    expect(fetch).not.toHaveBeenCalled();
    await expect(fetchHttpsDownload(packageUrl, fetch, signal)).rejects.toThrow('HTTPS');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(fetchHttpsDownload('https://user:password@example.com/file', fetch, signal)).rejects.toThrow('credentials');
    const loop = vi.fn<HttpsDownloadFetch>(async () => new Response('', { status: 302, headers: { location: '/loop' } }));
    await expect(fetchHttpsDownload(packageUrl, loop, signal)).rejects.toThrow('too many');
    expect(loop).toHaveBeenCalledTimes(6);
  });
});
