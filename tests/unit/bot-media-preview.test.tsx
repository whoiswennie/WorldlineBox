// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotMediaPreview } from '../../src/renderer/companion-bot/BotMediaPreview';
import { BotAttachment } from '../../src/renderer/companion-bot/BotAttachment';
import type { BotMediaRef, BotMediaRequest, BotMediaResponse, BotMediaTextPage, WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; document.querySelectorAll('[data-preview-test-focus]').forEach(node => node.remove()); });
const media: BotMediaRef = { id: 'diary-attachment', name: '伙伴日记.md', mimeType: 'text/markdown', size: 1_500_000, url: 'worldlinebox://bot-media/conversation/allowed/original', kind: 'file', storage: 'managed' };
const page = (content: string, offset = 0, nextOffset?: number): BotMediaTextPage => ({ content, offset, ...(nextOffset === undefined ? {} : { nextOffset }), name: media.name, format: 'markdown', encoding: 'utf-8', totalBytes: media.size });
function boundary(handler: (request: BotMediaRequest) => Promise<BotMediaResponse>) {
  const request = vi.fn(handler), api: WorldlineBoxBotMediaApi = { request, getDroppedFilePaths: () => [] }; return { api, request };
}
async function render(element: React.ReactNode) {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => { root!.render(element); await Promise.resolve(); });
}
async function mount(props: Partial<ComponentProps<typeof BotMediaPreview>> = {}) {
  const onClose = vi.fn(); await render(<BotMediaPreview media={media} conversationId="room-a" locale="zh-CN" kind="text" onClose={onClose} {...props} />); return { onClose };
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  expect(button, label).toBeDefined(); await act(async () => { button!.click(); await Promise.resolve(); }); return button!;
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }

it('requests only the current bounded byte page and replaces it on navigation instead of accumulating the document', async () => {
  const f = boundary(async request => request.type === 'media.text.read' ? { ok: true, textPage: request.offset === 70000 ? page('# 第二段\n文末校验：完整尾部', 70000) : page('# 第一段\n只有这一段在 DOM 中', 0, 70000) } : { ok: true });
  await mount({ api: f.api });
  expect(f.request.mock.calls.map(([request]) => request)).toEqual([{ type: 'media.text.read', conversationId: 'room-a', id: media.id, offset: 0, limit: 65536 }]);
  expect(document.querySelector('[role=dialog] h1')?.textContent).toBe('第一段');
  await click('下一段'); expect(f.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 70000, limit: 65536 });
  expect(document.querySelector('[role=dialog] h1')?.textContent).toBe('第二段'); expect(document.querySelector('[role=dialog]')?.textContent).not.toContain('只有这一段在 DOM 中');
  expect([...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(button => button.textContent === '下一段')?.disabled).toBe(true);
  await click('上一段'); expect(f.request).toHaveBeenCalledTimes(3); expect(f.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 0 });
});
it('uses the actual Markdown renderer, blocks embedded HTML and avoids automatic remote image or unsafe-link loads', async () => {
  const source = '# 可阅读标题\n\n**粗体**\n\n<script>danger()</script>\n\n![远程图片](https://example.com/picture.png)\n\n[参考链接](https://example.com/reference)\n\n[不安全链接](javascript:alert%281%29)';
  const f = boundary(async () => ({ ok: true, textPage: page(source) })), open = vi.fn(); await mount({ api: f.api, onOpenUrl: open });
  expect(document.querySelector('[role=dialog] h1')?.textContent).toBe('可阅读标题'); expect(document.querySelector('[role=dialog] strong')?.textContent).toBe('粗体');
  expect(document.querySelector('[role=dialog] script,[role=dialog] iframe,[role=dialog] img')).toBeNull(); expect(open).not.toHaveBeenCalled();
  await click('参考链接'); expect(open).toHaveBeenLastCalledWith('https://example.com/reference');
  await click('远程图片'); expect(open).toHaveBeenLastCalledWith('https://example.com/picture.png');
  expect([...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent === '不安全链接')).toBe(false);
  await click('原文'); expect(document.querySelector('[role=dialog] pre')?.textContent).toBe(source); expect(f.request).toHaveBeenCalledTimes(1);
  await click('阅读'); expect(document.querySelector('[role=dialog] h1')?.textContent).toBe('可阅读标题');
});
it('retains literal TXT and an empty file without interpreting markup', async () => {
  let empty = false; const f = boundary(async () => ({ ok: true, textPage: { ...page(empty ? '' : '<button>literal</button>\n# plain'), format: 'text' } }));
  await mount({ api: f.api, media: { ...media, name: '文字.txt', mimeType: 'text/plain' } });
  expect(document.querySelector('[role=dialog] pre')?.textContent).toBe('<button>literal</button>\n# plain'); expect(document.querySelector('.bot-attachment-document button')).toBeNull();
  await act(() => root!.unmount()); root = undefined; host!.remove(); empty = true; await mount({ api: f.api });
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('这是一份空文件'); expect(document.querySelector('[role=dialog] pre')).toBeNull();
});
it('shows a read failure, retries the same authorized page, and rejects a response for another offset', async () => {
  let calls = 0; const f = boundary(async () => ++calls === 1 ? { ok: false, error: '附件校验失败' } : calls === 2 ? { ok: true, textPage: page('错误游标不可展示', 99) } : { ok: true, textPage: page('重新读取成功') });
  await mount({ api: f.api }); expect(document.querySelector('[role=dialog]')?.textContent).toContain('附件校验失败');
  await click('重新读取'); expect(document.querySelector('[role=dialog]')?.textContent).not.toContain('错误游标不可展示'); expect(document.querySelector('[role=dialog]')?.textContent).toContain('暂时无法读取');
  await click('重新读取'); expect(document.querySelector('[role=dialog]')?.textContent).toContain('重新读取成功');
  for (const [request] of f.request.mock.calls) expect(request).toMatchObject({ conversationId: 'room-a', id: media.id, offset: 0 });
});
it('ignores a stale async response when the visible attachment or chat has changed', async () => {
  const pending = deferred<BotMediaResponse>(), f = boundary(async request => request.conversationId === 'room-a' ? pending.promise : { ok: true, textPage: { ...page('乙会话的真实内容'), name: 'other.md' } });
  await mount({ api: f.api }); expect(document.querySelector('.bot-attachment-viewer-content')?.getAttribute('aria-busy')).toBe('true');
  await mount({ api: f.api, conversationId: 'room-b', media: { ...media, id: 'other', name: 'other.md' } });
  await act(() => pending.resolve({ ok: true, textPage: page('甲会话迟到的内容') }));
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('乙会话的真实内容'); expect(document.querySelector('[role=dialog]')?.textContent).not.toContain('甲会话迟到的内容');
});
it('provides a focused keyboard dialog with Escape and restores focus after closing', async () => {
  const previous = document.createElement('button'); previous.dataset.previewTestFocus = ''; document.body.append(previous); previous.focus();
  const f = await mount({ kind: 'image', imageUrl: media.url }); const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!;
  expect(document.activeElement).toBe(close); expect(document.querySelector('[role=dialog]')?.getAttribute('aria-modal')).toBe('true');
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); await act(() => close.dispatchEvent(tab)); expect(tab.defaultPrevented).toBe(true); expect(document.activeElement).toBe(close);
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); await act(() => close.dispatchEvent(escape)); expect(f.onClose).toHaveBeenCalledOnce(); expect(escape.defaultPrevented).toBe(true);
  await act(() => root!.unmount()); root = undefined; expect(document.activeElement).toBe(previous);
});
it('loads a player only after explicit opening and gives decoding failures a system-app fallback', async () => {
  const av: BotMediaRef = { ...media, id: 'movie', name: '电影片段.mp4', mimeType: 'video/mp4', size: 200 * 1024 * 1024 }, f = boundary(async () => ({ ok: true }));
  await render(<BotAttachment media={av} api={f.api} conversationId="room-a" locale="zh-CN" />);
  expect(document.querySelector('video,audio,[role=dialog]')).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  await act(() => host!.querySelector<HTMLButtonElement>('.bot-attachment-main')!.click());
  const video = document.querySelector('video')!; expect(video.getAttribute('src')).toBe(av.url); expect(video.hasAttribute('controls')).toBe(true); expect(video.autoplay).toBe(false); expect(video.preload).toBe('metadata');
  await act(() => video.dispatchEvent(new Event('error'))); expect(document.querySelector('[role=dialog]')?.textContent).toContain('可以用系统应用打开原文件');
  expect(document.querySelector('video')).toBeNull(); await click('系统打开'); expect(f.request).toHaveBeenCalledWith({ type: 'attachment.open', conversationId: 'room-a', id: 'movie' });
});
it('never creates an in-app dialog or assigns a media source for Office and over-limit attachments', async () => {
  const f = boundary(async () => ({ ok: true }));
  for (const item of [{ ...media, name: '资料.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { ...media, name: '大图.png', mimeType: 'image/png', size: 200 * 1024 * 1024 + 1, storage: 'external' as const }]) {
    await render(<BotAttachment media={item} api={f.api} conversationId="room-a" locale="zh-CN" />);
    expect(document.querySelector('img,video,audio,[role=dialog]')).toBeNull(); await act(() => host!.querySelector<HTMLButtonElement>('.bot-attachment-main')!.click());
    expect(document.querySelector('[role=dialog]')).toBeNull(); expect(f.request.mock.calls.at(-1)?.[0]).toEqual({ type: 'attachment.open', conversationId: 'room-a', id: item.id });
  }
});
it('opens the original image after a click rather than enlarging its tiny thumbnail or flattening an animation', async () => {
  const picture = { ...media, name: '原图.png', mimeType: 'image/png', size: 2048, previewUrl: 'worldlinebox://bot-media/conversation/allowed/preview' }, f = boundary(async () => ({ ok: true }));
  await render(<BotAttachment media={picture} api={f.api} conversationId="room-a" locale="zh-CN" />);
  expect(host!.querySelector('img')?.getAttribute('src')).toBe(picture.previewUrl); await act(() => host!.querySelector<HTMLButtonElement>('.bot-attachment-main')!.click());
  expect(document.querySelector('[role=dialog] img')?.getAttribute('src')).toBe(picture.url);
});
