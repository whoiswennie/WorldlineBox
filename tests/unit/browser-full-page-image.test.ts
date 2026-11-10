import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { WebContents } from 'electron';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { fullPageImage } from '../../src/main/browser/full-page-image';
import { BrowserPageImageJob } from '../../src/main/browser/page-image-job';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) { if (!path.basename(directory).startsWith('wlb-image-unit-') || path.dirname(directory) !== tmpdir()) throw Error('Unexpected test cleanup'); await rm(directory, { recursive: true, force: true }); } });
async function directory() { const result = await mkdtemp(path.join(tmpdir(), 'wlb-image-unit-')); directories.push(result); return result; }
function fixture(width = 2600, height = 2500, noise = false) {
  let attached = false;
  const sendCommand = vi.fn(async (method: string, args?: { clip: { width: number; height: number; y: number } }) => method === 'Page.getLayoutMetrics'
    ? { cssContentSize: { x: 0, y: 0, width, height } }
    : { data: (await (noise && args!.clip.y < 2048 ? sharp(randomBytes(Math.ceil(args!.clip.width) * Math.ceil(args!.clip.height) * 3), { raw: { width: Math.ceil(args!.clip.width), height: Math.ceil(args!.clip.height), channels: 3 } }) : sharp({ create: { width: Math.ceil(args!.clip.width), height: Math.ceil(args!.clip.height), channels: 3, background: args!.clip.y >= 2048 ? '#18a05c' : '#345678' } })).png().toBuffer()).toString('base64') });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ pixelRatio: 1 })), debugger: {
    isAttached: () => attached, attach: vi.fn(() => { attached = true; }), detach: vi.fn(() => { attached = false; }), sendCommand,
  } });
  return { contents: contents as unknown as WebContents, sendCommand };
}
it('streams horizontal and vertical tiles into one valid complete PNG with bounded preview bands', async () => {
  const f = fixture(2600, 2500, true), root = await directory(), progress = vi.fn();
  const result = await fullPageImage(f.contents, { directory: root, signal: new AbortController().signal, progress });
  expect(result).toMatchObject({ width: 2600, height: 2500, bands: 3 });
  const image = sharp(path.join(root, 'page.png')); expect(await image.metadata()).toMatchObject({ width: 2600, height: 2500 });
  expect([...await image.extract({ left: 2599, top: 2499, width: 1, height: 1 }).raw().toBuffer()]).toEqual([24, 160, 92]);
  expect(f.sendCommand.mock.calls.filter(([method]) => method === 'Page.captureScreenshot')).toHaveLength(6);
  expect((await sharp(await readFile(path.join(root, 'preview-2.jpg'))).metadata()).width).toBe(1000);
  expect(progress.mock.calls.some(([phase, complete, total]) => phase === 'capturing' && complete === 6 && total === 6)).toBe(true);
  expect(f.contents.debugger.isAttached()).toBe(false);
});
it('captures documents beyond the old height and pixel cap rather than silently cropping', async () => {
  const f = fixture(1000, 70000), root = await directory();
  const result = await fullPageImage(f.contents, { directory: root, signal: new AbortController().signal, progress: () => undefined });
  expect(result.height).toBe(70000); expect(result.width * result.height).toBeGreaterThan(64000000);
  expect(await sharp(path.join(root, 'page.png'), { limitInputPixels: false }).metadata()).toMatchObject({ width: 1000, height: 70000 });
});
it.skipIf(process.platform !== 'win32')('passes native BGRA tiles to the worker without PNG compression on the main thread', async () => {
  const f = fixture(300, 600), root = await directory(), toPNG = vi.fn(() => { throw Error('PNG compression must stay off main'); });
  Object.assign(f.contents, { getZoomFactor: () => 1, capturePage: vi.fn(async (rectangle?: { width: number; height: number }) => {
    const width = rectangle?.width ?? 300, height = rectangle?.height ?? 600;
    return { isEmpty: () => false, getSize: () => ({ width, height }), toBitmap: () => Buffer.alloc(width * height * 4, Buffer.from([92, 160, 24, 255])), toPNG };
  }) });
  await fullPageImage(f.contents, { directory: root, signal: new AbortController().signal, progress: () => undefined });
  expect(toPNG).not.toHaveBeenCalled();
  expect([...await sharp(path.join(root, 'page.png')).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer()]).toEqual([24, 160, 92]);
});
it('reports native failures in job state, cancels stalled commands, and releases its debugger', async () => {
  const f = fixture(), root = await directory(), job = new BrowserPageImageJob(root, vi.fn());
  f.sendCommand.mockRejectedValueOnce(Error('真实截图失败'));
  await job.start('tab', '页面', f.contents, () => true);
  await vi.waitFor(() => expect(job.state?.phase).toBe('failed'));
  expect(job.state?.error).toContain('真实截图失败');
  f.sendCommand.mockImplementation(async () => new Promise(() => undefined));
  await job.start('tab', '页面', f.contents, () => true); const id = job.state!.id;
  await vi.waitFor(() => expect(f.contents.debugger.isAttached()).toBe(true)); job.cancel(id);
  await vi.waitFor(() => expect(job.state?.phase).toBe('cancelled'));
  expect(f.contents.debugger.isAttached()).toBe(false); await job.clear();
});
it('requires preview confirmation, preserves preview on cancelled or failed saves, and rejects stale/invalid bands', async () => {
  const f = fixture(300, 600), root = await directory(), job = new BrowserPageImageJob(root, vi.fn());
  await job.start('tab', '页面', f.contents, () => true);
  await vi.waitFor(() => expect(job.state?.phase).toBe('preview'));
  const id = job.state!.id; expect(await job.tile(id, 0)).toMatch(/^data:image\/jpeg;base64,/u);
  await expect(job.tile(id, 1)).rejects.toThrow('不可用'); await expect(job.tile('stale', 0)).rejects.toThrow('过期');
  await job.save(id, async () => undefined); expect(job.state?.phase).toBe('preview');
  await job.save(id, async () => path.join(root, 'missing', 'page.png')); expect(job.state?.phase).toBe('preview'); expect(job.state?.error).toBeTruthy();
  const target = path.join(root, 'saved.png'); await job.save(id, async () => target);
  expect(job.state).toMatchObject({ phase: 'saved', savedPath: target }); expect(await sharp(target).metadata()).toMatchObject({ width: 300, height: 600 });
  await job.clear(); await expect(job.tile(id, 0)).rejects.toThrow('过期');
});
it('rejects changed documents without detaching another debugger owner', async () => {
  const f = fixture(), root = await directory();
  await expect(fullPageImage(f.contents, { directory: root, signal: new AbortController().signal, isCurrent: () => false, progress: () => undefined })).rejects.toThrow('跳转');
  expect(f.contents.debugger.attach).not.toHaveBeenCalled(); f.contents.debugger.attach();
  await expect(fullPageImage(f.contents, { directory: root, signal: new AbortController().signal, progress: () => undefined })).rejects.toThrow('调试器'); expect(f.contents.debugger.detach).not.toHaveBeenCalled();
});
