// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserMarkdown } from '../../src/renderer/browser/BrowserMarkdown';
vi.mock('../../src/renderer/companions/MessageDiagram', () => ({ MessageDiagram: ({ source }: { source: string }) => <figure data-safe-mermaid>{source}</figure> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
async function mount(text: string, pending = false) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const open = vi.fn();
  await act(() => root.render(<BrowserMarkdown text={text} pending={pending} open={open} />)); return open;
}
it('renders headings, GFM tables/checklists, math, footnotes and highlighted fenced code', async () => {
  await mount('# A heading\n\n~~old~~ **strong**\n\n- [x] done\n\n| A | B |\n| :- | -: |\n| one | two |\n\nInline $x^2$.\n\n```js\nconst value = 1;\n```\n\nA note[^a].\n\n[^a]: Source note');
  expect(host.querySelector('h1')?.textContent).toBe('A heading'); expect(host.querySelectorAll('table td')).toHaveLength(2);
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true); expect(host.querySelector('.katex')).not.toBeNull();
  expect(host.querySelector('.hljs-keyword')?.textContent).toBe('const'); expect(host.querySelector('[data-footnotes]')?.textContent).toContain('Source note');
});
it('uses the bounded diagram renderer only after streaming completes', async () => {
  await mount('```mermaid\nflowchart LR\n A-->B\n```', true); expect(host.querySelector('[data-safe-mermaid]')).toBeNull();
  expect(host.querySelector('pre code')?.textContent).toContain('A-->B');
  await act(() => root.render(<BrowserMarkdown text={'```mermaid\nflowchart LR\n A-->B\n```'} open={() => undefined} />));
  expect(host.querySelector('[data-safe-mermaid]')?.textContent).toContain('A-->B');
});
it('keeps HTML, script URLs and remote images inert while opening explicit safe links', async () => {
  const open = await mount('<script>window.pwned=1</script>\n\n[unsafe](javascript:alert(1))\n\n[docs](https://example.com/docs)\n\n![remote](https://example.com/track.png)');
  expect(host.querySelector('script')).toBeNull(); expect(host.querySelector('img')).toBeNull(); expect(open).not.toHaveBeenCalled();
  await act(() => host.querySelector<HTMLButtonElement>('[title="https://example.com/docs"]')!.click()); expect(open).toHaveBeenCalledWith('https://example.com/docs');
});
it('renders numbered citations as source chips linked to the actual matching source', async () => {
  await mount('Verified [4](https://example.com/source).'); const open = vi.fn();
  await act(() => root.render(<BrowserMarkdown text="Verified [4](https://example.com/source)." sources={[{ id: 4, url: 'https://example.com/source', title: 'Actual source title', kind: 'fetched', content: '', snippet: '' }]} open={open} />));
  const citation = host.querySelector<HTMLButtonElement>('.browser-citation')!; expect(citation.getAttribute('aria-label')).toBe('4 · Actual source title');
  await act(() => citation.click()); expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/source');
});
