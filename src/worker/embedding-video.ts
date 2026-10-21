import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EMBEDDING_VIDEO_MAX_WINDOWS, EMBEDDING_VIDEO_WINDOW_SECONDS } from '../shared/embedding/profile';

const PREFIX = 'worldlinebox-semantic-video-';
const MAX_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
export type EmbeddingVideoWindow = { bytesBase64: string; audioBase64?: string };

/** Preserve all short clips; uniformly cover the complete timeline when a long clip exceeds the bounded window budget. */
export function embeddingVideoWindowStarts(duration: number, seconds = EMBEDDING_VIDEO_WINDOW_SECONDS, maximum = EMBEDDING_VIDEO_MAX_WINDOWS): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(maximum) || maximum < 1 || maximum > 16 || seconds <= 0) throw new Error('Invalid video duration or window budget.');
  const count = Math.min(maximum, Math.ceil(duration / seconds));
  if (count === 1) return [0];
  if (duration <= seconds * maximum) return Array.from({ length: count }, (_, index) => index * seconds);
  return Array.from({ length: count }, (_, index) => index * (duration - seconds) / (count - 1));
}

export async function prepareEmbeddingVideoWindows(input: {
  sourcePath: string; ffmpegPath: string; ffprobePath: string; signal?: AbortSignal;
  windowSeconds?: number; maxWindows?: number;
}): Promise<EmbeddingVideoWindow[]> {
  input.signal?.throwIfAborted();
  const probe = await promisify(execFile)(input.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', input.sourcePath],
    { windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024, signal: input.signal });
  const metadata = JSON.parse(probe.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type: string }> };
  if (!metadata.streams?.some(stream => stream.codec_type === 'video')) throw new Error('The asset contains no video stream.');
  const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
  const duration = Number(metadata.format?.duration), seconds = input.windowSeconds ?? EMBEDDING_VIDEO_WINDOW_SECONDS;
  const starts = embeddingVideoWindowStarts(duration, seconds, input.maxWindows);
  const free = await statfs(tmpdir());
  if (free.bavail * free.bsize < MAX_BATCH_BYTES * 2) throw new Error('Not enough temporary space for video analysis.');
  const directory = await mkdtemp(path.join(tmpdir(), PREFIX));
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith(PREFIX)) throw new Error('Invalid video preparation directory.');
  let totalBytes = 0;
  try {
    const windows: EmbeddingVideoWindow[] = [];
    for (let index = 0; index < starts.length; index++) {
      input.signal?.throwIfAborted();
      const videoPath = path.join(directory, `${index}.mp4`), audioPath = path.join(directory, `${index}.wav`);
      const length = Math.min(seconds, duration - starts[index]!);
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(starts[index]), '-i', input.sourcePath,
        '-t', String(length), '-map', '0:v:0', '-an', '-vf', "fps=1:start_time=0:round=up,scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease",
        '-c:v', 'mpeg4', '-q:v', '2', '-movflags', '+faststart', videoPath,
        ...(hasAudio ? ['-t', String(length), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath] : [])];
      await promisify(execFile)(input.ffmpegPath, args, { windowsHide: true, timeout: 60_000, maxBuffer: 128 * 1024, signal: input.signal });
      const videoStat = await stat(videoPath), audioStat = hasAudio ? await stat(audioPath) : undefined;
      totalBytes += videoStat.size + (audioStat?.size ?? 0);
      if (videoStat.size <= 0 || videoStat.size > MAX_WINDOW_BYTES || (audioStat?.size ?? 0) > 2 * 1024 * 1024 || totalBytes > MAX_BATCH_BYTES)
        throw new Error('The video windows exceeded the bounded embedding input budget.');
      // A video can outlast its audio stream. Do not send header-only silent WAV files to the encoder.
      windows.push({ bytesBase64: (await readFile(videoPath)).toString('base64'),
        ...((audioStat?.size ?? 0) > 1024 ? { audioBase64: (await readFile(audioPath)).toString('base64') } : {}) });
      await rm(videoPath); if (hasAudio) await rm(audioPath);
    }
    return windows;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
