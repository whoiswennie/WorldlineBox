import { freemem } from 'node:os';

export const MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;
export const MEDIA_FFMPEG_LOW_MEMORY_LIMIT = 1 as const;
export const MEDIA_FFMPEG_NORMAL_MEMORY_LIMIT = 2 as const;

export type MediaFfmpegConcurrencyLimit =
  | typeof MEDIA_FFMPEG_LOW_MEMORY_LIMIT
  | typeof MEDIA_FFMPEG_NORMAL_MEMORY_LIMIT;

/** System memory outside the V8 heap; invalid or unavailable samples stay unknown. */
export function systemAvailablePhysicalMemoryBytes(): number | undefined {
  try {
    const bytes = freemem();
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function mediaFfmpegConcurrencyLimit(
  availableBytes: number | undefined,
): MediaFfmpegConcurrencyLimit {
  return Number.isSafeInteger(availableBytes)
    && availableBytes! >= MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES
    ? MEDIA_FFMPEG_NORMAL_MEMORY_LIMIT
    : MEDIA_FFMPEG_LOW_MEMORY_LIMIT;
}
