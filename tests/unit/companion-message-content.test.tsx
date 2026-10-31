// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageContent } from '../../src/renderer/companions/MessageContent';
import { CompanionActionCard } from '../../src/renderer/companions/CompanionProgress';
import type { CompanionAction } from '../../src/shared/companions';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });
async function render(content: string, onOpenUrl = vi.fn()) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<MessageContent content={content} onOpenUrl={onOpenUrl} />));
  if (container.querySelector('[data-message-format="loading"]')) await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('[data-message-format="loading"]')).toBeNull();
  }, { timeout: 5000, interval: 20 });
  return onOpenUrl;
}

it('renders useful message structure including emphasis, both lists, fenced code and aligned tables', async () => {
  await render('## 整理结果\n\n**三张照片**，包含 `海边.jpg`。\n\n- 蓝色海面\n- 岸边建筑\n\n1. 查看文件\n2. 对照清单\n\n```js\nconst image = "<photo>";\n```\n\n| 文件 | 内容 |\n| --- | :---: |\n| 海边.jpg | **海浪** |');
  expect(container!.querySelector('h2')!.textContent).toBe('整理结果');
  expect(container!.querySelector('p strong')!.textContent).toBe('三张照片');
  expect(container!.querySelector('p code')!.textContent).toBe('海边.jpg');
  expect(container!.querySelectorAll('ul li')).toHaveLength(2);
  expect(container!.querySelectorAll('ol li')).toHaveLength(2);
  expect(container!.querySelector('pre code')!.textContent).toBe('const image = "<photo>";');
  expect(container!.querySelector('tbody td strong')!.textContent).toBe('海浪');
  expect(container!.querySelectorAll('th')[1]!.style.textAlign).toBe('center');
});

it('never injects raw HTML or loads remote image pixels and opens valid URLs only on an explicit click', async () => {
  const open = await render('<img src="https://evil.test/track" onerror="alert(1)"><script>alert(2)</script>\n\n[危险](javascript:alert) [本地](file:///C:/private.txt) [带密钥](https://user:secret@example.test) [参考](https://example.test/guide)\n\n![远程图片](https://example.test/image.png)');
  expect(container!.querySelector('img, script, iframe')).toBeNull();
  expect(open).not.toHaveBeenCalled();
  const links = [...container!.querySelectorAll<HTMLButtonElement>('button.companions-message-link')];
  expect(links.map(link => link.textContent)).toEqual(['参考', '远程图片']);
  await act(() => links[0]!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/guide');
  await act(() => links[1]!.click());
  expect(open).toHaveBeenLastCalledWith('https://example.test/image.png');
});
it('renders GFM task lists, nested lists, footnotes and mathematical notation', async () => {
  await render('- [x] 已完成\n- [ ] 待办\n  - 子项\n\n~~删除线~~，行内 $x^2$。\n\n$$\n\\frac{1}{2}\n$$\n\n说明[^1]\n\n[^1]: 脚注内容');
  expect(container!.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  expect(container!.querySelector('ul ul li')!.textContent).toContain('子项');
  expect(container!.querySelector('del')!.textContent).toBe('删除线');
  expect(container!.querySelector('.katex-display')).not.toBeNull();
  expect(container!.querySelector('section[data-footnotes]')!.textContent).toContain('脚注内容');
});

it('keeps conversational tildes and filenames literal while preserving explicit double-tilde deletion', async () => {
  await render('我帮你放~这几个文件里，先发 OGG~\n\n- 东方~Arrange~.ogg\n- 祈愿致那时候的你.wav\n\n想听哪首就说一声~较大的几个可能要加载一会儿。\n\n~~已取消~~，`~文件~.ogg`');
  expect([...container!.querySelectorAll('del')].map(node => node.textContent)).toEqual(['已取消']);
  expect(container!.querySelector('p')!.textContent).toBe('我帮你放~这几个文件里，先发 OGG~');
  expect(container!.querySelector('li')!.textContent).toBe('东方~Arrange~.ogg');
  expect(container!.querySelector('code')!.textContent).toBe('~文件~.ogg');
});

it('does not invent an execution permission for old task records, and displays the actual recorded mode', async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const action: CompanionAction = { id: 'task-a', conversationId: 'chat-a', companionId: 'fish-a', sourceMessageId: 'message-a', title: '检查图片', status: 'running', createdAt: '2026-10-13T08:00:00.000Z', updatedAt: '2026-10-13T08:00:00.000Z' };
  await act(() => root!.render(<CompanionActionCard action={action} now={Date.now()} onStop={vi.fn()} />));
  expect(container!.querySelector('.companions-action-access')).toBeNull();
  for (const [accessMode, label] of [['danger-full-access', '完全访问'], ['workspace-write', '工作区可写'], ['read-only', '只读']] as const) {
    await act(() => root!.render(<CompanionActionCard action={{ ...action, accessMode }} now={Date.now()} onStop={vi.fn()} />));
    expect(container!.querySelector('.companions-action-access')!.textContent).toBe(label);
  }
});
