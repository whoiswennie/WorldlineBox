export type ProxyRouting = 'smart' | 'global';

// Match host boundaries, never substrings. Unknown public destinations use the
// proxy, including every Pixiv/login/API/CAPTCHA domain and new CDN subdomains.
const DIRECT_DOMAINS = ['cn', 'bilibili.com', 'biliapi.net', 'biliapi.com', 'bilivideo.com', 'hdslb.com',
  'baidu.com', 'bdstatic.com', 'qq.com', 'qpic.cn', 'gtimg.com', 'weixin.com', 'taobao.com',
  'tmall.com', 'alicdn.com', 'alipay.com', 'aliyun.com', 'jd.com', '163.com', '126.com',
  'netease.com', 'douyin.com', 'douyinpic.com', 'byteimg.com', 'zhihu.com', 'zhimg.com'];
const LOCAL_RULES = ['<local>', 'localhost', '127.0.0.1', '[::1]'];
const LAN_RULES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'];

export function proxyBypassRules(routing: ProxyRouting, cdnDirectHosts: readonly string[] = []): string {
  return [...LOCAL_RULES, ...(routing === 'smart' ? [...LAN_RULES, ...DIRECT_DOMAINS.flatMap(host => [host, '*.' + host]), ...cdnDirectHosts] : [])].join(';');
}

export function bypassApplicationProxy(destination: string, routing: ProxyRouting, cdnDirectHosts: readonly string[] = []): boolean {
  const host = new URL(destination).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '::1' || host === 'localhost' || host === '127.0.0.1' || !/[.:]/.test(host)) return true;
  if (routing !== 'smart') return false;
  if (/^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
    || /^(?:f[cd][\da-f]{2}:|fe[89ab][\da-f]:)/.test(host)) return true;
  return cdnDirectHosts.includes(host) || DIRECT_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain));
}
