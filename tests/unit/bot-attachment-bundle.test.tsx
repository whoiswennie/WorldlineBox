// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotAttachmentBundle } from '../../src/renderer/companion-bot/BotAttachmentBundle';
import { botAttachmentSummary } from '../../src/renderer/companion-bot/attachment-presentation';
import type { BotMediaRef, BotMediaRequest, BotMediaResponse, WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
const refs: BotMediaRef[] = Array.from({ length: 12 }, (_, index) => {
  const kind = index < 5 ? 'image' : index < 7 ? 'video' : index < 9 ? 'audio' : 'text', extension = { image: 'png', video: 'mp4', audio: 'mp3', text: 'md' }[kind];
  return { id: `file-${index}`, name: `附件${String(index).padStart(2, '0')}.${extension}`, originalName: `实际的完整文件名${String(index).padStart(2, '0')}.${extension}`, mimeType: { image: 'image/png', video: 'application/mp4', audio: 'audio/mpeg', text: 'text/markdown' }[kind]!, size: (index + 1) * 1024, url: `worldlinebox://bot-media/conversation/room/file-${index}`, kind: 'file', ...(kind === 'image' ? { previewUrl: `worldlinebox://bot-media/conversation/room/thumb-${index}` } : {}) };
});
async function mount(media = refs, handler: (request: BotMediaRequest) => Promise<BotMediaResponse> = async () => ({ ok: true })) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const request = vi.fn(handler), api: WorldlineBoxBotMediaApi = { request, getDroppedFilePaths: () => [] };
  await act(() => root!.render(<BotAttachmentBundle media={media} conversationId="room-a" api={api} locale="zh-CN" />)); return { request };
}
async function click(label: string, scope: ParentNode = document) {
  const target = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
  expect(target, label).toBeDefined(); await act(async () => { target!.click(); await Promise.resolve(); });
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索附件文件名"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
it('summarizes real counts and bytes and shows only six safe tiles plus the actual remainder', async () => {
  const f = await mount(); expect(botAttachmentSummary(refs)).toEqual({ count: 12, bytes: 78 * 1024, counts: { image: 5, video: 2, audio: 2, document: 3 } });
  expect(host.querySelector('.bot-attachment-bundle-header')?.textContent).toContain('共 12 个附件'); expect(host.querySelector('.bot-attachment-bundle-header')?.textContent).toContain('78 KB');
  expect(host.querySelectorAll('.bot-attachment-tile')).toHaveLength(6); expect(host.querySelector('.bot-attachment-bundle-more strong')?.textContent).toBe('+6');
  expect(host.querySelector('.bot-attachment-bundle-types')?.textContent).toContain('图片 5'); expect(host.querySelector('.bot-attachment-bundle-types')?.textContent).toContain('音频 2');
  expect(document.querySelector('video,audio,[role=dialog]')).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  for (const image of host.querySelectorAll('img')) expect(image.getAttribute('src')).toContain('/thumb-');
  expect(host.textContent).not.toMatch(/\d{2}:\d{2}|%|波形|预计/);
});
it('plays one or two media attachments inline and keeps their viewer and file actions available', async () => {
  await mount(refs.slice(5, 7)); expect(host.querySelector('.bot-attachment-bundle')).toBeNull(); expect(host.querySelectorAll('.bot-attachment-card')).toHaveLength(2);
  expect(host.querySelectorAll('.bot-file-save')).toHaveLength(2); expect(host.querySelectorAll('.bot-file-open')).toHaveLength(2);
  expect(host.querySelectorAll('video[controls][preload="none"]')).toHaveLength(2);
  expect(host.querySelectorAll('.bot-attachment-enlarge')).toHaveLength(2);
});
it('expands ten actual files per page and searches complete original filenames across the whole bundle', async () => {
  const f = await mount(); await click('查看全部附件'); const list = () => document.querySelector('.bot-attachment-explorer-list')!;
  expect(list().querySelectorAll('[role=listitem]')).toHaveLength(10); expect(list().textContent).toContain(refs[0]!.originalName); expect(list().textContent).not.toContain(refs[11]!.originalName);
  await click('下一页'); expect(list().querySelectorAll('[role=listitem]')).toHaveLength(2); expect(list().textContent).toContain(refs[11]!.originalName);
  await search('完整文件名01'); expect(list().querySelectorAll('[role=listitem]')).toHaveLength(1); expect(list().textContent).toContain(refs[1]!.originalName);
  await search('不存在的文件'); expect(list().querySelectorAll('[role=listitem]')).toHaveLength(0); expect(list().textContent).toContain('没有匹配的附件'); expect(f.request).not.toHaveBeenCalled();
});
it('filters real MIME categories, opens only the chosen stream and closes that preview without closing the list', async () => {
  await mount(); await click('查看全部附件'); await click('视频 2');
  const list = document.querySelector('.bot-attachment-explorer-list')!; expect(list.querySelectorAll('[role=listitem]')).toHaveLength(2); expect(list.querySelector('video')).toBeNull();
  await click('打开预览 ' + refs[5]!.originalName, list); const video = document.querySelector('video')!;
  expect(video.getAttribute('src')).toBe(refs[5]!.url); expect(video.autoplay).toBe(false); expect(video.getAttribute('preload')).toBe('metadata');
  await act(() => video.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(document.querySelector('video')).toBeNull(); expect(document.querySelector('.bot-attachment-explorer')).not.toBeNull();
  await click('关闭附件列表'); expect(document.querySelector('.bot-attachment-explorer')).toBeNull();
});
it('retains exact scope and IDs for save/system open and displays operation failures on the chosen file', async () => {
  const f = await mount(refs, async request => request.type === 'attachment.save' ? { ok: false, error: '保存失败，原文件仍保留' } : { ok: true });
  await click('查看全部附件'); const row = document.querySelector('.bot-attachment-explorer-list [role=listitem]')!;
  await click('保存 ' + refs[0]!.originalName, row); expect(f.request).toHaveBeenLastCalledWith({ type: 'attachment.save', conversationId: 'room-a', id: refs[0]!.id });
  expect(row.querySelector('[role=alert]')?.textContent).toContain('保存失败');
  await click('系统打开 ' + refs[0]!.originalName, row); expect(f.request).toHaveBeenLastCalledWith({ type: 'attachment.open', conversationId: 'room-a', id: refs[0]!.id });
});
it('never loads over-limit media or reads a document while collapsed, and keeps stickers named in the file list', async () => {
  const large: BotMediaRef = { ...refs[0]!, id: 'large', name: '电影.mp4', originalName: '电影.mp4', mimeType: 'video/mp4', size: 200 * 1024 * 1024 + 1, storage: 'external', analysisBlocked: true, previewUrl: 'worldlinebox://must-not-load' };
  const sticker: BotMediaRef = { ...refs[1]!, kind: 'sticker', animated: true };
  const f = await mount([large, sticker, refs[9]!]); expect(host.querySelector('img')?.getAttribute('src')).toBe(sticker.previewUrl); expect(host.querySelector('video,audio')).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  expect([...host.querySelectorAll('img')].map(image => image.getAttribute('src'))).not.toContain(large.previewUrl);
  await click('查看全部附件'); expect(document.querySelector('.bot-attachment-explorer-list')?.textContent).toContain(sticker.originalName);
  await click('系统打开 电影.mp4', document.querySelector('.bot-attachment-explorer-list')!); expect(f.request).toHaveBeenLastCalledWith({ type: 'attachment.open', conversationId: 'room-a', id: large.id });
});
it('bounds large historical attachment arrays independently of the chat message window', async () => {
  await mount(Array.from({ length: 305 }, (_, index) => ({ ...refs[9]!, id: 'old-' + index, name: `旧记录${index}.txt`, originalName: `旧记录${index}.txt` })));
  expect(host.querySelectorAll('.bot-attachment-tile')).toHaveLength(6); expect(host.querySelector('.bot-attachment-bundle-more strong')?.textContent).toBe('+299');
  await click('查看全部附件'); expect(document.querySelectorAll('.bot-attachment-explorer-list [role=listitem]')).toHaveLength(10);
  await search('旧记录304'); expect(document.querySelectorAll('.bot-attachment-explorer-list [role=listitem]')).toHaveLength(1); expect(document.querySelector('.bot-attachment-explorer-list')?.textContent).toContain('旧记录304.txt');
});
it('uses only a small thumbnail for a large standalone sticker until the user explicitly opens its original', async () => {
  const sticker: BotMediaRef = { ...refs[0]!, kind: 'sticker', animated: true, size: 180 * 1024 * 1024 };
  const f = await mount([sticker]); expect(host.querySelector('img')?.getAttribute('src')).toBe(sticker.previewUrl); expect(f.request).not.toHaveBeenCalled();
  await click('预览 ' + sticker.name); expect(document.querySelector('[role=dialog] img')?.getAttribute('src')).toBe(sticker.url);
});
