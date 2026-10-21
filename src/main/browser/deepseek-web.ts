import { z } from 'zod';
import { browserAiPublicUrl, type BrowserAiSource } from '../../shared/browser-ai';

const result = z.object({ title: z.string().nullish(), url: z.string(), snippet: z.string().nullish(), summary: z.string().nullish(), content: z.string().nullish(), date: z.string().nullish() });
const MAX_BYTES = 2 * 1024 * 1024;
/** Native tool APIs. Always use the fixed official origin, never a model URL. */
export class DeepseekWebTools {
  constructor(private readonly getKey: () => string, private readonly fetchFn: typeof fetch = fetch) {}
  private async call(tool: 'search' | 'fetch', payload: unknown, signal: AbortSignal): Promise<unknown> {
    const key = this.getKey().trim();
    if (!key || key.length > 8192 || /[\r\n]/.test(key)) throw Error('请在浏览器设置中配置 DeepSeek 搜索密钥。');
    let response: Response;
    try { response = await this.fetchFn(`https://api.deepseek.com/v1/tools/${tool}`, { method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
    catch { signal.throwIfAborted(); throw Error('无法连接 DeepSeek 搜索服务，请检查全局网络设置。'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      const message: Record<number, string> = { 400: '搜索条件或网页地址无效。', 401: 'DeepSeek 密钥无效，请重新配置。', 402: 'DeepSeek 账户余额不足。',
        403: '此网页的抓取被服务安全策略拒绝。', 404: '网页没有可提取的正文，或目标站点限制抓取。', 429: '搜索服务请求频率受限，请稍后再试。' };
      throw Error(message[response.status] ?? `DeepSeek 服务暂不可用（HTTP ${response.status}）。`);
    }
    const reader = response.body?.getReader(); if (!reader) throw Error('搜索服务返回了空响应。');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
        if (size > MAX_BYTES) throw Error('网页内容超过处理上限，请缩小搜索范围。'); chunks.push(next.value); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('搜索服务返回了无效数据。'); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  async search(query: string, signal: AbortSignal, count = 8, options: { need_content?: boolean; ori_question?: string } = {}): Promise<BrowserAiSource[]> {
    if (!query.trim() || [...query].length > 128) throw Error('搜索词最多 128 个字符，请缩短后重试。');
    const data = z.object({ results: z.array(result).max(50) }).safeParse(await this.call('search', { query, count, need_content: options.need_content ?? false,
      ...(options.ori_question ? { ori_question: options.ori_question } : {}) }, signal));
    if (!data.success) throw Error('搜索结果格式无效。');
    const seen = new Set<string>();
    return data.data.results.flatMap(item => {
      const url = browserAiPublicUrl(item.url); if (!url || seen.has(url)) return []; seen.add(url);
      return [{ id: seen.size, title: (item.title || url).slice(0, 1000), url, snippet: (item.snippet || item.summary || '').slice(0, 6000),
        ...(item.summary ? { summary: item.summary.slice(0, 6000) } : {}),
        content: options.need_content ? (item.content ?? '').slice(0, 32000) : '', kind: 'search' as const,
        ...(options.need_content && (item.content?.length ?? 0) > 32000 ? { truncated: true } : {}), ...(item.date ? { date: item.date.slice(0, 100) } : {}) }];
    }).slice(0, 20);
  }
  async fetch(url: string, signal: AbortSignal, id = 1): Promise<BrowserAiSource> {
    const safe = browserAiPublicUrl(url); if (!safe) throw Error('请输入公开的 HTTP/HTTPS 网页地址；本机和内网地址不发送给抓取服务。');
    const data = z.object({ title: z.string(), content: z.string() }).safeParse(await this.call('fetch', { url: safe }, signal));
    if (!data.success || !data.data.content.trim()) throw Error('此网页没有可提取的正文。');
    return { id, title: (data.data.title || safe).slice(0, 1000), url: safe, content: data.data.content.slice(0, 32000), snippet: '', kind: 'fetched', ...(data.data.content.length > 32000 ? { truncated: true } : {}) };
  }
}
