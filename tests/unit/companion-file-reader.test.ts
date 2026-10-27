import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { CompanionFileReader } from '../../src/main/companions/file-reader';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionToolImageReference } from '../../src/shared/companion-file-tool';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-file-reader-')) throw new Error('Unexpected file reader fixture root.');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
} });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-file-reader-')); roots.push(root); const managed = path.join(root, 'managed'); await mkdir(managed);
  const store = new CompanionsStore(path.join(managed, 'messages.sqlite'), []); stores.add(store);
  const reader = new CompanionFileReader({ root: managed, request: async command => store.request(command) }); return { root, managed, store, reader };
}
async function image(file: string, color = '#65b482', orientation?: number): Promise<Buffer> {
  let pixels = sharp({ create: { width: 40, height: 80, channels: 4, background: color } });
  if (orientation) pixels = pixels.withMetadata({ orientation });
  const bytes = await (file.endsWith('.jpg') ? pixels.jpeg() : pixels.png()).toBuffer(); await writeFile(file, bytes); return bytes;
}

it('reads UTF-8 BOM/CRLF by real numbered lines and persists an exact managed text attachment', async () => {
  const f = await fixture(), file = path.join(f.root, '笔记.txt'), bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\r\n第二行\r\nthird\r\n末行\r\n')]); await writeFile(file, bytes);
  const result = await f.reader.readFile({ path: file, offset: 1, limit: 2 });
  expect(result.file).toMatchObject({ path: await realpath(file), size: bytes.length, totalLines: 4, offset: 1, lineCount: 2, encoding: 'utf-8', nextOffset: 3, truncated: true, sha256: sha(bytes) });
  expect(result.content).toContain('2 | 第二行\n3 | third\n'); expect(result.content).not.toContain('1 | 第一行');
  const attachment = result.attachments[0]!, stored = f.store.getAttachment(attachment.id);
  expect(stored.sourcePath).toBeUndefined(); expect(stored.attachment.mime).toBe('text/plain'); expect(stored.relativePath).toMatch(/^attachments\/[a-f0-9-]+\.txt$/u);
  expect(await readFile(path.join(f.managed, stored.relativePath))).toEqual(bytes); expect(await readFile(file)).toEqual(bytes);
  const rest = await f.reader.readFile({ path: file, offset: result.file.nextOffset, limit: 2 }); expect(rest.file).toMatchObject({ lineCount: 1, truncated: false }); expect(rest.file.nextOffset).toBeUndefined(); expect(rest.content).toContain('4 | 末行');
});
it('decodes both BOM UTF-16 orders and honors default pagination, empty files and out-of-range offsets', async () => {
  const f = await fixture(), le = Buffer.from('中文🙂\nnext\n', 'utf16le'), be = Buffer.from(le).swap16();
  for (const [name, bom, bytes, encoding] of [['le', [255, 254], le, 'utf-16le'], ['be', [254, 255], be, 'utf-16be']] as const) {
    const file = path.join(f.root, name + '.txt'); await writeFile(file, Buffer.concat([Buffer.from(bom), bytes])); const result = await f.reader.readFile({ path: file });
    expect(result.file).toMatchObject({ encoding, totalLines: 2, lineCount: 2 }); expect(result.content).toContain('1 | 中文🙂\n2 | next');
  }
  const many = path.join(f.root, 'many.txt'); await writeFile(many, Array.from({ length: 250 }, (_, index) => 'line' + index).join('\n'));
  expect((await f.reader.readFile({ path: many })).file).toMatchObject({ offset: 0, lineCount: 200, nextOffset: 200 });
  expect((await f.reader.readFile({ path: many, offset: 999 })).file).toMatchObject({ offset: 999, lineCount: 0, truncated: false });
  const empty = path.join(f.root, 'empty.txt'); await writeFile(empty, ''); expect((await f.reader.readFile({ path: empty })).file).toMatchObject({ totalLines: 0, lineCount: 0, truncated: false });
  const blanks = path.join(f.root, 'million-blank-lines.txt'); await writeFile(blanks, '\n'.repeat(1000000));
  expect((await f.reader.readFile({ path: blanks, offset: 999998 })).file).toMatchObject({ totalLines: 1000000, lineCount: 2, truncated: false });
});
it('keeps returned whole lines within 128 KiB with an accurate continuation and rejects a single oversized line', async () => {
  const f = await fixture(), file = path.join(f.root, 'large-text.txt'), line = '汉字🙂'.repeat(160), lines = Array.from({ length: 240 }, (_, index) => index + ':' + line); await writeFile(file, lines.join('\n'));
  const first = await f.reader.readFile({ path: file, limit: 2000 }); expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(128 * 1024); expect(first.file.lineCount).toBeLessThan(240); expect(first.file.nextOffset).toBe(first.file.lineCount);
  const next = await f.reader.readFile({ path: file, offset: first.file.nextOffset, limit: 1 }); expect(next.content).toContain(`${first.file.lineCount + 1} | ${lines[first.file.lineCount]}`);
  const hugeLine = path.join(f.root, 'huge-line.txt'); await writeFile(hugeLine, 'a'.repeat(129 * 1024)); await expect(f.reader.readFile({ path: hugeLine })).rejects.toThrow('单行');
});
it('rejects relative paths, directories, malformed text, binary inputs, invalid limits and files above the input cap', async () => {
  const f = await fixture(); await expect(f.reader.readFile({ path: 'relative.txt' })).rejects.toThrow('绝对'); await expect(f.reader.readFile({ path: f.root })).rejects.toThrow('普通文件');
  const invalid = path.join(f.root, 'invalid.txt'); await writeFile(invalid, Buffer.from([0xff, 0xff, 0x80])); await expect(f.reader.readFile({ path: invalid })).rejects.toThrow('有效');
  const binary = path.join(f.root, 'binary.dat'); await writeFile(binary, Buffer.from([0, 1, 2, 0, 255])); await expect(f.reader.readFile({ path: binary })).rejects.toThrow();
  const pdf = path.join(f.root, 'ascii.pdf'); await writeFile(pdf, '%PDF-1.4\nASCII-only PDF container'); await expect(f.reader.readFile({ path: pdf })).rejects.toThrow('格式');
  const tooBig = path.join(f.root, 'too-big.txt'), handle = await open(tooBig, 'w'); await handle.truncate(20 * 1024 * 1024 + 1); await handle.close(); await expect(f.reader.readFile({ path: tooBig })).rejects.toThrow('20 MiB'); await expect(f.reader.readImage({ path: tooBig })).rejects.toThrow('20 MiB');
  await expect(f.reader.readFile({ path: invalid, limit: 2001 })).rejects.toThrow(); await expect(f.reader.readFile({ path: invalid, offset: -1 })).rejects.toThrow();
});
it('fully decodes and auto-rotates an image into a registered JPEG reference without persisting base64', async () => {
  const f = await fixture(), file = path.join(f.root, 'rotated.jpg'), original = await image(file, '#65b482', 6), result = await f.reader.readImage({ path: file });
  expect(result.images).toHaveLength(1); const reference = result.images[0]!; expect(reference).toMatchObject({ mime: 'image/jpeg', width: 80, height: 40 });
  const stored = f.store.getAttachment(reference.attachmentId), bytes = await readFile(reference.path);
  expect(stored.sourcePath).toBeUndefined(); expect(reference.path).toBe(path.join(f.managed, stored.relativePath)); expect(bytes.length).toBeLessThanOrEqual(1024 * 1024); expect(sha(bytes)).toBe(reference.sha256);
  expect((await sharp(bytes).metadata()).format).toBe('jpeg'); expect(JSON.stringify(result)).not.toMatch(/base64|data:image/u); expect(await readFile(file)).toEqual(original);
  const loaded = await f.reader.hydrate(result.images); expect(loaded.unavailable).toEqual([]); expect(loaded.images[0]!.attachmentId).toBe(reference.attachmentId); expect(Buffer.from(loaded.images[0]!.base64, 'base64')).toEqual(bytes);
});
it('bounds a high-entropy image below one MiB and flattens transparent pixels onto white', async () => {
  const f = await fixture(), file = path.join(f.root, 'noise.png');
  await sharp(randomBytes(1536 * 1536 * 3), { raw: { width: 1536, height: 1536, channels: 3 } }).png().toFile(file);
  const result = await f.reader.readImage({ path: file }), bytes = await readFile(result.images[0]!.path); expect(bytes.length).toBeLessThanOrEqual(1024 * 1024); expect(result.images[0]!.width).toBeLessThanOrEqual(1280);
  const transparent = path.join(f.root, 'transparent.png'); await image(transparent, '#00000000'); const white = await f.reader.readImage({ path: transparent });
  const pixels = await sharp(white.images[0]!.path).raw().toBuffer(); expect([...pixels.subarray(0, 3)]).toEqual([255, 255, 255]);
});
it('hydrates only the immutable managed copy and reports unavailable after tampering, deletion or path escape', async () => {
  const f = await fixture(), file = path.join(f.root, 'source.png'); await image(file); const result = await f.reader.readImage({ path: file }), reference = result.images[0]!;
  await unlink(file); expect((await f.reader.hydrate([reference])).images).toHaveLength(1);
  const outside = path.join(f.root, 'outside.jpg'); await writeFile(outside, await readFile(reference.path));
  const escaped = await f.reader.hydrate([{ ...reference, path: outside }]); expect(escaped.images).toEqual([]); expect(escaped.unavailable[0]!.error).toContain('unavailable');
  await image(reference.path, '#c05454'); const replaced = await f.reader.hydrate([reference]); expect(replaced.images).toEqual([]); expect(replaced.unavailable[0]!.error).toContain('替换');
  await unlink(reference.path); const missing = await f.reader.hydrate([reference]); expect(missing.images).toEqual([]); expect(missing.unavailable[0]!.error).toContain('unavailable');
});
it('rejects corrupt and linked image refs, never follows an attachments junction, and enforces a four-image hydration cap', async () => {
  const f = await fixture(), corrupt = path.join(f.root, 'corrupt.png'); await writeFile(corrupt, 'Not an image'); await expect(f.reader.readImage({ path: corrupt })).rejects.toThrow('完整解码');
  const source = path.join(f.root, 'source.png'); await image(source); const refs: CompanionToolImageReference[] = [];
  for (let index = 0; index < 5; index++) refs.push((await f.reader.readImage({ path: source })).images[0]!);
  const loaded = await f.reader.hydrate(refs); expect(loaded.images).toHaveLength(4); expect(loaded.unavailable).toHaveLength(1);
  f.store.registerAttachment({ attachment: { id: 'linked', name: 'linked.png', mime: 'image/png', size: 1 }, relativePath: 'attachments/linked.png', sourcePath: source });
  expect((await f.reader.hydrate([{ ...refs[0]!, attachmentId: 'linked' }])).unavailable).toHaveLength(1);
  const otherManaged = path.join(f.root, 'other-managed'), outside = path.join(f.root, 'outside-directory'); await mkdir(otherManaged); await mkdir(outside);
  await symlink(outside, path.join(otherManaged, 'attachments'), process.platform === 'win32' ? 'junction' : 'dir');
  const guarded = new CompanionFileReader({ root: otherManaged, request: async command => f.store.request(command) }); await expect(guarded.readImage({ path: source })).rejects.toThrow('受管目录');
  // Remove only the junction itself, before recursively cleaning the verified fixture root.
  await unlink(path.join(otherManaged, 'attachments'));
});
it('sends existing media and documents as exact managed files without claiming analysis or altering the source', async () => {
  const f = await fixture();
  for (const [extension, mime] of [['mp3', 'audio/mpeg'], ['mp4', 'video/mp4'], ['pdf', 'application/pdf'], ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['unknown', 'application/octet-stream']] as const) {
    const source = path.join(f.root, 'fixture.' + extension), original = randomBytes(128); await writeFile(source, original);
    const result = await f.reader.sendFile({ path: source }), attachment = result.attachments[0]!, registered = f.store.getAttachment(attachment.id);
    expect(result.file).toMatchObject({ path: await realpath(source), size: original.length, mime, sha256: sha(original) }); expect(attachment.mime).toBe(mime); expect(registered.sourcePath).toBeUndefined();
    expect(await readFile(attachment.path!)).toEqual(original); expect(await readFile(source)).toEqual(original); expect(result.content).toContain('未分析'); expect(result).not.toHaveProperty('images');
  }
});
it('copies original audio above 100 MiB and registers larger media as references instead of rejecting them', async () => {
  const f = await fixture(), source = path.join(f.root, 'video.mp4'), handle = await open(source, 'w'); await handle.truncate(21 * 1024 * 1024); await handle.write(Buffer.from('synthetic media payload'), 0, 23, 0); await handle.close();
  const sent = await f.reader.sendFile({ path: source }); expect(sent.file.size).toBe(21 * 1024 * 1024); expect((await f.reader.hydrate([])).images).toEqual([]);
  expect(sha(await readFile(sent.attachments[0]!.path!))).toBe(sha(await readFile(source))); await expect(f.reader.readFile({ path: source })).rejects.toThrow('20 MiB');
  const audio = path.join(f.root, 'original.wav'), big = await open(audio, 'w'); await big.truncate(108 * 1024 * 1024); await big.close();
  const original = await f.reader.sendFile({ path: audio }); expect(original.file.size).toBe(108 * 1024 * 1024); expect(original.file.sha256).toBeDefined();
  const larger = path.join(f.root, 'large.mp4'), sparse = await open(larger, 'w'); await sparse.truncate(512 * 1024 * 1024); await sparse.close();
  const reference = await f.reader.sendFile({ path: larger }, 'd'.repeat(64));
  expect(reference.file).toMatchObject({ linked: true, size: 512 * 1024 * 1024 });
  expect(f.store.getAttachment(reference.file.attachmentId).sourcePath).toBe(await realpath(larger));
  expect(await f.reader.sendFile({ path: larger }, 'd'.repeat(64))).toEqual(reference);
});
it('restores each committed file call after source deletion and restart without making duplicate snapshots', async () => {
  const f = await fixture(), text = path.join(f.root, 'durable.txt'), picture = path.join(f.root, 'durable.png'), media = path.join(f.root, 'durable.wav');
  await writeFile(text, '已正式读取的原文。'); await image(picture); await writeFile(media, Buffer.from('synthetic existing media bytes'));
  const saved = [await f.reader.readFile({ path: text }, 'a'.repeat(64)), await f.reader.readImage({ path: picture }, 'b'.repeat(64)), await f.reader.sendFile({ path: media }, 'c'.repeat(64))];
  expect(await readdir(path.join(f.managed, 'attachments'))).toHaveLength(3);
  await unlink(text); await unlink(picture); await unlink(media); f.store.close(); stores.delete(f.store);
  const restarted = new CompanionsStore(path.join(f.managed, 'messages.sqlite'), []); stores.add(restarted);
  const reader = new CompanionFileReader({ root: f.managed, request: async command => restarted.request(command) });
  expect(await reader.readFile({ path: text }, 'a'.repeat(64))).toEqual(saved[0]);
  expect(await reader.readImage({ path: picture }, 'b'.repeat(64))).toEqual(saved[1]);
  expect(await reader.sendFile({ path: media }, 'c'.repeat(64))).toEqual(saved[2]);
  expect(await readdir(path.join(f.managed, 'attachments'))).toHaveLength(3);
  const reference = (saved[1] as Awaited<ReturnType<typeof reader.readImage>>).images[0]!;
  expect((await reader.hydrate([reference])).images).toHaveLength(1);
  expect(restarted.request({ type: 'file.result.get', key: 'b'.repeat(64) }).fileToolResult).not.toContain('base64');
  await expect(reader.readFile({ path: text }, 'd'.repeat(64))).rejects.toThrow();
});
it('atomically commits snapshot references with a call result and rolls back a failed registration batch', async () => {
  const f = await fixture(), file = path.join(f.root, 'one.txt'); await writeFile(file, 'stable');
  const original = await f.reader.readFile({ path: file }, 'e'.repeat(64)), existing = f.store.getAttachment(original.attachments[0]!.id);
  const pending = { attachment: { id: 'pending-rollback', name: 'new.txt', size: 3, mime: 'text/plain' }, relativePath: 'attachments/pending-rollback.txt' };
  expect(() => f.store.request({ type: 'file.result.commit', key: 'f'.repeat(64), result: '{"content":"not committed"}', attachments: [pending, existing] })).toThrow();
  expect(f.store.request({ type: 'file.result.get', key: 'f'.repeat(64) }).fileToolResult).toBeUndefined();
  expect(() => f.store.getAttachment('pending-rollback')).toThrow('附件不存在');
  expect(f.store.request({ type: 'file.result.commit', key: 'e'.repeat(64), result: '{"content":"must not replace"}', attachments: [pending] }).fileToolResult).toBe(JSON.stringify(original));
  expect(() => f.store.getAttachment('pending-rollback')).toThrow('附件不存在');
});
