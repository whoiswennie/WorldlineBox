// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/renderer/i18n', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
import { CaptureAnswerContent } from '../../src/renderer/capture-tools/CaptureAnswerContent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });

it('renders Markdown and GFM structure instead of exposing syntax as plain text', async () => {
  await act(() => root.render(<CaptureAnswerContent text={'## 分析\n\n**重点**与`代码`。\n\n1. 一\n2. 二\n\n> 引用\n\n```js\nconst answer = 42;\n```\n\n| 标题 | 内容 |\n| --- | --- |\n| A | B |\n\n- [x] 已完成'} />));
  expect(host.querySelector('h2')?.textContent).toBe('分析');
  expect(host.querySelector('strong')?.textContent).toBe('重点');
  expect(host.querySelectorAll('ol > li')).toHaveLength(2);
  expect(host.querySelector('blockquote')?.textContent).toContain('引用');
  expect(host.querySelector('pre > code.language-js')?.textContent).toBe('const answer = 42;\n');
  expect(host.querySelector('.capture-answer-table table td')?.textContent).toBe('A');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
});

it('only displays actual provider reasoning, collapsed by default, while preserving expansion during streaming', async () => {
  await act(() => root.render(<CaptureAnswerContent text="" pending />));
  expect(host.querySelector('details')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain('正在思考');
  await act(() => root.render(<CaptureAnswerContent text="" reasoning="先检查图中的错误。" pending />));
  const details = host.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('先检查图中的错误。');
  await act(() => { details.open = true; });
  await act(() => root.render(<CaptureAnswerContent text="已找到 **原因**。" reasoning="先检查图中的错误。然后检查网络。" pending />));
  expect(host.querySelector('details')?.open).toBe(true);
  expect(host.querySelector('details')?.textContent).toContain('然后检查网络。');
  expect(host.querySelector('strong')?.textContent).toBe('原因');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('正在输出');
  await act(() => root.render(<CaptureAnswerContent text="完整回答。" reasoning="先检查图中的错误。然后检查网络。" />));
  expect(host.querySelector('details')?.open).toBe(true);
  expect(host.querySelector('summary')?.textContent).toContain('已完成');
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('accepts incomplete streamed Markdown and replaces it with the completed structure', async () => {
  await act(() => root.render(<CaptureAnswerContent text={'先看 **渐进\n\n```ts\nlet value'} pending />));
  expect(host.textContent).toContain('渐进');
  expect(host.querySelector('pre > code')?.textContent).toContain('let value');
  await act(() => root.render(<CaptureAnswerContent text={'先看 **渐进输出**。\n\n```ts\nlet value = 1;\n```'} />));
  expect(host.querySelector('strong')?.textContent).toBe('渐进输出');
  expect(host.querySelector('pre > code')?.textContent).toContain('let value = 1;');
});

it('keeps raw HTML inert and opens only safe links on an explicit click without loading model images', async () => {
  const open = vi.fn();
  await act(() => root.render(<CaptureAnswerContent onOpenLink={open} text={'[文档](https://example.com/docs)\n\n![示例图](https://example.com/image.png)\n\n[脚本](javascript:alert(1)) [文件](file:///C:/private.txt) [数据](data:text/html,unsafe) [相对路径](/settings) [凭据](https://u:p@example.com/private)\n\n<img src="https://example.com/tracker.png" onerror="unsafe()"><script>unsafe()</script>'} />));
  expect(open).not.toHaveBeenCalled();
  expect(host.querySelector('img, script, iframe, a')).toBeNull();
  const links = [...host.querySelectorAll<HTMLButtonElement>('.capture-answer-link')];
  expect(links).toHaveLength(2);
  await act(() => links[0]!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
  await act(() => links[1]!.click());
  expect(open).toHaveBeenLastCalledWith('https://example.com/image.png');
});

it('renders external content as text when no open callback is available', async () => {
  await act(() => root.render(<CaptureAnswerContent text="[链接](https://example.com) ![图片](https://example.com/image.png)" />));
  expect(host.textContent).toContain('链接'); expect(host.textContent).toContain('图片');
  expect(host.querySelector('button, img, a')).toBeNull();
});
