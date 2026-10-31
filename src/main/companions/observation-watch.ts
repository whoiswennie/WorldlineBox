import sharp, { type OverlayOptions } from 'sharp';
import type { CompanionObservationBinding } from './agenda-observation';

export const COMPANION_WATCH_MAX_CLIP_BYTES = 24 * 1024 * 1024;
export const COMPANION_WATCH_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export interface CompanionObservationRecordedFrame { bytes: Uint8Array; offsetMs: number }
export interface CompanionObservationRecording {
  bytes: Uint8Array; mime: 'video/webm'; startedAt: string; endedAt: string; durationMs: number; width: number; height: number;
  frames: CompanionObservationRecordedFrame[];
}
export type CompanionObservationWatchDriver = (input: {
  companionId: string; source: CompanionObservationBinding; seconds: number; frameCount: number; signal: AbortSignal;
  verify(): Promise<void>;
}) => Promise<CompanionObservationRecording>;

/** Compose actual sampled pixels; labels name measured offsets rather than
 * implying that a screenshot describes every moment of the recorded clip. */
export async function companionObservationStoryboard(frames: readonly CompanionObservationRecordedFrame[]): Promise<Uint8Array> {
  if (frames.length < 2 || frames.length > 12) throw new Error('连续观察的实际序列帧数量无效。');
  const columns = Math.min(3, frames.length), width = 360, pictureHeight = 216, tileHeight = 244;
  const overlays: OverlayOptions[] = [];
  for (const [index, frame] of frames.entries()) {
    if (!frame.bytes.byteLength || frame.bytes.byteLength > COMPANION_WATCH_MAX_FRAME_BYTES || !Number.isFinite(frame.offsetMs) || frame.offsetMs < 0)
      throw new Error('连续观察帧或真实时间戳无效。');
    const left = index % columns * width, top = Math.floor(index / columns) * tileHeight;
    overlays.push({ input: await sharp(frame.bytes, { limitInputPixels: 40_000_000 }).resize(width, pictureHeight, { fit: 'contain', background: '#161b24' }).png().toBuffer(), left, top });
    overlays.push({ input: Buffer.from(`<svg width="${width}" height="28"><rect width="100%" height="100%" fill="#161b24"/><text x="12" y="19" fill="#edf2fa" font-family="sans-serif" font-size="14">Frame ${index + 1}   +${(frame.offsetMs / 1000).toFixed(3)}s</text></svg>`), left, top: top + pictureHeight });
  }
  return sharp({ create: { width: columns * width, height: Math.ceil(frames.length / columns) * tileHeight, channels: 4, background: '#161b24' } })
    .composite(overlays).png().toBuffer();
}
