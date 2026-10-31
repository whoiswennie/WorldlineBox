// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanionAttachment } from '../../src/shared/companions';
import { CompanionDocumentPreview } from '../../src/renderer/companions/CompanionDocumentPreview';

const diagram = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
const purifier = vi.hoisted(() => ({ sanitize: vi.fn() }));
// Exercise the real MessageDiagram admission, SVG sanitization and local
// failure fallback without loading Mermaid's layout engine in this short UI test.
vi.mock('mermaid', () => ({ default: diagram }));
// happy-dom does not support DOMPurify's SVG document profile. Its boundary is
// mocked explicitly; this test is not a real-browser DOMPurify security audit.
vi.mock('dompurify', () => ({ default: purifier }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
const attachment = (name = 'report.md', id = name): CompanionAttachment => ({ id, name, mime: name.endsWith('.md') ? 'text/markdown' : 'text/plain', size: 1024 });
beforeEach(() => {
  diagram.initialize.mockReset(); diagram.render.mockReset();
  diagram.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><text x="5" y="30">Safe diagram</text></svg>' });
  purifier.sanitize.mockReset(); purifier.sanitize.mockImplementation((svg: string) => svg);
});
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); delete (window as unknown as { worldlinebox?: unknown }).worldlinebox; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function mount(content: string, file = attachment()) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(content)); vi.stubGlobal('fetch', fetcher);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const props = { attachment: file, onClose: vi.fn(), onReveal: vi.fn(), onLaunch: vi.fn() };
  await act(async () => root!.render(<CompanionDocumentPreview {...props} />));
  return { fetcher, props };
}
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;

it('reads Markdown as a document with headings, inline emphasis, lists, GFM table and highlighted code, and exposes the unchanged source', async () => {
  const source = '# 今日报告\n\n这是 **重点** 内容。\n\n- 第一项\n- 第二项\n\n| 项目 | 状态 |\n| --- | --- |\n| 学习 | 已记录 |\n\n```js\nconst value = 1;\n```\n';
  const { fetcher, props } = await mount(source);
  expect(host.querySelector('article[aria-label="Markdown 正文"] h1')?.textContent).toBe('今日报告');
  expect(host.querySelector('p strong')?.textContent).toBe('重点'); expect(host.querySelectorAll('li')).toHaveLength(2);
  expect(host.querySelectorAll('table td')).toHaveLength(2); expect(host.querySelector('.hljs-keyword')?.textContent).toBe('const');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭文件预览');
  expect(fetcher).toHaveBeenCalledWith('worldlinebox-companion://attachment/report.md', expect.objectContaining({ headers: { Range: 'bytes=0-131071' } }));
  await act(() => button('原文').click()); expect(host.querySelector('.companion-document-source')?.textContent).toBe(source); expect(host.querySelector('article h1')).toBeNull();
  await act(() => button('阅读').click()); expect(host.querySelector('article h1')?.textContent).toBe('今日报告'); expect(fetcher).toHaveBeenCalledTimes(1);
  await act(() => button('系统打开').click()); expect(props.onLaunch).toHaveBeenCalledOnce();
});

it('keeps plain text literal and has no Markdown controls or interpreted HTML', async () => {
  const source = '# literal heading\n\n<script>window.executed = true</script>\n\n| literal | table |';
  await mount(source, attachment('notes.txt'));
  expect(host.querySelector('.companion-document-source')?.textContent).toBe(source);
  expect(host.querySelector('article h1, article table, script')).toBeNull();
  expect(host.querySelector('[aria-label="Markdown 显示方式"]')).toBeNull();
});

it('never fetches Markdown images or executes HTML/unsafe URLs and opens only an explicitly clicked safe link', async () => {
  const open = vi.fn(async () => ({ ok: true })); Object.assign(window, { worldlinebox: { shell: { openExternalUrl: open } } });
  const { fetcher } = await mount('<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n[docs](https://example.com/docs)\n\n![remote](https://example.com/tracker.png)');
  expect(host.querySelector('script, iframe, article img')).toBeNull(); expect(open).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[title^="javascript:"]')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('[title="https://example.com/docs"]')!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
});

it('routes Mermaid through strict rendering and the SVG sanitizer boundary, then strips remaining external SVG references', async () => {
  const unsafe = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject><image href="https://example.com/tracker.png"/></svg>';
  diagram.render.mockResolvedValue({ svg: unsafe });
  purifier.sanitize.mockReturnValue('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><a href="https://example.com/escape"><text>Safe diagram</text></a></svg>');
  await mount('# 流程\n\n```mermaid\nflowchart LR\n A[交流] --> B[反思]\n```');
  await act(async () => { await Promise.resolve(); });
  expect(diagram.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false }));
  expect(diagram.render).toHaveBeenCalledWith(expect.stringMatching(/^companion-diagram-/u), 'flowchart LR\n A[交流] --> B[反思]');
  expect(purifier.sanitize).toHaveBeenCalledWith(unsafe, expect.objectContaining({ USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'image'] }));
  expect(host.querySelector('.companions-diagram-svg svg')?.textContent).toContain('Safe diagram');
  expect(host.querySelector('script, foreignObject, image, svg a[href]')).toBeNull();
  await act(() => button('查看源码').click()); expect(host.querySelector('.companions-diagram pre')?.textContent).toContain('A[交流] --> B[反思]');
});

it('rejects an empty or non-SVG sanitization result instead of displaying an XML parser error document as a chart', async () => {
  purifier.sanitize.mockReturnValue('');
  await mount('# 报告\n\n```mermaid\nflowchart LR\n A-->B\n```');
  await act(async () => { await Promise.resolve(); });
  expect(host.querySelector('.companions-diagram-svg, parsererror')).toBeNull();
  expect(host.textContent).toContain('图表暂时无法渲染，可查看源码。');
  expect(host.querySelector('.companions-diagram pre')?.textContent).toBe('flowchart LR\n A-->B');
});

it('isolates a Mermaid syntax failure to the diagram and retains the surrounding Markdown and exact diagram source', async () => {
  diagram.render.mockRejectedValue(new Error('invalid diagram input'));
  await mount('# 报告仍可读\n\n```mermaid\nnot a valid graph !!!\n```\n\n后续段落保留。');
  await act(async () => { await Promise.resolve(); });
  expect(host.querySelector('h1')?.textContent).toBe('报告仍可读'); expect(host.textContent).toContain('后续段落保留。');
  expect(host.textContent).toContain('图表暂时无法渲染，可查看源码。'); expect(host.querySelector('.companions-diagram pre')?.textContent).toBe('not a valid graph !!!');
  expect(host.querySelector('.companions-diagram-svg')).toBeNull();
});

it('clears a previous file and reading mode immediately while the next file is still being read', async () => {
  const { props } = await mount('# OLD_PRIVATE_CONTENT');
  await act(() => button('原文').click());
  let resolve!: (value: Response) => void; vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  await act(() => root!.render(<CompanionDocumentPreview {...props} attachment={attachment('new.md')} />));
  expect(host.textContent).not.toContain('OLD_PRIVATE_CONTENT'); expect(host.textContent).toContain('正在读取文件');
  await act(async () => resolve(new Response('# NEW_CURRENT_CONTENT')));
  expect(host.querySelector('article h1')?.textContent).toBe('NEW_CURRENT_CONTENT');
  expect(host.querySelector('.companion-document-view button[aria-pressed="true"]')?.textContent).toBe('阅读');
});

it('keeps Escape inert during IME composition and offers a local retry after a read failure', async () => {
  const { fetcher, props } = await mount('');
  fetcher.mockRejectedValueOnce(new Error('temporary read failure'));
  await act(() => root!.render(<CompanionDocumentPreview {...props} attachment={attachment('retry.md')} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('temporary read failure');
  fetcher.mockResolvedValueOnce(new Response('# Recovered'));
  await act(() => button('重新读取').click()); expect(host.querySelector('h1')?.textContent).toBe('Recovered');
  await act(() => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  expect(props.onClose).not.toHaveBeenCalled();
  await act(() => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
});
