// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionAttachment } from '../../src/shared/companions';
import { CompanionAttachments, companionAttachmentKind } from '../../src/renderer/companions/CompanionAttachments';
import { CompanionImagePreview } from '../../src/renderer/companions/CompanionImagePreview';
import { CompanionMediaPlayer, stopCompanionMedia } from '../../src/renderer/companions/CompanionMediaPlayer';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => { stopCompanionMedia(); root?.unmount(); }); container?.remove(); vi.restoreAllMocks(); });
const attachment = (id: string, mime: string): CompanionAttachment => ({ id, name: id, mime, size: 4096 });
async function render(element: React.ReactNode) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(() => root!.render(element)); }
async function click(label: string) { const button = container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); expect(button).toBeTruthy(); await act(() => button!.click()); }

it('groups images into a gallery and opens PDF and text through the document preview callback', async () => {
  const images = [attachment('front.png', 'image/png'), attachment('back.webp', 'image/webp')], pdf = attachment('notes.pdf', 'application/pdf'), text = attachment('notes.md', 'text/markdown'), onOpen = vi.fn();
  await render(<CompanionAttachments attachments={[images[0]!, pdf, images[1]!, text]} onOpen={onOpen} />);
  expect(onOpen).not.toHaveBeenCalled(); expect(container!.querySelectorAll('.companions-attachment-images img')).toHaveLength(2);
  await click('预览图片：back.webp'); expect(onOpen).toHaveBeenLastCalledWith(images[1], images);
  await click('预览文件：notes.pdf'); expect(onOpen).toHaveBeenLastCalledWith(pdf);
  expect(container!.textContent).toContain('PDF 文档'); expect(container!.textContent).toContain('文本文件'); expect(container!.querySelector('iframe, object, script')).toBeNull();
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
  expect(container!.querySelector('video')).toBeNull(); expect(container!.textContent).toContain('256 MB');
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
