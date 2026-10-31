import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAttachmentCovers, companionVideoCoverArguments } from '../../src/main/companions/attachment-cover';

let root: string;
const covers: CompanionAttachmentCovers[] = [];
const request = (method = 'GET', etag?: string) => new Request('worldlinebox-companion://attachment/registered?cover=1', { method, headers: etag ? { 'if-none-match': etag } : {} });
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-cover-')); });
afterEach(async () => {
  for (const cover of covers.splice(0)) cover.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-cover-')) throw new Error('Unexpected test cleanup target.');
  await rm(root, { force: true, recursive: true });
});
const manager = (decode?: ConstructorParameters<typeof CompanionAttachmentCovers>[0]) => { const cover = new CompanionAttachmentCovers(decode); covers.push(cover); return cover; };

it.each(['gif', 'webp'] as const)('extracts a real, single static PNG frame from animated %s bytes, including misnamed files', async format => {
  const red = await sharp({ create: { width: 12, height: 12, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 12, height: 12, channels: 4, background: '#0000ff' } }).png().toBuffer();
  const animation = sharp([red, blue], { join: { animated: true } });
  const bytes = await (format === 'gif' ? animation.gif({ delay: [100, 100] }) : animation.webp({ lossless: true, delay: [100, 100] })).toBuffer();
  expect((await sharp(bytes).metadata()).pages).toBe(2);
  const file = path.join(root, 'misnamed.gif'); await writeFile(file, bytes);
  const response = await manager().response(file, 'image/gif', request());
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
  const still = Buffer.from(await response.arrayBuffer()), info = await sharp(still).metadata();
  expect(info.format).toBe('png'); expect(info.pages ?? 1).toBe(1); expect(info.width).toBe(12); expect(info.height).toBe(12);
  const pixel = await sharp(still).removeAlpha().raw().toBuffer();
  expect([...pixel.subarray(0, 3)]).toEqual([255, 0, 0]);
});

it('deduplicates pending cover work, caches the current source and invalidates a changed file', async () => {
  const file = path.join(root, 'clip.mp4'); await writeFile(file, 'first');
  let complete!: (bytes: Buffer) => void;
  const decode = vi.fn(() => new Promise<Buffer>(resolve => { complete = resolve; })), service = manager(decode);
  const a = service.response(file, 'video/mp4', request()), b = service.response(file, 'video/mp4', request());
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce(), { interval: 1, timeout: 1000 });
  complete(Buffer.from('actual static frame'));
  const [first, other] = await Promise.all([a, b]);
  expect(await first.text()).toBe('actual static frame'); expect(await other.text()).toBe('actual static frame');
  const etag = first.headers.get('etag')!;
  expect((await service.response(file, 'video/mp4', request('GET', etag))).status).toBe(304);
  const head = await service.response(file, 'video/mp4', request('HEAD'));
  expect(head.headers.get('content-type')).toBe('image/png'); expect(await head.text()).toBe(''); expect(decode).toHaveBeenCalledOnce();
  await writeFile(file, 'changed longer source');
  const next = service.response(file, 'video/mp4', request());
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2), { interval: 1, timeout: 1000 });
  complete(Buffer.from('new frame')); expect((await next).headers.get('etag')).not.toBe(etag);
});

it('rejects a source changed during decoding and never caches a failed cover', async () => {
  const file = path.join(root, 'image.gif'); await writeFile(file, 'first');
  const decode = vi.fn(async () => { await writeFile(file, 'replaced while decoding'); return Buffer.from('stale frame'); }), service = manager(decode);
  const response = await service.response(file, 'image/gif', request());
  expect(response.status).toBe(404); expect(await response.text()).toBe('');
  decode.mockResolvedValue(Buffer.from('fresh frame'));
  expect(await (await service.response(file, 'image/gif', request())).text()).toBe('fresh frame'); expect(decode).toHaveBeenCalledTimes(2);
});

it('keeps cover decoders in a small independent lane and cancels active and queued work on close', async () => {
  const files = await Promise.all(Array.from({ length: 5 }, async (_, index) => { const file = path.join(root, `${index}.mp4`); await writeFile(file, `clip-${index}`); return file; }));
  const decode = vi.fn((_file: string, _mime: string, signal: AbortSignal) => new Promise<Buffer>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })));
  const service = manager(decode), pending = files.map(file => service.response(file, 'video/mp4', request()));
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2), { interval: 1, timeout: 1000 });
  service.close();
  expect((await Promise.all(pending)).every(response => response.status >= 400)).toBe(true); expect(decode).toHaveBeenCalledTimes(2);
});

it('accepts only passive image/video GET or HEAD work and builds a single-frame local-only video command', async () => {
  const file = path.join(root, 'clip.mp4'); await writeFile(file, 'clip');
  const decode = vi.fn(async () => Buffer.from('cover')), service = manager(decode);
  expect((await service.response(file, 'text/html', request())).status).toBe(415);
  expect((await service.response(file, 'video/mp4', request('POST'))).status).toBe(405); expect(decode).not.toHaveBeenCalled();
  const args = companionVideoCoverArguments('C:\\A folder\\clip & name.mp4');
  expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file,pipe']);
  expect(args[args.indexOf('-format_whitelist') + 1]).not.toMatch(/hls|concat|image2/u);
  expect(args[args.indexOf('-i') + 1]).toBe('C:\\A folder\\clip & name.mp4');
  expect(args[args.indexOf('-frames:v') + 1]).toBe('1'); expect(args.at(-1)).toBe('pipe:1');
});
