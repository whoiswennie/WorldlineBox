// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionAttachment } from '../../src/shared/companions';
import { CompanionAttachments, companionAttachmentKind } from '../../src/renderer/companions/CompanionAttachments';
import { CompanionImagePreview } from '../../src/renderer/companions/CompanionImagePreview';
import { CompanionMediaPlayer, stopCompanionMedia } from '../../src/renderer/companions/CompanionMediaPlayer';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => { stopCompanionMedia(); root?.unmount(); }); container?.remove(); Reflect.deleteProperty(window, 'worldlinebox'); vi.restoreAllMocks(); });
const attachment = (id: string, mime: string): CompanionAttachment => ({ id, name: id, mime, size: 4096 });
async function render(element: React.ReactNode) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(() => root!.render(element)); }
async function click(label: string) { const button = container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); expect(button).toBeTruthy(); await act(() => button!.click()); }

it('groups images into a gallery and opens PDF and text through the document preview callback', async () => {
  const images = [attachment('front.png', 'image/png')], pdf = attachment('notes.pdf', 'application/pdf'), text = attachment('notes.md', 'text/markdown'), onOpen = vi.fn();
  await render(<CompanionAttachments attachments={[images[0]!, pdf, text]} onOpen={onOpen} />);
  expect(onOpen).not.toHaveBeenCalled(); expect(container!.querySelectorAll('.companions-attachment-images img')).toHaveLength(1);
  await click('预览图片：front.png'); expect(onOpen).toHaveBeenLastCalledWith(images[0], images);
  await click('预览文件：notes.pdf'); expect(onOpen).toHaveBeenLastCalledWith(pdf);
  expect(container!.textContent).toContain('PDF 文档'); expect(container!.textContent).toContain('文本文件'); expect(container!.querySelector('iframe, object, script')).toBeNull();
});

it('uses static covers for animated resources and decodes only the selected original inside the mixed resource gallery', async () => {
  const gifs = Array.from({ length: 6 }, (_, index) => attachment(`animation-${index}.gif`, 'image/gif'));
  const file = attachment('archive.zip', 'application/zip'), onOpen = vi.fn(), request = vi.fn(async () => ({ ok: true }));
  Object.assign(window, { worldlinebox: { companions: { request } } });
  await render(<CompanionAttachments attachments={[...gifs, file]} ownerId="fish" conversationId="room" onOpen={onOpen} />);
  expect(container!.querySelectorAll('img')).toHaveLength(4);
  expect(container!.querySelectorAll('img[src$="?cover=1"]')).toHaveLength(4);
  expect(container!.querySelector('audio,video')).toBeNull();
  expect(container!.textContent).toContain('7 个分享资源');
  await click('打开 7 个分享资源');
  const dialog = container!.querySelector('[role="dialog"][aria-label="消息资源画廊"]')!;
  expect(dialog.querySelectorAll('.resource-gallery-grid > button')).toHaveLength(7);
  expect(dialog.querySelectorAll('img:not([src$="?cover=1"])')).toHaveLength(1);
  expect(dialog.querySelectorAll('.resource-gallery-grid img[src$="?cover=1"]')).toHaveLength(6);
  expect(dialog.querySelector('.resource-gallery-full-image')?.getAttribute('src')).toBe('worldlinebox-companion://attachment/' + gifs[0]!.id);
  await click('下一个资源');
  expect(dialog.querySelector('.resource-gallery-full-image')?.getAttribute('alt')).toBe(gifs[1]!.name);
  await click('选择资源：archive.zip');
  expect(dialog.querySelector('.resource-gallery-stage img, audio, video, iframe, object')).toBeNull();
  expect(dialog.querySelector('[aria-label="选中资源：archive.zip"]')).not.toBeNull();
  await act(() => [...dialog.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === '文件位置')!.click());
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'attachment.open', id: file.id });
  expect(onOpen).not.toHaveBeenCalled();
  await act(() => root!.render(<CompanionAttachments attachments={gifs} ownerId="other-owner" conversationId="other-room" onOpen={onOpen} />));
  expect(container!.querySelector('[role="dialog"]')).toBeNull();
});

it('loads only the selected document in the resource gallery and closes all previews when its source unmounts', async () => {
  const files = [attachment('cover.png', 'image/png'), attachment('notes.md', 'text/markdown'), attachment('clip.mp4', 'video/mp4'), attachment('bundle.zip', 'application/zip')];
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('# 实际文档\n\n只有选中后才读取。'));
  await render(<CompanionAttachments attachments={files} onOpen={vi.fn()} ownerId="fish" conversationId="room" />);
  expect(fetch).not.toHaveBeenCalled();
  await click('打开 4 个分享资源'); expect(fetch).not.toHaveBeenCalled();
  await click('选择资源：notes.md');
  expect(fetch).toHaveBeenCalledWith('worldlinebox-companion://attachment/notes.md', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(container!.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(container!.querySelector('[aria-label="Markdown 正文"]')?.textContent).toContain('实际文档');
  await act(() => root!.render(<div>此来源已不可展示</div>));
  expect(container!.querySelector('img,audio,video,[role="dialog"]')).toBeNull();
});
it('shows static GIF, WebP and video covers without playing media, and falls back once when a cover cannot decode', async () => {
  const items = [attachment('animation.gif', 'image/gif'), attachment('animation.webp', 'image/webp'), attachment('video.mp4', 'video/mp4'), attachment('still.png', 'image/png')];
  await render(<CompanionAttachments attachments={items} onOpen={vi.fn()} />);
  const covers = container!.querySelectorAll<HTMLImageElement>('.resource-cover-mosaic img');
  expect(covers).toHaveLength(4); expect(container!.querySelector('audio,video')).toBeNull();
  expect([...covers].map(image => image.src)).toEqual(items.map(item => `worldlinebox-companion://attachment/${item.id}?cover=1`));
  await act(() => covers[0]!.dispatchEvent(new Event('error')));
  expect(container!.querySelectorAll('.resource-cover-mosaic img')).toHaveLength(3);
  expect(container!.querySelector('.resource-gallery-file-symbol')?.textContent).toBe('动图');
  await act(() => root!.render(<CompanionAttachments attachments={[{ ...items[0]!, id: 'new-animation' }, ...items.slice(1)]} onOpen={vi.fn()} />));
  expect(container!.querySelectorAll('.resource-cover-mosaic img')).toHaveLength(4);
});
it('gives a selected gallery video a still poster until playback is requested', async () => {
  const items = [attachment('a.gif', 'image/gif'), attachment('b.webp', 'image/webp'), attachment('clip.mp4', 'video/mp4'), attachment('notes.md', 'text/markdown')];
  await render(<CompanionAttachments attachments={items} onOpen={vi.fn()} />); await click('打开 4 个分享资源'); await click('选择资源：clip.mp4');
  expect(container!.querySelector('.resource-gallery-stage .companions-media-poster')?.getAttribute('src')).toBe('worldlinebox-companion://attachment/clip.mp4?cover=1');
  expect(container!.querySelector('video,audio')).toBeNull();
  await act(() => container!.querySelector('.companions-media-poster')!.dispatchEvent(new Event('error')));
  expect(container!.querySelector('[aria-label="播放：clip.mp4"]')).not.toBeNull();
});
it('uses native controlled media without autoplay and offers a file fallback on a real media error', async () => {
  const audio = attachment('recording.wav', 'audio/wav'), video = attachment('clip.webm', 'video/webm'), onOpen = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  await render(<><CompanionMediaPlayer /><CompanionAttachments attachments={[audio, video]} onOpen={onOpen} /></>);
  expect(container!.querySelector('audio, video')).toBeNull();
  await click('播放：recording.wav');
  for (const element of container!.querySelectorAll<HTMLMediaElement>('audio, video')) { expect(element.controls).toBe(true); expect(element.preload).toBe('metadata'); expect(element.autoplay).toBe(false); expect(element.getAttribute('src')).toBe('worldlinebox-companion://attachment/' + encodeURIComponent(element.tagName === 'AUDIO' ? audio.id : video.id)); }
  expect(onOpen).not.toHaveBeenCalled();
  await click('播放：clip.webm');
  await act(() => container!.querySelector('video')!.dispatchEvent(new Event('error')));
  expect(container!.textContent).toContain('此格式无法在内置播放器解码');
  await click('查看文件位置：clip.webm'); expect(onOpen).toHaveBeenCalledWith(video);
});
it('keeps the same playing element and position when a conversation is unmounted and restored', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  const audio = attachment('persistent.wav', 'audio/wav'), onOpen = vi.fn();
  const view = (visible: boolean) => <><CompanionMediaPlayer />{visible && <CompanionAttachments attachments={[audio]} ownerId="alice" conversationId="alice-private" onOpen={onOpen} />}</>;
  await render(view(true)); await click('播放：persistent.wav');
  const player = container!.querySelector('audio')!; player.currentTime = 17;
  await act(() => root!.render(view(false)));
  expect(container!.querySelector('.companions-media-dock audio')).toBe(player); expect(player.currentTime).toBe(17);
  await act(() => root!.render(view(true)));
  expect(container!.querySelector('.companions-media-surface audio')).toBe(player); expect(player.currentTime).toBe(17);
  await act(() => stopCompanionMedia({ ownerId: 'bob', conversationIds: new Set() })); expect(container!.querySelector('audio')).toBe(player);
});
it('offers system opening for oversized media without allocating a playback element', async () => {
  const launch = vi.fn(async () => ({ ok: true }));
  Object.assign(window, { worldlinebox: { companions: { request: launch } } });
  const video = { ...attachment('movie.mp4', 'video/mp4'), size: 4 * 1024 ** 3 };
  await render(<CompanionAttachments attachments={[video]} onOpen={vi.fn()} />);
  expect(container!.querySelector('video')).toBeNull(); expect(container!.textContent).toContain('2 GiB');
  await click('使用系统应用打开：movie.mp4'); expect(launch).toHaveBeenCalledWith({ type: 'attachment.launch', id: video.id });
});
it('navigates the selected full image and reveals that image instead of the original selection', async () => {
  const images = [attachment('front.png', 'image/png'), attachment('back.png', 'image/png')], onReveal = vi.fn(), onClose = vi.fn();
  await render(<CompanionImagePreview attachment={images[1]!} images={images} onReveal={onReveal} onClose={onClose} />);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭图片预览');
  expect(container!.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('图片预览：back.png'); expect(container!.textContent).toContain('2 / 2');
  expect(container!.querySelector<HTMLButtonElement>('[aria-label="下一张图片"]')!.disabled).toBe(true);
  await act(() => container!.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  expect(container!.querySelector('img')!.getAttribute('alt')).toBe('front.png');
  await act(() => container!.querySelector<HTMLButtonElement>('.companions-image-reveal')!.click()); expect(onReveal).toHaveBeenCalledWith(images[0]);
  await act(() => container!.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(onClose).toHaveBeenCalledOnce();
});
it('keeps unsupported files as files and never guesses an executable preview', () => {
  expect(companionAttachmentKind(attachment('program.exe', 'application/octet-stream'))).toBe('file');
  expect(companionAttachmentKind(attachment('data.json', 'application/json'))).toBe('text');
});
