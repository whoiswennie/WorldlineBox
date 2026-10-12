/**
 * Card covers are taken near 25% of the duration.
 *
 * `thumbnail=30` only inspects the first 30 frames (about one second) and
 * then keeps the frame that looks most like that opening. That reads as the
 * first frame. An earlier `thumbnail=300` window was also the opening, not a
 * fraction of the timeline; it was narrowed in the 2026-08-25 memory bound
 * (`scale` first, then 30 frames) and the test locked that filter string.
 * `-ss` before `-i` is a keyframe seek: FFmpeg jumps to the nearest preceding
 * keyframe and does not decode from the start. An output seek (`-ss` after
 * `-i`) would land closer to the exact timestamp and is slower.
 */
export const VIDEO_POSTER_SEEK_RATIO = 0.25;

/** Bumped when the cover timestamp changes, so older posters rebuild. */
export const VIDEO_POSTER_GENERATOR_TAG = "poster-seek-25";

export function videoPosterGeneratorVersion(ffmpegVersion: string): string {
  return `ffmpeg@${ffmpegVersion};${VIDEO_POSTER_GENERATOR_TAG}`;
}

/**
 * Seconds to seek before grabbing one poster frame.
 * `null` means the duration is unknown and the caller must not pretend the
 * opening frame is the cover.
 */
export function videoPosterSeekSeconds(durationSec: number): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const target = durationSec * VIDEO_POSTER_SEEK_RATIO;
  const latest = Math.max(0, durationSec - 0.05);
  const seconds = Math.min(target, latest);
  return Math.round(seconds * 1000) / 1000;
}

export function durationSecondsFromProbeStdout(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const plain = Number(trimmed);
  if (Number.isFinite(plain) && plain > 0) return plain;
  try {
    const parsed = JSON.parse(trimmed) as {
      format?: { duration?: string | number };
      streams?: Array<{ codec_type?: string; duration?: string | number }>;
    };
    const formatDuration = Number(parsed.format?.duration);
    if (Number.isFinite(formatDuration) && formatDuration > 0) return formatDuration;
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const streamDuration = Number(video?.duration);
    return Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : null;
  } catch {
    return null;
  }
}
