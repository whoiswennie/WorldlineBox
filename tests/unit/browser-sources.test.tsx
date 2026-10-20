// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSourceCard, BrowserSources } from '../../src/renderer/browser/BrowserSourceCard';
import { BrowserToolTrace } from '../../src/renderer/browser/BrowserToolTrace';
import type { BrowserAiSource } from '../../src/shared/browser-ai';
vi.mock('../../src/renderer/browser/BrowserMarkdown', () => ({ BrowserMarkdown: ({ text }: { text: string }) => <div data-source-body>{text}</div> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
async function mount(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(() => root.render(node)); }
const source: BrowserAiSource = { id: 4, title: 'Official browser documentation', url: 'https://www.electronjs.org/docs/latest', kind: 'fetched', snippet: 'A readable page summary.', content: '# The original source\n\nFull extracted Markdown.' };

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
