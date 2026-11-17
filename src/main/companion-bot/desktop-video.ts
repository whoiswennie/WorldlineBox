import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp, { type OverlayOptions } from 'sharp';
import { RecordingStore } from '../capture-tools/recording-store';
import type { LocalSpeechService } from '../local-speech-service';
import type { SpeechFileSegment } from '../local-speech-audio';

const execute = promisify(execFile);
const frameWidth = 544, frameHeight = 306;

export function desktopCaptureTimestamp(seconds: number) {
  const milliseconds = Math.floor(Math.max(0, seconds) * 1000);
  return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export async function startDesktopVideo(temp: string, ffmpeg: string) {
  const base = path.resolve(temp);
  const directory = await mkdtemp(path.join(base, 'wlb-bot-video-'));
  if (path.dirname(path.resolve(directory)) !== base || !path.basename(directory).startsWith('wlb-bot-video-')) throw Error('录像临时目录无效。');
  const recorder = new RecordingStore({ downloadPath: directory, getFfmpeg: () => ffmpeg, changed: () => undefined });
  try {
    const id = await recorder.prepare('webm');
    return {
      append: (sequence: number, bytes: Uint8Array) => recorder.append(id, sequence, bytes),
      async finish(speech: LocalSpeechService, seconds: number, signal: AbortSignal) {
        const abort = () => { void recorder.cancel(id).catch(() => undefined); };
        signal.throwIfAborted();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const { path: input } = await recorder.finish(id);
          signal.throwIfAborted();
          const segments: SpeechFileSegment[] = [];
          const transcript = await speech.transcribeFile(input, signal, async segment => { segments.push(segment); }, { maxSeconds: seconds + 2, alignToStart: true });
          const frameCount = Math.min(9, Math.max(1, Math.ceil(transcript.audioSeconds)));
          const end = Math.max(0, transcript.audioSeconds - 0.65);
          const now = new Date();
          const prefix = `桌面录像 ${now.toTimeString().slice(0, 8).replace(/:/g, '-')}-${String(now.getMilliseconds()).padStart(3, '0')}`;
          const video = path.join(directory, prefix + '.webm');
          const image = path.join(directory, prefix + ' · 画面.jpg');
          const timeline = path.join(directory, prefix + ' · 声画时间线.txt');
          const columns = Math.min(3, frameCount);
          const composite: OverlayOptions[] = [];
          const frameStamps = [];
          for (let index = 0; index < frameCount; index++) {
            signal.throwIfAborted();
            const at = frameCount === 1 ? 0 : index * end / (frameCount - 1);
            const file = path.join(directory, `frame-${index}.jpg`);
            await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
              '-f', 'matroska', '-ss', at.toFixed(3), '-i', input, '-map', '0:v:0', '-an', '-frames:v', '1', '-filter_threads', '1',
              '-vf', `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=decrease`, '-threads', '1', '-q:v', '2', file],
            { signal, windowsHide: true, timeout: 12_000, maxBuffer: 64 * 1024 });
            const stamp = desktopCaptureTimestamp(at);
            const label = Buffer.from(`<svg width="142" height="30"><rect width="142" height="30" rx="4" fill="#142030" fill-opacity=".9"/><text x="10" y="21" fill="white" font-family="sans-serif" font-size="17">${stamp}</text></svg>`);
            const frame = await sharp(file).resize(frameWidth, frameHeight, { fit: 'contain', background: '#142030' })
              .composite([{ input: label, top: 8, left: 8 }]).jpeg({ quality: 88 }).toBuffer();
            composite.push({ input: frame, top: Math.floor(index / columns) * frameHeight, left: index % columns * frameWidth });
            frameStamps.push(stamp);
          }
          await sharp({ create: { width: columns * frameWidth, height: Math.ceil(frameCount / columns) * frameHeight, channels: 3, background: '#142030' } })
            .composite(composite).jpeg({ quality: 88 }).toFile(image);
          const text = [
            `录制时长 ${desktopCaptureTimestamp(transcript.audioSeconds)}`, `画面取样（从左到右、从上到下）${frameStamps.join('、')}`,
            '下列电脑声音转写与上方画面使用同一录像时间轴。', '',
            ...segments.map(segment => `[${desktopCaptureTimestamp(segment.startSeconds)} – ${desktopCaptureTimestamp(segment.endSeconds)}] ${segment.text}`),
            ...(segments.length ? [] : ['没有识别到可转写的对白。']),
          ].join('\n');
          await writeFile(timeline, text, { flag: 'wx', mode: 0o600 });
          await rename(input, video);
          signal.throwIfAborted();
          // Preserve the source recording while giving models a bounded, aligned image-and-text representation.
          return { paths: [video, image, timeline], text, seconds: transcript.audioSeconds };
        } finally { signal.removeEventListener('abort', abort); }
      },
      async dispose() {
        await recorder.cancel(id).catch(() => undefined);
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  } catch (error) {
    await recorder.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}
