import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { cropCompanionAvatar } from '../../src/main/companions/avatar-crop';
import { companionsRequestSchema } from '../../src/shared/companions';
import type { CompanionAvatarCrop } from '../../src/shared/companion-avatar-crop';

const roots: string[] = [], stores = new Set<CompanionsStore>();
afterEach(async () => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) { if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-avatar-crop-')) throw new Error('Unexpected crop cleanup target.'); await rm(root, { recursive: true, force: true, maxRetries: 3 }); } });
async function fixture(bytes?: Buffer) {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-avatar-crop-')); roots.push(root); await mkdir(path.join(root, 'attachments'));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), []); stores.add(store);
  const original = bytes ?? await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><path fill="#ff0000" d="M0 0h300v200H0z"/><path fill="#00ff00" d="M300 0h300v200H300z"/><path fill="#0000ff" d="M0 200h300v200H0z"/><path fill="#ffff00" d="M300 200h300v200H300z"/></svg>')).png().toBuffer();
  const source = path.join(root, 'attachments', 'source.png'); await writeFile(source, original);
  store.registerAttachment({ attachment: { id: 'source', name: '分区形象.png', mime: 'image/png', size: original.length }, relativePath: 'attachments/source.png' });
  const options = { root, request: async (command: Parameters<CompanionsStore['request']>[0]) => store.request(command) };
  return { root, store, source, original, options };
}
const crop: CompanionAvatarCrop = { centerX: .25, centerY: .25, zoom: 4, rotation: 0 };
async function color(file: string) { const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true }); const start = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels; return [...data.subarray(start, start + 3)]; }
it('stores a true 512px square crop matching the selected circle and never modifies the source or player profile', async () => {
  const f = await fixture(), profile = f.store.getPlayerProfile(), [avatar] = await cropCompanionAvatar(f.options, { type: 'avatar.crop', attachmentId: 'source', crop });
  expect(avatar!.id).not.toBe('source'); expect(avatar!.mime).toBe('image/png'); expect(avatar!.url).toContain(avatar!.id);
  const stored = f.store.getAttachment(avatar!.id), output = path.join(f.root, stored.relativePath);
  expect(await sharp(output).metadata()).toMatchObject({ width: 512, height: 512, format: 'png' }); expect(await color(output)).toEqual([255, 0, 0]);
  expect(await readFile(f.source)).toEqual(f.original); expect(f.store.getPlayerProfile()).toEqual(profile); expect(stored.sourcePath).toBeUndefined();
});
it('uses the rotated display coordinates and clamps a dragged center at image edges', async () => {
  const f = await fixture();
  for (const [rotation, expected] of [[0, [255, 0, 0]], [90, [0, 0, 255]], [180, [255, 255, 0]], [270, [0, 255, 0]]] as const) {
    const [avatar] = await cropCompanionAvatar(f.options, { type: 'avatar.crop', attachmentId: 'source', crop: { ...crop, rotation } });
    expect(await color(path.join(f.root, f.store.getAttachment(avatar!.id).relativePath))).toEqual(expected);
  }
  const [edge] = await cropCompanionAvatar(f.options, { type: 'avatar.crop', attachmentId: 'source', crop: { ...crop, centerX: 0, centerY: 0 } });
  expect(await color(path.join(f.root, f.store.getAttachment(edge!.id).relativePath))).toEqual([255, 0, 0]);
});
it('normalizes EXIF before user rotation so the saved pixels match the browser view', async () => {
  const initial = await fixture(), oriented = await sharp(initial.original).withMetadata({ orientation: 6 }).png().toBuffer(), f = await fixture(oriented);
  const [avatar] = await cropCompanionAvatar(f.options, { type: 'avatar.crop', attachmentId: 'source', crop });
  expect(await color(path.join(f.root, f.store.getAttachment(avatar!.id).relativePath))).toEqual([0, 0, 255]);
});
it('preserves transparency and rejects invalid requests, corrupt images and linked sources', async () => {
  const f = await fixture(await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
  const [avatar] = await cropCompanionAvatar(f.options, { type: 'avatar.crop', attachmentId: 'source', crop });
  const output = path.join(f.root, f.store.getAttachment(avatar!.id).relativePath); expect((await sharp(output).metadata()).hasAlpha).toBe(true);
  expect(companionsRequestSchema.safeParse({ type: 'avatar.crop', attachmentId: 'source', crop: { ...crop, zoom: 0 } }).success).toBe(false);
  expect(companionsRequestSchema.safeParse({ type: 'avatar.crop', attachmentId: 'source', crop: { ...crop, rotation: 45 } }).success).toBe(false);
  f.store.registerAttachment({ attachment: { id: 'linked', name: 'linked.png', mime: 'image/png', size: 10 }, relativePath: 'attachments/linked.png', sourcePath: f.source });
  await expect(cropCompanionAvatar(f.options, { type: 'avatar.crop', attachmentId: 'linked', crop })).rejects.toThrow('图片副本');
  await writeFile(f.source, 'broken'); await expect(cropCompanionAvatar(f.options, { type: 'avatar.crop', attachmentId: 'source', crop })).rejects.toThrow('完整裁剪');
});
