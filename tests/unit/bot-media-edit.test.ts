import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { exportAttachment } from '../../src/main/companion-bot/media-edit';
import { botMediaRequestSchema, type BotMediaRef, type ImageEdit } from '../../src/shared/companion-bot-media';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'studio-export-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const ref: BotMediaRef = { kind: 'file', id: 'photo', name: 'photo.png', mimeType: 'image/png', size: 128, url: '' };
const edit: ImageEdit = { kind: 'image', turns: 1, mirror: true, crop: 'custom', region: { x: 0.25, y: 0, right: 1, bottom: 2 / 3 } };

it('exports exactly the selected pixels with source-space mirroring followed by clockwise rotation', async () => {
  const original = path.join(dir, 'input.png'), output = path.join(dir, 'output.png');
  const pixels = Buffer.from(Array.from({ length: 12 }, (_, i) => [i+1, 0, 0]).flat());
  await sharp(pixels, { raw: { width: 4, height: 3, channels: 3 } }).png().toFile(original);
  await exportAttachment({ ref, path: original }, edit, output);
  const result = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  expect([result.info.width, result.info.height]).toEqual([2, 3]);
  expect([...result.data].filter((_, i) => i % result.info.channels === 0)).toEqual([8, 4, 7, 3, 6, 2]);
});

it('leaves the chosen destination intact on a decoder failure or cancellation', async () => {
  const source = path.join(dir, 'source.png'), target = path.join(dir, 'target.png');
  await writeFile(source, 'invalid image'); await writeFile(target, 'previous copy');
  await expect(exportAttachment({ ref, path: source }, edit, target)).rejects.toThrow();
  await expect(exportAttachment({ ref, path: source }, edit, target, undefined, AbortSignal.abort())).rejects.toThrow();
  expect(await readFile(target, 'utf8')).toBe('previous copy');
  expect((await readdir(dir)).sort()).toEqual(['source.png', 'target.png']);
});

it('rejects missing or inverted custom crop bounds and invalid clip intervals at the bridge', () => {
  const request = { type: 'attachment.export', conversationId: 'room', id: 'photo', exportId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  expect(botMediaRequestSchema.safeParse({ ...request, edit }).success).toBe(true);
  for (const invalid of [{ ...edit, region: undefined }, { ...edit, region: { x: 1, right: 0, y: 0, bottom: 1 } }, { kind: 'clip', start: 3, end: 2 }]) {
    expect(botMediaRequestSchema.safeParse({ ...request, edit: invalid }).success).toBe(false);
  }
});

