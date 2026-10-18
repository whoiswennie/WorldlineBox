import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { LongCaptureStitcher } from '../../src/main/capture-tools/long-capture';

const width = 180; const height = 1200; const frameHeight = 240;
let document: Buffer;
beforeAll(async () => {
  const bytes = Buffer.alloc(width * height * 3); let seed = 928381;
  for (let index = 0; index < bytes.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[index] = seed >>> 24; }
  document = await sharp(bytes, { raw: { width, height, channels: 3 } }).png().toBuffer();
});
async function frame(scroll: number): Promise<string> {
  const content = await sharp(document).extract({ left: 0, top: scroll, width, height: frameHeight }).png().toBuffer();
  const screenshot = await sharp({ create: { width: width + 40, height: frameHeight + 60, channels: 3, background: '#ffffff' } }).composite([{ input: content, left: 20, top: 30 }]).png().toBuffer();
  return `data:image/png;base64,${screenshot.toString('base64')}`;
}
const rect = { x: 20, y: 30, width, height: frameHeight };
async function pixels(dataUrl: string) { return sharp(Buffer.from(dataUrl.split(',')[1]!, 'base64')).removeAlpha().raw().toBuffer(); }

describe('desktop manual-scroll screenshot stitching', () => {
  it('matches physical-pixel overlap and stitches only the new bottom region', async () => {
    const session = await LongCaptureStitcher.create(await frame(0), rect);
    expect(await session.append(await frame(120))).toEqual({ frames: 2, width, height: 360 });
    expect(await session.append(await frame(220))).toEqual({ frames: 3, width, height: 460 });
    const result = await session.finish();
    const expected = await sharp(document).extract({ left: 0, top: 0, width, height: 460 }).removeAlpha().raw().toBuffer();
    expect(await pixels(result.dataUrl)).toEqual(expected);
    expect([result.width, result.height]).toEqual([180, 460]);
    await expect(session.append(await frame(300))).rejects.toThrow('已结束');
  });

  it('rejects unchanged or disjoint frames and keeps the last accepted position for retry', async () => {
    const session = await LongCaptureStitcher.create(await frame(0), rect);
    await expect(session.append(await frame(0))).rejects.toThrow('没有明显滚动');
    await expect(session.append(await frame(500))).rejects.toThrow('无法可靠匹配');
    expect(session.state).toEqual({ frames: 1, width, height: frameHeight });
    await session.append(await frame(100));
    expect(session.state.height).toBe(340);
  });

  it('enforces the frame limit without silently truncating the image', async () => {
    const session = await LongCaptureStitcher.create(await frame(0), rect);
    for (let index = 1; index < 20; index++) await session.append(await frame(index * 10));
    await expect(session.append(await frame(200))).rejects.toThrow('最多支持 20 帧');
    expect(session.state.frames).toBe(20);
  });

  it('detects changed desktop dimensions and requires a new selection', async () => {
    const session = await LongCaptureStitcher.create(await frame(0), rect);
    const changed = await sharp(Buffer.from((await frame(100)).split(',')[1]!, 'base64')).extend({ right: 10, background: '#fff' }).png().toBuffer();
    await expect(session.append(`data:image/png;base64,${changed.toString('base64')}`)).rejects.toThrow('屏幕尺寸发生变化');
    expect(session.state.frames).toBe(1);
  });

  it('does not guess a stitch location for texture-free repeated content', async () => {
    const a = await sharp({ create: { width: 220, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const b = await sharp({ create: { width: 220, height: 300, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    const session = await LongCaptureStitcher.create(`data:image/png;base64,${a.toString('base64')}`, rect);
    await expect(session.append(`data:image/png;base64,${b.toString('base64')}`)).rejects.toThrow('无法可靠匹配');
  });

  it('bounds region dimensions, frame geometry, and cancellation', async () => {
    await expect(LongCaptureStitcher.create(await frame(0), { x: 0, y: 0, width: 10000, height: 10000 })).rejects.toThrow('4000 万像素');
    await expect(LongCaptureStitcher.create(await frame(0), { x: 0, y: 0, width: 20, height: 20 })).rejects.toThrow('至少');
    await expect(LongCaptureStitcher.create(await frame(0), { ...rect, x: 1000 })).rejects.toThrow('超出屏幕');
    const session = await LongCaptureStitcher.create(await frame(0), rect); session.cancel();
    await expect(session.finish()).rejects.toThrow('已结束');
  });
});
