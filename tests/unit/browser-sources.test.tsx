// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSourceCard, BrowserSources } from '../../src/renderer/browser/BrowserSourceCard';
import { BrowserToolTrace } from '../../src/renderer/browser/BrowserToolTrace';
import { BrowserStartPage } from '../../src/renderer/browser/BrowserStartPage';
import { browserStateSchema } from '../../src/shared/browser';
import type { BrowserAiSource } from '../../src/shared/browser-ai';
vi.mock('../../src/renderer/browser/BrowserMarkdown', () => ({ BrowserMarkdown: ({ text }: { text: string }) => <div data-source-body>{text}</div> }));
vi.mock('../../src/renderer/i18n', () => ({ useLocale: () => ({ locale: 'zh-CN' }), useT: () => (key: string) => key }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
async function mount(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(() => root.render(node)); }
const source: BrowserAiSource = { id: 4, title: 'Official browser documentation', url: 'https://www.electronjs.org/docs/latest', kind: 'fetched', snippet: 'A readable page summary.', content: '# The original source\n\nFull extracted Markdown.' };

it('turns legacy HTML and Markdown into inert readable previews and local dates', async () => {
  await mount(<BrowserSourceCard source={{ ...source, title: '<font color=red>天幻网建站五周年</font> &amp; 新闻',
    snippet: '## 摘要\n\n**真实事实**与 `API`，阅读[原文](https://example.com)。<script>BAD_SCRIPT</script><img src="https://example.com/tracker" onerror="BAD_HANDLER">',
    date: '2004-07-13T16:00:00+00:00' }} open={vi.fn()} zh />);
  expect(host.querySelector('.browser-source-card-title')?.textContent).toBe('天幻网建站五周年 & 新闻');
  const excerpt = host.querySelector('.browser-source-card-excerpt')!;
  expect(excerpt.textContent).toContain('真实事实'); expect(excerpt.querySelector('strong')?.textContent).toBe('真实事实');
  expect(excerpt.querySelector('code')?.textContent).toBe('API');
  expect(host.textContent).not.toMatch(/<font|##|\*\*|BAD_SCRIPT|BAD_HANDLER|T16:00/);
  expect(excerpt.querySelector('img,script,a')).toBeNull(); expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2004-07-13T16:00:00+00:00');
});

it('clears the native results and input through its dedicated reset action without clearing chat', async () => {
  const state = browserStateSchema.parse({ tabs: [], bookmarks: [], downloads: [], historyCount: 0, preferences: {}, permissions: [], fullscreen: false, revision: 0,
    ai: { config: { hasSearchKey: true, keySource: 'browser', hasModel: true, model: 'deepseek-flash', apiFormat: 'openai_chat', contextTokens: 600000 }, page: { query: 'Find sources', sources: [source] } } });
  const reset = vi.fn(async () => { delete state.ai!.page; return true; });
  const node = () => <BrowserStartPage state={state} navigate={vi.fn()} start={vi.fn()} settings={vi.fn()} reset={reset} />;
  await mount(node()); const field = host.querySelector<HTMLInputElement>('input')!;
  await act(() => host.querySelector<HTMLButtonElement>('.browser-results-actions button')!.click());
  expect(reset).toHaveBeenCalledOnce(); expect(field.value).toBe('');
  await act(() => root.render(node())); expect(host.querySelector('.browser-start-intro')).not.toBeNull(); expect(host.querySelector('.browser-search-results')).toBeNull();
});

it('shows readable provenance and opens the exact source, mounting body content only on demand', async () => {
  const open = vi.fn(); await mount(<BrowserSourceCard source={source} open={open} zh />);
  expect(host.textContent).toContain('electronjs.org'); expect(host.textContent).toContain('已抓取正文');
  expect(host.textContent).toContain('A readable page summary.'); expect(host.querySelector('[data-source-body]')).toBeNull();
  const read = [...host.querySelectorAll('button')].find(button => button.textContent === '阅读正文')!;
  await act(() => read.click()); expect(read.getAttribute('aria-expanded')).toBe('true'); expect(host.querySelector('[data-source-body]')?.textContent).toContain('Full extracted Markdown');
  await act(() => read.click()); expect(host.querySelector('[data-source-body]')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('.browser-source-card-title')!.click()); expect(open).toHaveBeenCalledExactlyOnceWith(source.url);
});
it('distinguishes search evidence from fetched or live page content and bounds the initial source list', async () => {
  const sources = [source, { ...source, id: 5, kind: 'search' as const, content: '' }, { ...source, id: 6, kind: 'current' as const }, { ...source, id: 7 }];
  await mount(<BrowserSources sources={sources} open={vi.fn()} zh />);
  expect(host.querySelectorAll('article')).toHaveLength(3); expect(host.textContent).toContain('搜索结果'); expect(host.textContent).toContain('浏览器实读');
  await act(() => host.querySelector<HTMLButtonElement>('.browser-sources-more')!.click()); expect(host.querySelectorAll('article')).toHaveLength(4);
});
it('presents human-readable browser progress while keeping raw parameters in closed technical details', async () => {
  await mount(<BrowserToolTrace tools={[{ id: 't1', name: 'browser_search', input: '{"query":"Electron site:electronjs.org lang:en"}', result: '[{"id":4}]', status: 'completed' }]} busy zh />);
  expect(host.querySelector('.browser-tool-heading')?.textContent).toContain('搜索网页');
  expect(host.querySelector('li > p')?.textContent).toBe('Electron site:electronjs.org lang:en');
  expect(host.querySelector<HTMLDetailsElement>('.browser-tool-technical')?.open).toBe(false);
});

it('shows direct search/fetch failures on the start page without requiring the chat sidebar', async () => {
  const state = browserStateSchema.parse({ tabs: [], bookmarks: [], downloads: [], historyCount: 0, preferences: {}, permissions: [], fullscreen: false, revision: 0,
    ai: { config: { hasSearchKey: true, keySource: 'browser', hasModel: false, model: '', apiFormat: '', contextTokens: 16000 }, task: {
      id: 'failed-fetch', tabId: 'tab1', mode: 'fetch', query: 'https://example.com/', status: 'failed', stage: '暂时无法继续', sources: [], answer: '',
      error: '此网页没有可提取的正文。', warnings: [], updatedAt: '', messages: [], tools: [], contextBytes: 0, contextTokensUsed: 0, compacted: 0 } } });
  await mount(<BrowserStartPage state={state} navigate={vi.fn()} start={vi.fn()} settings={vi.fn()} reset={vi.fn(async () => true)} />);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('此网页没有可提取的正文。');
});
