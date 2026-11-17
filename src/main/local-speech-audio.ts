import { spawn } from 'node:child_process';
import { SPEECH_CHUNK_SECONDS, SPEECH_MAX_TRANSCRIPT } from '../shared/local-speech';

const CHUNK_BYTES = SPEECH_CHUNK_SECONDS * 32000;
const silence = Buffer.alloc(CHUNK_BYTES);
/** Prefer a quiet 100 ms window near the limit; continuous speech still has a hard ceiling. */
function cutPoint(pcm: Buffer): number {
  let best = CHUNK_BYTES, energy = Infinity;
  for (let start = CHUNK_BYTES - 64000; start <= CHUNK_BYTES - 3200; start += 640) {
    let sum = 0;
    for (let offset = start; offset < start + 3200; offset += 2) sum += Math.abs(pcm.readInt16LE(offset));
    if (sum < energy) { energy = sum; best = start + 1600; }
  }
  return energy / 1600 < 400 ? best : CHUNK_BYTES;
}

/** Consume with backpressure. No whole-file PCM buffer or unbounded segment queue. */
export async function* speechPcmChunks(source: AsyncIterable<Buffer>, signal: AbortSignal): AsyncGenerator<Buffer> {
  const pending = Buffer.allocUnsafe(CHUNK_BYTES);
  let length = 0;
  for await (const bytes of source) {
    signal.throwIfAborted(); let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const take = Math.min(CHUNK_BYTES - length, bytes.length - offset);
      bytes.copy(pending, length, offset, offset + take); offset += take; length += take;
      if (length === CHUNK_BYTES) {
        const cut = cutPoint(pending); yield Buffer.from(pending.subarray(0, cut));
        pending.copyWithin(0, cut); length -= cut;
      }
    }
  }
  signal.throwIfAborted();
  if (length % 2) throw Error('音频解码返回了不完整的采样。');
  if (length) yield pending.subarray(0, length);
}

export interface SpeechFileSegment { text: string; startSeconds: number; endSeconds: number }
export interface SpeechFileOptions { startSeconds?: number; maxSeconds?: number; alignToStart?: boolean }
export interface SpeechRecognition { text: string; spans?: SpeechFileSegment[] }

/** The decoded pipe pauses while each segment is recognized. Timeout/cancel also reaps ffmpeg. */
export async function transcribeSpeechFile(input: {
  ffmpeg: string; file: string; signal: AbortSignal; recognize(pcm: Buffer, signal: AbortSignal): Promise<string | SpeechRecognition>;
  writeSegment?(segment: SpeechFileSegment): Promise<void>;
  options?: SpeechFileOptions;
}): Promise<{ text: string; audioSeconds: number; truncated?: true }> {
  input.signal.throwIfAborted();
  const child = spawn(input.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'wav,mp3,mov,matroska,webm,avi,mpeg,mpegts,flac,ogg,aac,aiff,asf,amr,ape,ac3,eac3,flv,rm',
    ...(input.options?.startSeconds ? ['-ss', String(input.options.startSeconds)] : []),
    '-i', input.file, '-map', '0:a:0', '-vn',
    ...(input.options?.maxSeconds ? ['-t', String(input.options.maxSeconds)] : []),
    ...(input.options?.alignToStart ? ['-af', 'aresample=async=1:first_pts=0'] : []),
    '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '', bytes = 0, text = '';
  let truncated = false, watchdog: ReturnType<typeof setTimeout> | undefined;
  const timeout = new AbortController(), signal = AbortSignal.any([input.signal, timeout.signal]);
  const arm = () => { watchdog = setTimeout(() => timeout.abort(Error('音频解码长时间未取得进展。')), 60_000); };
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-2048); });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(input.signal.aborted ? '语音识别已取消。' : `音频解码失败：${diagnostic.slice(-240)}`))); });
  // Observe rejection even when cancellation interrupts the pipe before it is awaited.
  void exited.catch(() => undefined);
  const stop = () => { child.kill(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    arm();
    for await (const chunk of speechPcmChunks(child.stdout, signal)) {
      clearTimeout(watchdog);
      const startSeconds = bytes / 32000;
      bytes += chunk.length;
      const result = chunk.compare(silence, 0, chunk.length) === 0 ? '' : await input.recognize(chunk, signal);
      const part = (typeof result === 'string' ? result : result.text).trim();
      if (part) {
        const spans = typeof result === 'string' ? undefined : result.spans;
        if (input.writeSegment && spans?.length) {
          for (const span of spans) await input.writeSegment({ text: span.text, startSeconds: startSeconds + span.startSeconds, endSeconds: startSeconds + span.endSeconds });
        } else await input.writeSegment?.({ text: part, startSeconds, endSeconds: bytes / 32000 });
        const line = (text ? '\n' : '') + part;
        if (text.length + line.length <= (input.writeSegment ? 6000 : SPEECH_MAX_TRANSCRIPT) && !truncated) text += line;
        else if (input.writeSegment) truncated = true;
        else throw Error('音频转写超过 64000 字，请使用「转写音视频文件」保留全文。');
      }
      arm();
    }
    await exited; signal.throwIfAborted();
    if (!bytes) throw Error('附件没有可识别的音轨。');
    return { text, audioSeconds: bytes / 32000, ...(truncated ? { truncated: true } : {}) };
  } finally { clearTimeout(watchdog); signal.removeEventListener('abort', stop); stop(); await exited.catch(() => undefined); }
}
