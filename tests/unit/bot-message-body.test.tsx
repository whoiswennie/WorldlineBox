// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotMessageBody } from '../../src/renderer/companion-bot/BotMessageBody';
import type { BotMessage } from '../../src/shared/companion-bot';
import type { BotMediaRef, BotMediaRequest, BotMediaResponse } from '../../src/shared/companion-bot-media';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
const textFile: BotMediaRef = { id: 'file-a', name: '项目说明.md', size: 4096, kind: 'file', mimeType: 'text/markdown', url: 'worldlinebox://bot-media/conversation/room-a/document' };
const audio: BotMediaRef = { ...textFile, id: 'audio-a', name: '配乐.mp3', size: 8192, mimeType: 'audio/mpeg', url: 'worldlinebox://bot-media/conversation/room-a/audio' };
const sticker: BotMediaRef = { ...textFile, id: 'sticker-a', name: '辉夜 开心', kind: 'sticker', mimeType: 'image/webp', size: 1024, animated: true, url: 'worldlinebox://bot-media/public/original-sticker', previewUrl: 'worldlinebox://bot-media/public/sticker-thumb' };
const image: BotMediaRef = { ...textFile, id: 'image-a', name: '图片.png', kind: 'file', mimeType: 'image/png', previewUrl: 'worldlinebox://bot-media/conversation/room-a/image-thumb', url: 'worldlinebox://bot-media/conversation/room-a/image-original' };
const message: BotMessage = { id: 'message-a', conversationId: 'room-a', senderId: 'fish', senderName: '大肥鱼', content: '一起看看这些资料。', createdAt: '2026-11-04T10:00:00Z', sequence: 1, eventId: 'event-a', status: 'sent', attachments: [textFile, audio] };
const request = vi.fn<(input: BotMediaRequest) => Promise<BotMediaResponse>>(async () => ({ ok: true }));
async function render(item = message, streamedText?: string, statusText = '') {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); request.mockClear(); }
  await act(() => root!.render(<BotMessageBody message={item} streamedText={streamedText} statusText={statusText} locale="zh-CN" mediaApi={{ request, getDroppedFilePaths: () => [] }} />));
}
async function click(label: string) {
  const target = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
  expect(target, label).toBeDefined(); await act(async () => { target!.click(); await Promise.resolve(); });
}
it('shows only the final body, sticker group and attachments after native completion',async()=>{
  await render({...message,attachments:[sticker,textFile],content:'全部答复',execution:{status:'succeeded',steps:[]},parts:[
    {id:'last',kind:'text',sequence:40,text:'交付完毕'},
    {id:'first',kind:'text',sequence:10,text:'最早的关键结论'},
    {id:'media',kind:'media',sequence:20,text:'给你一个表情',attachments:[sticker]},
    {id:'files',kind:'media',sequence:30,attachments:[textFile]},
  ]});
  expect(host.querySelectorAll('.bot-message-bubble')).toHaveLength(1);
  expect(host.querySelectorAll('.bot-message-text')).toHaveLength(1);expect(host.querySelector('.bot-message-text')?.textContent).toBe('交付完毕');
  expect(host.textContent).not.toContain('最早的关键结论');expect(host.textContent).not.toContain('给你一个表情');expect(host.querySelector('.is-sticker img')).not.toBeNull();expect(host.textContent).toContain(textFile.name);
  expect(host.querySelector('.bot-execution,.bot-message-progress')).toBeNull();
});
it('streams only the current body without repeating earlier committed bodies or sticker captions',async()=>{
  await render({...message,status:'running',attachments:[sticker],parts:[{id:'sticker',kind:'media',sequence:10,text:'收到',attachments:[sticker]},{id:'echo',kind:'text',sequence:20,text:'收到'}]},'正在输出正文');
  expect(host.querySelectorAll('.bot-message-text')).toHaveLength(1);expect(host.querySelector('.bot-message-text')?.textContent).toBe('正在输出正文');expect(host.textContent).not.toContain('收到');expect(host.querySelectorAll('img')).toHaveLength(1);
});
it('groups multiple native stickers and files without repeating captions or merging an earlier answer into the final body',async()=>{
  await render({...message,content:'不应回显的汇总',attachments:[sticker,textFile],parts:[{id:'early',kind:'text',sequence:1,text:'中途答复'},{id:'s1',kind:'media',sequence:2,text:'表情台词一',attachments:[sticker]},{id:'s2',kind:'media',sequence:3,text:'表情台词二',attachments:[sticker]},{id:'f',kind:'media',sequence:4,attachments:[textFile]},{id:'final',kind:'text',sequence:5,text:'最终正文'}]});
  expect(host.querySelectorAll('.bot-message-inline-stickers')).toHaveLength(1);expect(host.querySelectorAll('.is-sticker img')).toHaveLength(2);expect(host.querySelectorAll('.bot-attachment-card')).toHaveLength(1);expect(host.querySelector('.bot-message-text')?.textContent).toBe('最终正文');expect(host.textContent).not.toContain('表情台词');expect(host.textContent).not.toContain('中途答复');
});
it('renders an intentional sticker-only duel without an empty answer or an execution toolbar',async()=>{
  await render({...message,content:'',attachments:[sticker],execution:{status:'succeeded',steps:[]},parts:[{id:'only-sticker',kind:'media',sequence:10,attachments:[sticker]}]});
  expect(host.querySelector('.bot-message-text,.bot-execution-toggle')).toBeNull();expect(host.querySelectorAll('.is-sticker img')).toHaveLength(1);expect(host.querySelector('.bot-message-bubble.is-inline-media-only')).not.toBeNull();
});
it('keeps the actual text and default-collapsed attachment summary inside one message bubble without media reads', async () => {
  await render(); const bubble = host.querySelector('.bot-message-bubble')!;
  expect(bubble.querySelector(':scope > .bot-message-text')?.textContent).toBe(message.content);
  const control = bubble.querySelector<HTMLButtonElement>('.bot-message-file-toggle')!; expect(control.getAttribute('aria-expanded')).toBe('false');
  expect(control.textContent).toContain('2 个附件'); expect(control.textContent).toContain('12 KB'); expect(control.textContent).toContain('音频 1'); expect(control.textContent).toContain('文件 1');
  expect(document.getElementById(control.getAttribute('aria-controls')!)?.hidden).toBe(true);
  expect(bubble.querySelector('img,audio,video,.bot-attachment-card,.bot-attachment-bundle')).toBeNull(); expect(request).not.toHaveBeenCalled();
});
it('renders one attachment as a directly actionable card without an extra expansion step or automatic file reads', async () => {
  await render({ ...message, content: '', attachments: [textFile] }); expect(host.querySelector('.bot-message-text')).toBeNull();
  expect(host.querySelector('.bot-message-bubble')).not.toBeNull(); expect(host.querySelector('.bot-message-file-toggle')).toBeNull(); expect(request).not.toHaveBeenCalled();
  expect(host.querySelector('.bot-attachment-card strong')?.textContent).toBe(textFile.name); await click('保存 ' + textFile.name);
  expect(request).toHaveBeenLastCalledWith({ type: 'attachment.save', conversationId: 'room-a', id: textFile.id });
});
it('reuses the real bundle explorer and its bounded file list only after explicit expansion', async () => {
  const files = Array.from({ length: 12 }, (_, index) => ({ ...textFile, id: 'bundle-' + index, name: `资料${index}.md` }));
  await render({ ...message, attachments: files }); expect(host.querySelector('.bot-attachment-bundle')).toBeNull();
  await click('展开 12 个附件'); expect(host.querySelectorAll('.bot-attachment-tile')).toHaveLength(6); expect(host.querySelector('.bot-attachment-bundle-more strong')?.textContent).toBe('+6');
  await click('查看全部附件'); expect(document.querySelectorAll('.bot-attachment-explorer-list [role=listitem]')).toHaveLength(10);
  expect(request).not.toHaveBeenCalled();
});
it('keeps sticker battles directly visible instead of collapsing stickers into a file bundle', async () => {
  const stickers = Array.from({ length: 3 }, (_, index) => ({ ...sticker, id: 'sticker-' + index }));
  await render({ ...message, content: '', attachments: stickers });
  expect(host.querySelector('.bot-message-file-toggle,.bot-attachment-bundle,.bot-message-text')).toBeNull(); expect(host.querySelectorAll('.is-sticker img')).toHaveLength(3);
  for (const picture of host.querySelectorAll('img')) expect(picture.getAttribute('src')).toBe(sticker.url);
  expect(request).not.toHaveBeenCalled();
});
it('shows a mixed sticker and its single file card directly', async () => {
  await render({ ...message, attachments: [sticker, textFile] }); expect(host.querySelector('.is-sticker img')?.getAttribute('src')).toBe(sticker.url);
  expect(host.querySelector('.bot-message-file-toggle')).toBeNull(); expect(host.querySelectorAll('.is-sticker')).toHaveLength(1); expect(host.querySelector('.bot-attachment-card strong')?.textContent).toBe(textFile.name);
});
it('uses only a safe thumbnail for a single photo and keeps photo collections and originals on demand', async () => {
  await render({ ...message, content: '', attachments: [image] }); expect(host.querySelector('.bot-message-file-toggle')).toBeNull();
  expect(host.querySelector('img')?.getAttribute('src')).toBe(image.previewUrl); expect(host.querySelector('img')?.getAttribute('src')).not.toBe(image.url);
  await render({ ...message, id: 'photo-batch', content: '', attachments: [image, { ...image, id: 'image-b' }, { ...image, id: 'image-c' }] });
  expect(host.querySelector('.bot-message-file-toggle')?.getAttribute('aria-label')).toBe('展开 3 个附件'); expect(host.querySelector('img,.bot-attachment-bundle')).toBeNull();
  await click('展开 3 个附件'); expect(host.querySelectorAll('.bot-attachment-tile img')).toHaveLength(3);
  await render({ ...message, id: 'large', content: '', attachments: [{ ...image, size: 200 * 1024 * 1024 + 1, storage: 'external', analysisBlocked: true }] });
  expect(host.querySelector('.bot-message-file-toggle')).toBeNull(); expect(host.querySelector('img')).toBeNull(); expect(request).not.toHaveBeenCalled();
});
it('preserves user text, assistant Markdown and current streamed body without inventing a blank reply', async () => {
  await render({ ...message, senderId: 'user', content: '**原样用户文字**', attachments: [] }); expect(host.querySelector('.bot-message-text')?.textContent).toBe('**原样用户文字**'); expect(host.querySelector('.bot-message-text strong')).toBeNull();
  await render({ ...message, content: '**伙伴正文**', attachments: [] }); expect(host.querySelector('.bot-message-text strong')?.textContent).toBe('伙伴正文');
  await render({ ...message, content: '', status: 'running' }, '**实际流式文字**'); expect(host.querySelector('.bot-message-text strong')?.textContent).toBe('实际流式文字');
  await render({ ...message, content: '', status: 'failed', attachments: [] }, undefined, '回复失败'); expect(host.querySelector('.bot-message-text')?.textContent).toBe('回复失败');
  await render({ ...message, content: '', attachments: [] }); expect(host.querySelector('.bot-message-bubble')).toBeNull();
});
it('does not carry an expanded attachment draft into another message or another conversation', async () => {
  await render(); await click('展开 2 个附件'); expect(host.querySelectorAll('.bot-attachment-card')).toHaveLength(2);
  await render({ ...message, id: 'message-b', conversationId: 'room-b' }); expect(host.querySelector('.bot-message-file-toggle')?.getAttribute('aria-expanded')).toBe('false'); expect(host.querySelector('.bot-attachment-card')).toBeNull();
});
it('turns raw web addresses into compact, honest site cards while keeping titled links inline and unsafe schemes inert', async () => {
  const open = vi.fn(), address = 'https://www.bilibili.com/video/BV1YgHq62EN6?x=1';
  await render({ ...message, attachments: [], content: `${address}\n\n[视频页面](${address}) · [危险链接](javascript:alert)` });
  await act(() => root!.render(<BotMessageBody message={{ ...message, attachments: [], content: `${address}\n\n[视频页面](${address}) · [危险链接](javascript:alert)` }} statusText="" locale="zh-CN" onOpenUrl={open} />));
  const card = host.querySelector<HTMLButtonElement>('.browser-markdown-link-card')!;
  expect(card.querySelector('strong')?.textContent).toBe('视频链接'); expect(card.querySelector('small')?.textContent).toBe('/video/BV1YgHq62EN6?x=1'); expect(card.textContent).toContain('bilibili.com'); expect(card.textContent).toContain('内置浏览器打开');
  expect(host.querySelectorAll('.browser-markdown-link-card')).toHaveLength(1); expect(host.querySelectorAll('.browser-markdown-link')).toHaveLength(2);
  expect(open).not.toHaveBeenCalled(); await act(() => card.click()); expect(open).toHaveBeenCalledWith(address);
});
