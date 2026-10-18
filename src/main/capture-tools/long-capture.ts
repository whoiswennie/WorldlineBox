import sharp from 'sharp';

export type LongCaptureRect = { x: number; y: number; width: number; height: number };
export type LongCaptureState = { frames: number; width: number; height: number };
export const LONG_CAPTURE_MAX_FRAMES = 20;
export const LONG_CAPTURE_MAX_PIXELS = 40_000_000;
export const LONG_CAPTURE_MAX_HEIGHT = 32768;
const PAYLOAD_LIMIT = 32 * 1024 * 1024;
const FEATURE_WIDTH = 96;
type Frame = { png: Buffer; feature: Buffer; screenWidth: number; screenHeight: number };
type Piece = { input: Buffer; top: number; left: number };

/** Manual-scroll capture. No page scripting, input injection, or arbitrary file access. */
export class LongCaptureStitcher {
  private previous?: Frame;
  private pieces: Piece[] = [];
  private frames = 0;
  private height = 0;
  private closed = false;
  private busy = false;
  private constructor(private readonly rect: LongCaptureRect) {}

  static async create(dataUrl: string, rect: LongCaptureRect): Promise<LongCaptureStitcher> {
    if (!Object.values(rect).every(value => Number.isInteger(value) && value >= 0) || rect.width < 32 || rect.height < 64) throw new Error('请框选至少 32 × 64 像素的滚动内容区域。');
    enforceSize(rect.width, rect.height);
    const session = new LongCaptureStitcher({ ...rect });
    const frame = await session.decode(dataUrl);
    session.previous = frame; session.pieces.push({ input: frame.png, top: 0, left: 0 }); session.frames = 1; session.height = rect.height;
    return session;
  }

  get state(): LongCaptureState { return { frames: this.frames, width: this.rect.width, height: this.height }; }

  async append(dataUrl: string): Promise<LongCaptureState> {
    this.assertOpen();
    if (this.busy) throw new Error('上一帧仍在处理，请稍候。');
    if (this.frames >= LONG_CAPTURE_MAX_FRAMES) throw new Error('长截图最多支持 20 帧，请完成当前截图后重新开始。');
    this.busy = true;
    try {
      const previous = this.previous!; const next = await this.decode(dataUrl);
      this.assertOpen();
      if (previous.screenWidth !== next.screenWidth || previous.screenHeight !== next.screenHeight) throw new Error('屏幕尺寸发生变化，请取消后重新框选。');
      const offset = findVerticalOffset(previous.feature, next.feature, this.rect.height);
      const height = this.height + offset;
      enforceSize(this.rect.width, height);
      const bottom = await sharp(next.png).extract({ left: 0, top: this.rect.height - offset, width: this.rect.width, height: offset }).png().toBuffer();
      this.assertOpen();
      if (this.pieces.reduce((sum, item) => sum + item.input.length, 0) + bottom.length > 96 * 1024 * 1024) throw new Error('长截图占用内存过大，请先完成当前截图。');
      this.pieces.push({ input: bottom, top: this.height, left: 0 }); this.height = height; this.frames++; this.previous = next;
      return this.state;
    } finally { this.busy = false; }
  }

  async finish(): Promise<{ dataUrl: string; width: number; height: number }> {
    this.assertOpen(); if (this.busy) throw new Error('上一帧仍在处理，请稍候再完成截图。');
    this.busy = true;
    try {
      const output = await sharp({ create: { width: this.rect.width, height: this.height, channels: 3, background: '#ffffff' } }).composite(this.pieces).png().toBuffer();
      this.assertOpen();
      if (output.length > PAYLOAD_LIMIT) throw new Error('长截图图片体积过大，请减少截图帧数或缩小区域后重试。');
      const result = { dataUrl: `data:image/png;base64,${output.toString('base64')}`, width: this.rect.width, height: this.height };
      this.cancel(); return result;
    } finally { this.busy = false; }
  }

  cancel(): void { this.closed = true; this.previous = undefined; this.pieces = []; }
  private assertOpen(): void { if (this.closed || !this.previous) throw new Error('长截图会话已结束，请重新开始。'); }

  private async decode(dataUrl: string): Promise<Frame> {
    if (typeof dataUrl !== 'string' || dataUrl.length > 46_000_000) throw new Error('截图数据过大，请缩小采集区域。');
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
    if (!match?.[2] || match[2].length % 4) throw new Error('截图格式无效，请重新采集。');
    try {
      const input = Buffer.from(match[2], 'base64'); const source = sharp(input, { limitInputPixels: 64_000_000, failOn: 'error' }); const meta = await source.metadata();
      if (!meta.width || !meta.height || meta.format !== match[1] || this.rect.x + this.rect.width > meta.width || this.rect.y + this.rect.height > meta.height) throw new Error();
      const png = await source.extract({ left: this.rect.x, top: this.rect.y, width: this.rect.width, height: this.rect.height }).flatten({ background: '#ffffff' }).png().toBuffer();
      const feature = await sharp(png).resize(FEATURE_WIDTH, this.rect.height, { fit: 'fill' }).greyscale().raw().toBuffer();
      return { png, feature, screenWidth: meta.width, screenHeight: meta.height };
    } catch { throw new Error('截图无法解码，或选区已经超出屏幕范围，请重新框选。'); }
  }
}

function enforceSize(width: number, height: number): void {
  if (height > LONG_CAPTURE_MAX_HEIGHT || width > 32768 || width * height > LONG_CAPTURE_MAX_PIXELS) throw new Error('长截图已超过 32768 像素高度或 4000 万像素上限，请完成当前截图。');
}

/** Retains exact physical-pixel vertical coordinates while sampling columns. */
export function findVerticalOffset(previous: Uint8Array, next: Uint8Array, height: number): number {
  const sample = (offset: number) => {
    const overlap = height - offset; let all = 0; let texture = 0; let textured = 0; let samples = 0;
    for (let row = 0; row < 32; row++) {
      const y = Math.min(overlap - 1, Math.floor((row + .5) * overlap / 32));
      for (let x = 1; x < FEATURE_WIDTH - 1; x += 2) {
        const a = previous[(offset + y) * FEATURE_WIDTH + x] ?? 0; const b = next[y * FEATURE_WIDTH + x] ?? 0;
        const difference = Math.abs(a - b); all += difference; samples++;
        const edge = Math.abs(a - (previous[(offset + y) * FEATURE_WIDTH + x - 1] ?? 0)) + Math.abs(b - (next[y * FEATURE_WIDTH + x - 1] ?? 0));
        if (edge > 10) { texture += difference; textured++; }
      }
    }
    return { offset, score: textured < 16 ? Infinity : all / samples * .6 + texture / textured * .4, average: all / samples };
  };
  if (sample(0).average < .8) throw new Error('画面没有明显滚动。请向下滚动约半屏，保留部分重叠内容后再添加。');
  const minimumOverlap = Math.max(32, Math.floor(height * .12));
  const step = Math.max(1, Math.floor(height / 1000));
  const coarse = [];
  for (let offset = 1; offset <= height - minimumOverlap; offset += step) coarse.push(sample(offset));
  const candidates = new Set<number>();
  for (const item of coarse.sort((a, b) => a.score - b.score).slice(0, 12)) for (let delta = -step; delta <= step; delta++) if (item.offset + delta > 0 && item.offset + delta <= height - minimumOverlap) candidates.add(item.offset + delta);
  const ranked = [...candidates].map(sample).sort((a, b) => a.score - b.score);
  const best = ranked[0];
  if (!best || !Number.isFinite(best.score) || best.score > 11) throw new Error('无法可靠匹配重叠区域。请只框选滚动内容，排除固定栏，并每次向下滚动约半屏。');
  const alternative = ranked.find(item => Math.abs(item.offset - best.offset) > Math.max(4, height * .04));
  if (alternative && alternative.score < best.score + .4) throw new Error('页面内容重复，无法确定拼接位置。请减少滚动距离并保留更多独特内容后重试。');
  return best.offset;
}
