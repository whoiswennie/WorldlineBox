// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RecordingResult } from '../../src/renderer/capture-tools/RecordingResult';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { CaptureRecordingPreview, CaptureToolsRequest, CaptureToolsResponse, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); vi.restoreAllMocks(); });

const savedPath = 'C:\\Downloads\\WorldlineBox\\WorldlineBox-Recording-20261019-030035-result.mp4';
const recordingId = 'saved-recording';
const preview: CaptureRecordingPreview = { url: 'worldlinebox-capture://recording/opaque-result-token', mimeType: 'video/mp4', name: 'WorldlineBox-Recording-20261019-030035-result.mp4', bytes: 2468276 };
function bridge(handler: (input: CaptureToolsRequest) => Promise<CaptureToolsResponse> = async input => input.type === 'recording.preview' ? { ok: true, preview } : { ok: true }) {
  const request = vi.fn(handler);
  const api: WorldlineBoxCaptureToolsApi = { request, onChanged: () => () => undefined, onStopRecording: () => () => undefined };
  return { api, request };
}
async function mount(api: WorldlineBoxCaptureToolsApi, props: Partial<ComponentProps<typeof RecordingResult>> = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const onAgain = vi.fn(), onClose = vi.fn();
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><RecordingResult api={api} id={recordingId} path={savedPath} elapsed={4900} status="saved" error="" notice="" onAgain={onAgain} onClose={onClose} {...props} /></LocaleProvider>));
  return { onAgain, onClose };
}
function button(label: string) {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.getAttribute('aria-label') === label || element.textContent === label);
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}

it('reviews the saved MP4 stream with playback controls instead of source thumbnails or capture settings', async () => {
  const { api, request } = bridge();
  await mount(api);
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'recording.preview', id: recordingId });
  const player = host.querySelector<HTMLVideoElement>('video')!;
  expect(player).not.toBeNull();
  expect(player.getAttribute('src')).toBe(preview.url);
  expect(player.controls).toBe(true);
  expect(player.autoplay).toBe(false);
  expect(player.muted).toBe(false);
  expect(player.preload).not.toBe('none');
  expect(host.querySelector('img, select, input, .capture-region-picker')).toBeNull();
  expect(host.querySelector('h1')?.textContent).toBe(preview.name);
  expect(host.querySelector('.capture-result-metadata')?.textContent).toContain('MP4');
  expect(host.querySelector('.capture-result-metadata')?.textContent).toContain('2.4 MB');
  await act(() => button('按原始尺寸查看').click());
  expect(host.querySelector('.capture-result-stage')?.classList.contains('is-original-size')).toBe(true);
  await act(() => button('适应窗口').click());
  expect(host.querySelector('.capture-result-stage')?.classList.contains('is-original-size')).toBe(false);
});

it('uses decoded video dimensions and duration, including a late finite duration, for file information', async () => {
  const { api } = bridge();
  await mount(api, { elapsed: 999_000 });
  const player = host.querySelector<HTMLVideoElement>('video')!;
  Object.defineProperties(player, { videoWidth: { value: 2372 }, videoHeight: { value: 1334 }, duration: { value: 4.938, configurable: true } });
  await act(() => player.dispatchEvent(new Event('loadedmetadata')));
  expect(host.querySelector('.capture-result-metadata')?.textContent).toContain('2372 × 1334');
  expect(host.querySelector('time')?.textContent).toBe('00:00:04');
  Object.defineProperty(player, 'duration', { value: Infinity, configurable: true });
  await act(() => player.dispatchEvent(new Event('durationchange')));
  expect(host.querySelector('time')?.textContent).toBe('00:00:04');
  Object.defineProperty(player, 'duration', { value: 61.25, configurable: true });
  await act(() => player.dispatchEvent(new Event('durationchange')));
  expect(host.querySelector('time')?.textContent).toBe('00:01:01');
});

it('shows the actual animated GIF file and its decoded dimensions without video or audio controls', async () => {
  const gif: CaptureRecordingPreview = { ...preview, mimeType: 'image/gif', name: 'recording.gif', bytes: 500 * 1024 };
  const { api } = bridge(async () => ({ ok: true, preview: gif }));
  await mount(api, { path: 'C:\\Downloads\\recording.gif' });
  const image = host.querySelector<HTMLImageElement>('img')!;
  expect(image.getAttribute('src')).toBe(gif.url);
  expect(host.querySelector('video, select, input')).toBeNull();
  Object.defineProperties(image, { naturalWidth: { value: 960 }, naturalHeight: { value: 540 } });
  await act(() => image.dispatchEvent(new Event('load')));
  expect(host.querySelector('.capture-result-metadata')?.textContent).toContain('GIF');
  expect(host.querySelector('.capture-result-metadata')?.textContent).toContain('960 × 540');
  expect(host.querySelector('.capture-result-metadata')?.textContent).toContain('500.0 KB');
});

it('offers a scoped system-player fallback after preview acquisition fails and allows retrying that action', async () => {
  let opens = 0;
  const { api, request } = bridge(async input => {
    if (input.type === 'recording.preview') throw Error('transport unavailable');
    if (input.type === 'recording.open' && ++opens === 1) return { ok: false, error: '系统播放器暂时不可用' };
    return { ok: true };
  });
  await mount(api);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法在此播放');
  expect(host.querySelector('video, img')).toBeNull();
  await act(() => button('使用系统播放器打开').click());
  expect(host.querySelector('.capture-result-placeholder [role="alert"]')?.textContent).toContain('无法在此播放');
  expect(host.querySelector('.capture-result-notice[role="alert"]')?.textContent).toBe('系统播放器暂时不可用');
  await act(() => button('使用系统播放器打开').click());
  expect(opens).toBe(2);
  expect(host.querySelector('.capture-result-placeholder [role="alert"]')?.textContent).toContain('无法在此播放');
  expect(host.querySelector('.capture-result-notice[role="alert"]')).toBeNull();
  expect(request.mock.calls.slice(1).map(([input]) => input)).toEqual([
    { type: 'recording.open', id: recordingId }, { type: 'recording.open', id: recordingId },
  ]);
});

it.each([
  ['使用系统播放器打开', 'recording.open', '系统播放器暂时不可用'],
  ['查看文件', 'reveal', '无法打开文件所在目录'],
] as const)('preserves inline playback and its position when %s fails', async (label, action, failure) => {
  const { api, request } = bridge(async input => {
    if (input.type === 'recording.preview') return { ok: true, preview };
    if (input.type === action) return { ok: false, error: failure };
    return { ok: true };
  });
  await mount(api);
  const player = host.querySelector<HTMLVideoElement>('video')!;
  player.currentTime = 2.75;
  await act(() => button(label).click());
  expect(host.querySelector('video')).toBe(player);
  expect(player.currentTime).toBe(2.75);
  expect(player.getAttribute('src')).toBe(preview.url);
  expect(host.querySelector('.capture-result-placeholder')).toBeNull();
  expect(host.querySelector('.capture-result-notice[role="alert"]')?.textContent).toBe(failure);
  expect(request).toHaveBeenLastCalledWith(action === 'recording.open'
    ? { type: 'recording.open', id: recordingId } : { type: 'reveal', path: savedPath });
});

it('handles unsupported decoding without silently substituting the old screenshot', async () => {
  const { api, request } = bridge();
  await mount(api);
  const player = host.querySelector<HTMLVideoElement>('video')!;
  await act(() => player.dispatchEvent(new Event('error')));
  expect(host.querySelector('video, img')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法在此播放');
  await act(() => button('使用系统播放器打开').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'recording.open', id: recordingId });
});

it('keeps reveal, re-record, and close available while a recoverable source fails to preview', async () => {
  const { api, request } = bridge(async input => input.type === 'recording.preview' ? { ok: false, error: '恢复文件暂不能预览' } : { ok: true });
  const recovery = 'C:\\Downloads\\.WorldlineBox-Recording-recover.webm.part';
  const { onAgain, onClose } = await mount(api, { path: recovery, status: 'failed', error: '转换失败', notice: '原始 WebM 录制文件已保留' });
  expect(host.textContent).toContain('转换失败'); expect(host.textContent).toContain('原始 WebM 录制文件已保留');
  await act(() => button('查看文件').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'reveal', path: recovery });
  await act(() => button('再次录制').click());
  await act(() => button('关闭').click());
  expect(onAgain).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
});

it('does not request or offer file playback for a cancelled recording without an output file', async () => {
  const { api, request } = bridge();
  await mount(api, { path: '', status: 'cancelled' });
  expect(request).not.toHaveBeenCalled();
  expect(host.textContent).toContain('录制已取消');
  expect(host.querySelector('video, img, time')).toBeNull();
  expect(host.querySelector('button[aria-label="使用系统播放器打开"], button[aria-label="查看文件"]')).toBeNull();
});

it('ignores a late preview completion after the result has been closed', async () => {
  let complete!: (response: CaptureToolsResponse) => void;
  const { api, request } = bridge(() => new Promise(resolve => { complete = resolve; }));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await mount(api);
  expect(host.textContent).toContain('正在打开录制');
  await act(() => root!.unmount()); root = undefined;
  await act(async () => { complete({ ok: true, preview }); });
  expect(host.childElementCount).toBe(0);
  expect(request).toHaveBeenCalledOnce();
  expect(errors).not.toHaveBeenCalled();
});
