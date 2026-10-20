import { expect, it, vi } from 'vitest';
import { DeepseekWebTools } from '../../src/main/browser/deepseek-web';
import { browserAiPublicUrl } from '../../src/shared/browser-ai';
import { browserAgentDeclarations, parseBrowserAgentTool } from '../../src/shared/browser-agent-tools';

const signal = () => new AbortController().signal;
it('uses fixed official tool endpoints, exact search syntax, independent credentials and bounded results', async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [
    { title: 'Official', url: 'https://www.electronjs.org/docs/latest', summary: 'Official summary', content: 'Full content' },
    { title: 'Duplicate', url: 'https://www.electronjs.org/docs/latest', summary: 'duplicate' },
    { title: 'Unsafe', url: 'javascript:alert(1)' }, { title: 'Private', url: 'http://127.0.0.1/private' },
  ] })));
  const tools = new DeepseekWebTools(() => 'test-browser-key', fetchFn);
  const query = 'Electron site:electronjs.org lang:en after:2026-01-01 -site:ads.example.com';
  const found = await tools.search(query, signal(), 3, { need_content: true, ori_question: 'Find official documentation' });
  expect(fetchFn).toHaveBeenCalledWith('https://api.deepseek.com/v1/tools/search', expect.objectContaining({ redirect: 'error', method: 'POST',
    headers: { Authorization: 'Bearer test-browser-key', 'Content-Type': 'application/json' } }));
  expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body))).toEqual({ query, count: 3, need_content: true, ori_question: 'Find official documentation' });
  expect(found).toHaveLength(1); expect(found[0]).toMatchObject({ snippet: 'Official summary', content: 'Full content', kind: 'search' });
});

it.each([401, 402, 403, 404, 429, 500])('maps HTTP %i to actionable errors without returning response bodies or keys', async status => {
  const tools = new DeepseekWebTools(() => 'secret-never-return', vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-never-return', { status })));
  await expect(tools.fetch('https://example.com/article', signal())).rejects.not.toThrow('secret-never-return');
});

it('rejects malformed/oversized responses, missing keys, and overlong Unicode queries', async () => {
  const missing = vi.fn<typeof fetch>(); await expect(new DeepseekWebTools(() => '', missing).search('hello', signal())).rejects.toThrow('密钥'); expect(missing).not.toHaveBeenCalled();
  const bad = new DeepseekWebTools(() => 'test-key', vi.fn<typeof fetch>().mockResolvedValue(new Response('{invalid')));
  await expect(bad.fetch('https://example.com/', signal())).rejects.toThrow('无效数据');
  await expect(bad.search('鱼'.repeat(129), signal())).rejects.toThrow('128');
  const large = new DeepseekWebTools(() => 'test-key', vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1))));
  await expect(large.search('hello', signal())).rejects.toThrow('上限');
});

it('marks clipped fetched content so neither the assistant nor the source card mistakes a bounded cache for a full page', async () => {
  const tools = new DeepseekWebTools(() => 'test-key', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ title: 'Long document', content: 'page '.repeat(7000) }))));
  const source = await tools.fetch('https://example.com/long-page', signal()); expect(source.content).toHaveLength(32000); expect(source.truncated).toBe(true);
});

it('blocks credential-bearing, local, private and executable URLs before remote fetch', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'https://user:pass@example.com', 'http://localhost/a', 'http://0x7f000001',
    'http://10.0.0.2/a', 'http://172.24.0.1/a', 'http://192.168.1.1/', 'http://[::1]/', 'http://printer.local/']) expect(browserAiPublicUrl(url), url).toBeUndefined();
  expect(browserAiPublicUrl('https://example.com/article#section')).toBe('https://example.com/article');
});

it('advertises native function schemas and rejects arbitrary JS/filesystem capabilities', () => {
  expect(browserAgentDeclarations.length).toBeGreaterThan(15);
  expect(browserAgentDeclarations.find(item => item.name === 'browser_search')!.description).toContain('after:YYYY-MM-DD');
  expect(parseBrowserAgentTool('browser_search', '{"query":"site:electronjs.org 浏览器"}').input).toMatchObject({ count: 8, need_content: false });
  expect(() => parseBrowserAgentTool('execute_javascript', '{"code":"document.cookie"}')).toThrow('名称');
  expect(() => parseBrowserAgentTool('browser_click', '{"ref":"e1","javascript":"alert(1)"}')).toThrow('参数');
});
