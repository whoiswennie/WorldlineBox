import { expect, it } from 'vitest';
import { bypassApplicationProxy, proxyBypassRules } from '../../src/shared/proxy-routing';
import { selectSmartCdnRoutes } from '../../src/main/smart-proxy-routes';

it('keeps unknown and Pixiv login, API, image, animation and CAPTCHA dependencies on the proxy', () => {
  for (const host of ['www.pixiv.net', 'accounts.pixiv.net', 'oauth.secure.pixiv.net', 'i.pximg.net', 's.pximg.net', 'ugoira.pximg.net', 'www.google.com', 'www.recaptcha.net', 'www.gstatic.com', 'cn.attacker.example', 'fakebilibili.com', 'unknown.example']) {
    expect(bypassApplicationProxy(`https://${host}/`, 'smart')).toBe(false);
  }
  expect(bypassApplicationProxy('https://s.pximg.net/style.css', 'smart', ['s.pximg.net'])).toBe(true);
  expect(bypassApplicationProxy('https://other.s.pximg.net/', 'smart', ['s.pximg.net'])).toBe(false);
  expect(bypassApplicationProxy('https://s.pximg.net/style.css', 'global', ['s.pximg.net'])).toBe(false);
});

it('matches domestic domains and local addresses consistently, with global mode bypassing only local hosts', () => {
  for (const host of ['www.bilibili.com', 'BILIBILI.COM.', 's1.hdslb.com', 'www.gov.cn', '192.168.1.2', '172.16.1.2', '172.31.0.1', '10.0.0.1', '[fd12::1]', '[fe80::1234]']) {
    expect(bypassApplicationProxy(`https://${host}/`, 'smart')).toBe(true);
    expect(bypassApplicationProxy(`https://${host}/`, 'global')).toBe(false);
  }
  for (const host of ['127.0.0.1', '[::1]', 'localhost', 'intranet']) {
    expect(bypassApplicationProxy(`http://${host}/`, 'global')).toBe(true);
  }
  expect(bypassApplicationProxy('https://172.32.0.1/', 'smart')).toBe(false);
  expect(proxyBypassRules('global', ['s.pximg.net'])).not.toContain('pximg');
  expect(proxyBypassRules('smart', ['s.pximg.net'])).toContain(';s.pximg.net');
});

it('uses a CDN direct route only if the proxy fails and direct transport succeeds', async () => {
  const proxy = 'http://127.0.0.1:7897';
  expect(await selectSmartCdnRoutes(proxy, async () => true)).toEqual([]);
  expect(await selectSmartCdnRoutes(proxy, async () => false)).toEqual([]);
  expect(await selectSmartCdnRoutes(proxy, async (url, route) => !route && url.includes('s.pximg.net'))).toEqual(['s.pximg.net']);
  expect(await selectSmartCdnRoutes(proxy, async (_url, route) => !route)).toEqual(['s.pximg.net', 'i.pximg.net']);
});
