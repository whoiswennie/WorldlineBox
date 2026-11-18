import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { BOT_PRESENCE_CLIP_SECONDS } from '../../shared/companion-bot-media';
import type { LocalSpeechService } from '../local-speech-service';

function decode(ffmpeg: string, input: Uint8Array, args: string[], signal: AbortSignal, maxBuffer = 2 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-threads', '1', '-filter_threads', '1',
      '-f', 'webm', '-i', 'pipe:0', ...args, 'pipe:1'], { signal, timeout: 15_000, windowsHide: true, maxBuffer, encoding: 'buffer' },
    (error, output) => error ? reject(Error('陪伴录像片段解码失败。')) : resolve(output));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

function wav(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function presenceTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/** Bound candidate sampling across the whole source, then pick within temporal sections.
 * Near-duplicates should not crowd out a quieter part of the recording. */
export async function readPresenceVideo(ffmpeg: string, input: Uint8Array, signal: AbortSignal, duration = BOT_PRESENCE_CLIP_SECONDS) {
  return composePresenceFrames(await samplePresenceFrames(ffmpeg, input, duration, 24, signal), duration, signal);
}

export interface PresenceFrame { seconds: number; jpeg: Buffer; detail(signal: AbortSignal): Promise<Buffer> }
const tileWidth = 480, tileHeight = 270, labelHeight = 24;
export async function samplePresenceFrames(ffmpeg: string, input: Uint8Array, duration: number, limit: number, signal: AbortSignal): Promise<PresenceFrame[]> {
  const interval = Math.max(.7, duration / Math.max(1, limit - 1));
  const sampling = `fps=1/${interval.toFixed(6)}:start_time=0:round=up:eof_action=pass`;
  const filter = `${sampling},scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2`;
  const jpeg = await decode(ffmpeg, input, ['-map', '0:v:0', '-an', '-vf', filter, '-frames:v', String(limit), '-threads', '1', '-q:v', '4', '-f', 'mjpeg'], signal, 5 * 1024 * 1024);
  signal.throwIfAborted();
  const candidates: PresenceFrame[] = [];
  const startMark = Buffer.from([0xff, 0xd8]), endMark = Buffer.from([0xff, 0xd9]);
  let offset = 0;
  while (offset < jpeg.length) {
    const start = jpeg.indexOf(startMark, offset), end = jpeg.indexOf(endMark, start + 2);
    if (start !== offset || end < 0) throw Error('陪伴录像序列帧不完整。');
    offset = end + 2;
    const index = candidates.length;
    candidates.push({ seconds: Math.min(duration, index * interval), jpeg: jpeg.subarray(start, offset),
      detail: active => decode(ffmpeg, input, ['-map', '0:v:0', '-an', '-vf', `${sampling},select='eq(n,${index})'`,
        '-frames:v', '1', '-threads', '1', '-q:v', '2', '-f', 'mjpeg'], active, 10 * 1024 * 1024) });
  }
  if (!candidates.length) throw Error('陪伴录像没有可以观察的画面。');
  return candidates;
}

export async function composePresenceFrames(frames: readonly PresenceFrame[], duration: number, signal: AbortSignal, screenshots = false) {
  if (!frames.length) return [];
  const candidates: (PresenceFrame & { change: number; fingerprint: Buffer })[] = [];
  let previous: Buffer | undefined;
  for (const frame of frames) {
    signal.throwIfAborted();
    const fingerprint = await sharp(frame.jpeg).resize(20, 12, { fit: 'fill' }).greyscale().raw().toBuffer();
    const prior = previous;
    const change = prior ? fingerprint.reduce((sum, pixel, index) => sum + Math.abs(pixel - prior[index]!), 0) / (fingerprint.length * 255) : 0;
    candidates.push({ ...frame, change, fingerprint });
    previous = fingerprint;
  }
  const transitions = candidates.filter(frame => frame.change >= .09).length;
  const desired = Math.min(candidates.length, 10, screenshots ? 10 : 3 + Math.ceil(transitions / 2) + Math.floor(Math.log2(Math.max(1, duration / 20))));
  const middle = candidates.slice(1, -1), sections = desired - 2;
  const selected = candidates.length <= 2 ? candidates : [candidates[0]!, ...Array.from({ length: sections }, (_, index) => {
    const section = middle.slice(Math.floor(index * middle.length / sections), Math.floor((index + 1) * middle.length / sections));
    return section.reduce((best, candidate) => candidate.change > best.change + .015 ? candidate : best, section[Math.floor(section.length / 2)]!);
  }), candidates.at(-1)!];
  const sheets: { kind: 'sheet' | 'keyframe'; timestamps: string[]; jpeg: string }[] = [];
  const perSheet = selected.length <= 6 ? selected.length : Math.ceil(selected.length / 2);
  for (let start = screenshots && selected.length === 1 ? 1 : 0; start < selected.length; start += perSheet) {
    signal.throwIfAborted();
    const frames = selected.slice(start, start + perSheet), columns = frames.length >= 5 ? 3 : Math.min(frames.length, 2);
    const elapsed = frames.map(frame => presenceTime(frame.seconds));
    const layers = frames.flatMap((frame, index) => {
      const left = index % columns * tileWidth, top = Math.floor(index / columns) * (tileHeight + labelHeight);
      const label = Buffer.from(`<svg width="${tileWidth}" height="24" xmlns="http://www.w3.org/2000/svg"><text x="10" y="17" fill="#fff" font-size="14" font-family="monospace">${elapsed[index]}</text></svg>`);
      return [{ input: frame.jpeg, left, top }, { input: label, left, top: top + tileHeight }];
    });
    const contact = await sharp({ create: { width: columns * tileWidth, height: Math.ceil(frames.length / columns) * (tileHeight + labelHeight), channels: 3, background: '#141b29' } })
      .composite(layers).jpeg({ quality: 82 }).toBuffer();
    sheets.push({ kind: 'sheet', timestamps: elapsed, jpeg: contact.toString('base64') });
  }
  // Read full pixels only for the latest view and a visually distinct earlier moment.
  const last = candidates.at(-1)!;
  let other: typeof last | undefined, best = .025;
  for (const frame of candidates.slice(0, -1)) {
    const difference = frame.fingerprint.reduce((sum, value, i) => sum + Math.abs(value - last.fingerprint[i]!), 0) / (255 * last.fingerprint.length);
    if (difference > best) { best = difference; other = frame; }
  }
  for (const frame of other ? [other, last] : [last]) {
    signal.throwIfAborted();
    const original = await frame.detail(signal);
    let detail = original;
    for (const edge of [2560, 1920, 1280]) {
      if (detail.length <= 1024 * 1024) break;
      signal.throwIfAborted();
      detail = await sharp(original).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    }
    sheets.push({ kind: 'keyframe', timestamps: [presenceTime(frame.seconds)], jpeg: detail.toString('base64') });
  }
  return sheets;
}

export async function recognizePresenceAudio(ffmpeg: string, input: Uint8Array, speech: LocalSpeechService, id: string, signal: AbortSignal) {
  const pcm = await decode(ffmpeg, input, ['-map', '0:a:0', '-vn', '-t', String(BOT_PRESENCE_CLIP_SECONDS + 10), '-af', 'aresample=async=1:first_pts=0',
    '-ac', '1', '-ar', '16000', '-threads', '1', '-f', 's16le'], signal);
  signal.throwIfAborted();
  const durationSeconds = pcm.length / 32000;
  if (!pcm.some(byte => byte !== 0)) return { durationSeconds, segments: [] };
  const cancel = () => speech.cancel(id);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await speech.run(id, async local => {
      const segments = [];
      for await (const segment of speech.transcribeWaveSegments(wav(pcm), AbortSignal.any([signal, local]))) segments.push(segment);
      return { durationSeconds, segments };
    });
  } finally { signal.removeEventListener('abort', cancel); }
}
