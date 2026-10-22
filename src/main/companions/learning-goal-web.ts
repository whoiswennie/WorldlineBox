import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { load } from 'cheerio';

export interface GoalWebDocument { url: string; title: string; text: string; links: string[] }
/** Public-address classification; DNS is resolved once and pinned to that same request. */
export function isGoalPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a! < 224 && !(a === 100 && b! >= 64 && b! <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && [0, 2, 168].includes(b!))
      && !(a === 198 && [18, 19, 51].includes(b!)) && !(a === 203 && b === 0);
  }
  if (isIP(address) === 6) return /^[23]/u.test(address) && !/^2001:(?:db8|0):/iu.test(address);
  return false;
}
function publicUrl(value: string): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)
    || !url.hostname.includes('.') && !isIP(url.hostname.replace(/^\[|\]$/gu, '')) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname)) throw new Error('学习网页仅支持公开 HTTP(S) 地址。');
  return url;
}
export async function readGoalPublicWeb(value: string, signal: AbortSignal): Promise<GoalWebDocument> {
  let url = publicUrl(value);
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/gu, ''), addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(item => !isGoalPublicAddress(item.address))) throw new Error('学习网页地址解析到了本地、保留或私有网络，不会读取。');
    const address = addresses[0]!, request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const owned = request(url, { method: 'GET', signal, family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/rss+xml;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'WorldlineBox-Learning/1.0' } }, resolve);
      owned.on('error', reject); owned.setTimeout(15000, () => owned.destroy(new Error('公开学习网页读取超时。'))); owned.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.destroy(); const location = response.headers.location;
      if (!location || redirect === 3) throw new Error('学习网页重定向过多或地址缺失。'); url = publicUrl(new URL(location, url).href); continue;
    }
    if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) { response.destroy(); throw new Error('学习网页未成功返回内容。'); }
    if (!/^(?:text\/(?:html|plain|xml)|application\/(?:xhtml\+xml|rss\+xml|xml))(?:;|$)/iu.test(response.headers['content-type'] ?? '')) { response.destroy(); throw new Error('此网页不是可阅读的公开文本。'); }
    let size = 0; const chunks: Buffer[] = [];
    try { for await (const chunk of response) { size += Buffer.byteLength(chunk as Uint8Array); if (size > 1024 * 1024) throw new Error('学习网页超过 1 MiB 阅读范围，请提供更具体的页面。'); chunks.push(Buffer.from(chunk as Uint8Array)); } }
    finally { response.destroy(); }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (/^text\/plain/iu.test(response.headers['content-type'] ?? '')) return { url: url.href, title: url.hostname, text: html, links: [] };
    const page = load(html, { xml: /(?:rss\+xml|text\/xml|application\/xml)/iu.test(response.headers['content-type'] ?? '') });
    page('script,style,noscript,iframe,nav,footer,header').remove();
    const links: string[] = [];
    page('a[href],item > link').each((_index, element) => { const node = page(element), href = node.attr('href') ?? node.text(); try { const link = publicUrl(new URL(href, url).href).href; if (links.length < 30 && !links.includes(link)) links.push(link); } catch { /* Unreadable links confer no permission. */ } });
    const title = page('title').first().text().trim().slice(0, 512) || url.hostname;
    const text = page('article').first().text().trim() || page('main').first().text().trim() || page('body').text().trim() || page.root().text().trim();
    return { url: url.href, title, text: text.replace(/[\t ]+/gu, ' ').replace(/\n{3,}/gu, '\n\n'), links };
  }
  throw new Error('公开网页读取未完成。');
}
