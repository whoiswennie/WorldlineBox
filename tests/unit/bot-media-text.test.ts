import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { BOT_MEDIA_PREVIEW_MAX_BYTES, BOT_MEDIA_TEXT_PAGE_BYTES, BOT_MEDIA_TEXT_PAGE_MAX_BYTES, botMediaRequestSchema } from '../../src/shared/companion-bot-media';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('wlb-media-text-')) throw Error('Refusing unowned fixture cleanup.');
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wlb-media-text-')); roots.push(root);
  const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
  const attach = async (name: string, bytes: string | Buffer, conversationId = 'room-a') => {
    const file = path.join(root, name); await fs.writeFile(file, bytes);
    return (await media.importFiles({ conversationId, paths: [file] }))[0]!;
  };
  return { root, media, attach };
}
it('reads a large Markdown attachment in bounded byte pages without dropping its tail and persists its scope', async () => {
  const { root, media, attach } = await fixture();
  const content = '# 伙伴日记\n\n' + '这是一行包含中文、emoji 🐟 和实际事实的日记。\n'.repeat(17000) + '\n```mermaid\nflowchart LR\nA[开始] --> B[完成]\n```\n全文结束：晚安 🌙';
  const bytes = Buffer.from(content), ref = await attach('长期日记.md', bytes);
  expect(bytes.length).toBeGreaterThan(1024 * 1024); expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
  let offset = 0; const chunks: string[] = [], offsets = new Set<number>();
  for (;;) {
    expect(offsets.has(offset)).toBe(false); offsets.add(offset);
    const page = await media.readTextPage({ conversationId: 'room-a', id: ref.id, offset });
    expect(page).toMatchObject({ name: '长期日记.md', format: 'markdown', encoding: 'utf-8', totalBytes: bytes.length, offset });
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(BOT_MEDIA_TEXT_PAGE_BYTES); chunks.push(page.content);
    if (page.nextOffset === undefined) break;
    expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
    expect(offsets.size).toBeLessThan(100);
  }
  expect(chunks.length).toBeGreaterThan(16); expect(chunks.join('')).toBe(content);
  const restarted = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
  expect((await restarted.readTextPage({ conversationId: 'room-a', id: ref.id, offset })).content).toBe(chunks.at(-1));
  await expect(restarted.readTextPage({ conversationId: 'room-b', id: ref.id })).rejects.toThrow('不属于当前会话');
});
it('keeps UTF-8 emoji and Chinese characters whole at tiny page boundaries, including BOM byte cursors', async () => {
  const { media, attach } = await fixture(), content = 'A🐟中B🌙文C', bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]);
  const ref = await attach('字符边界.txt', bytes); let offset = 0, joined = '';
  const cursors: number[] = [];
  for (;;) {
    const page = await media.readTextPage({ conversationId: 'room-a', id: ref.id, offset, limit: 4 });
    expect(page.encoding).toBe('utf-8'); expect(page.content).not.toContain('\uFFFD');
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(4); joined += page.content;
    if (page.nextOffset === undefined) break;
    cursors.push(page.nextOffset); offset = page.nextOffset;
  }
  expect(joined).toBe(content); expect(cursors.slice(0, 2)).toEqual([4, 8]);
  await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id, offset: 5, limit: 4 })).rejects.toThrow('纯文本');
  await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id, offset: 1 })).rejects.toThrow('字符边界');
});
it('recognizes BOM UTF-16 in both byte orders and refuses malformed or unaligned UTF-16', async () => {
  const { media, attach } = await fixture(), content = 'A🐟中B🌙尾';
  for (const encoding of ['utf-16le', 'utf-16be'] as const) {
    const body = Buffer.from(content, 'utf16le'); if (encoding === 'utf-16be') body.swap16();
    const bytes = Buffer.concat([Buffer.from(encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff]), body]);
    const ref = await attach(`${encoding}.txt`, bytes); let offset = 0, joined = '';
    for (;;) {
      const page = await media.readTextPage({ conversationId: 'room-a', id: ref.id, offset, limit: 4 });
      expect(page.encoding).toBe(encoding); expect(page.content).not.toContain('\uFFFD'); joined += page.content;
      if (page.nextOffset === undefined) break;
      expect((page.nextOffset - 2) % 2).toBe(0); offset = page.nextOffset;
    }
    expect(joined).toBe(content);
    await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id, offset: 3 })).rejects.toThrow('字符边界');
  }
  for (const [name, bytes] of [['odd', [0xff, 0xfe, 0x61]], ['unpaired', [0xff, 0xfe, 0x00, 0xd8]], ['without-bom', [0x61, 0x00]]] as const) {
    const ref = await attach(`${name}.txt`, Buffer.from(bytes));
    await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id })).rejects.toThrow('纯文本');
  }
});
it('refuses renamed executables, archives, images, invalid UTF and control bytes; Office is never read as text', async () => {
  const { media, attach } = await fixture();
  const cases: Array<[string, Buffer]> = [
    ['exe.md', Buffer.from('MZsome executable')], ['zip.md', Buffer.from('PKarchive')], ['elf.txt', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ['office.md', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])], ['pdf.txt', Buffer.from('%PDF-1.7')],
    ['image.md', Buffer.from([0x89, 0x50, 0x4e, 0x47])], ['nul.txt', Buffer.from('hello\0world')],
    ['control.txt', Buffer.from('hello\x1b[31m')], ['broken-utf8.md', Buffer.from([0x61, 0xc0, 0xaf])],
  ];
  for (const [name, bytes] of cases) {
    const ref = await attach(name, bytes);
    await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id })).rejects.toThrow('纯文本');
  }
  for (const name of ['report.doc', 'report.docx', 'table.xls', 'table.xlsx', 'page.html', 'unknown.bin']) {
    const ref = await attach(name, 'Readable ASCII does not change the document type.');
    await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id })).rejects.toThrow('不是 200MB 以内的纯文本');
  }
});
it('enforces IPC/service pagination ranges and the 200MiB cap before reading oversized originals', async () => {
  const { root, media, attach } = await fixture(), ref = await attach('small.txt', 'Hello 🐟');
  for (const offset of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id, offset })).rejects.toThrow('范围');
    expect(botMediaRequestSchema.safeParse({ type: 'media.text.read', conversationId: 'room-a', id: ref.id, offset }).success).toBe(false);
  }
  for (const limit of [0, 3, 4.5, BOT_MEDIA_TEXT_PAGE_MAX_BYTES + 1]) {
    await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id, limit })).rejects.toThrow('范围');
    expect(botMediaRequestSchema.safeParse({ type: 'media.text.read', conversationId: 'room-a', id: ref.id, limit }).success).toBe(false);
  }
  await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id, offset: 100 })).rejects.toThrow('分页位置');
  expect(await media.readTextPage({ conversationId: 'room-a', id: ref.id, offset: ref.size })).toMatchObject({ content: '', offset: ref.size });
  const empty = await attach('empty.txt', ''); expect(await media.readTextPage({ conversationId: 'room-a', id: empty.id })).toMatchObject({ content: '', totalBytes: 0 });
  const source = path.join(root, 'oversized.txt'), handle = await fs.open(source, 'wx');
  try { await handle.truncate(BOT_MEDIA_PREVIEW_MAX_BYTES + 1); } finally { await handle.close(); }
  const [large] = await media.importFiles({ conversationId: 'room-a', paths: [source] });
  expect(large).toMatchObject({ storage: 'external', previewEligibility: 'external-only', analysisBlocked: true });
  await expect(media.readTextPage({ conversationId: 'room-a', id: large!.id })).rejects.toThrow('200MB');
});
it('detects changed managed objects and never substitutes the mutable system-open copy', async () => {
  const { media, attach } = await fixture(), ref = await attach('immutable.txt', 'Original diary text.');
  const copy = await media.getForUserOpen('room-a', ref.id); await fs.writeFile(copy.path, 'Edited by external app.');
  expect((await media.readTextPage({ conversationId: 'room-a', id: ref.id })).content).toBe('Original diary text.');
  const object = await media.getForAgent('room-a', ref.id); await fs.writeFile(object.path, 'Different diary text');
  await expect(media.readTextPage({ conversationId: 'room-a', id: ref.id })).rejects.toThrow('校验失败');
});
