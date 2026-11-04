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
it('keeps the actual text and default-collapsed attachment summary inside one message bubble without media reads', async () => {
  await render(); const bubble = host.querySelector('.bot-message-bubble')!;
  expect(bubble.querySelector(':scope > .bot-message-text')?.textContent).toBe(message.content);
  const control = bubble.querySelector<HTMLButtonElement>('.bot-message-file-toggle')!; expect(control.getAttribute('aria-expanded')).toBe('false');
  expect(control.textContent).toContain('2 个附件'); expect(control.textContent).toContain('12 KB'); expect(control.textContent).toContain('音频 1'); expect(control.textContent).toContain('文件 1');
  expect(document.getElementById(control.getAttribute('aria-controls')!)?.hidden).toBe(true);
  expect(bubble.querySelector('img,audio,video,.bot-attachment-card,.bot-attachment-bundle')).toBeNull(); expect(request).not.toHaveBeenCalled();
});
it('renders an attachment-only message as a complete accessible bubble, expands existing operations and unmounts them when collapsed', async () => {
  await render({ ...message, content: '', attachments: [textFile] }); expect(host.querySelector('.bot-message-text')).toBeNull();
  expect(host.querySelector('.bot-message-bubble')).not.toBeNull(); await click('展开 1 个附件');
  expect(host.querySelector('.bot-attachment-card strong')?.textContent).toBe(textFile.name); await click('保存 ' + textFile.name);
  expect(request).toHaveBeenLastCalledWith({ type: 'attachment.save', conversationId: 'room-a', id: textFile.id });
  await click('收起 1 个附件'); expect(host.querySelector('.bot-attachment-card')).toBeNull(); expect(host.querySelector('.bot-message-expanded-files')?.hasAttribute('hidden')).toBe(true);
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
it('shows a mixed sticker directly while folding only the real ordinary attachment count', async () => {
  await render({ ...message, attachments: [sticker, textFile] }); expect(host.querySelector('.is-sticker img')?.getAttribute('src')).toBe(sticker.url);
  expect(host.querySelector('.bot-message-file-toggle')?.getAttribute('aria-label')).toBe('展开 1 个附件'); expect(host.querySelector('.bot-attachment-card')).toBeNull();
  await click('展开 1 个附件'); expect(host.querySelectorAll('.is-sticker')).toHaveLength(1); expect(host.querySelector('.bot-attachment-card strong')?.textContent).toBe(textFile.name);
});
it('folds single and multiple photos by default and mounts only safe thumbnails after explicit expansion', async () => {
  await render({ ...message, content: '', attachments: [image] }); expect(host.querySelector('.bot-message-file-toggle')?.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('img')).toBeNull(); await click('展开 1 个附件');
  expect(host.querySelector('img')?.getAttribute('src')).toBe(image.previewUrl); expect(host.querySelector('img')?.getAttribute('src')).not.toBe(image.url);
  await render({ ...message, id: 'photo-batch', content: '', attachments: [image, { ...image, id: 'image-b' }, { ...image, id: 'image-c' }] });
  expect(host.querySelector('.bot-message-file-toggle')?.getAttribute('aria-label')).toBe('展开 3 个附件'); expect(host.querySelector('img,.bot-attachment-bundle')).toBeNull();
  await click('展开 3 个附件'); expect(host.querySelectorAll('.bot-attachment-tile img')).toHaveLength(3);
  await render({ ...message, id: 'large', content: '', attachments: [{ ...image, size: 200 * 1024 * 1024 + 1, storage: 'external', analysisBlocked: true }] });
  expect(host.querySelector('.bot-message-file-toggle')?.getAttribute('aria-expanded')).toBe('false'); expect(host.querySelector('img')).toBeNull(); expect(request).not.toHaveBeenCalled();
});
it('preserves literal user text, actual assistant Markdown, live text and terminal status without inventing a blank reply', async () => {
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
