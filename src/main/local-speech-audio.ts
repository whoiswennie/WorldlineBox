import { spawn } from 'node:child_process';
import { SPEECH_CHUNK_SECONDS, SPEECH_MAX_TRANSCRIPT } from '../shared/local-speech';

const CHUNK_BYTES = SPEECH_CHUNK_SECONDS * 32000;
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
  let pending = Buffer.alloc(0);
  for await (const bytes of source) {
    signal.throwIfAborted(); let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const take = Math.min(CHUNK_BYTES - pending.length, bytes.length - offset);
      pending = Buffer.concat([pending, bytes.subarray(offset, offset + take)]); offset += take;
      if (pending.length === CHUNK_BYTES) {
        const cut = cutPoint(pending); yield pending.subarray(0, cut); pending = Buffer.from(pending.subarray(cut));
      }
    }
  }
  signal.throwIfAborted();
  if (pending.length % 2) throw Error('音频解码返回了不完整的采样。');
  if (pending.length) yield pending;
}

/** The decoded pipe pauses while each segment is recognized. Timeout/cancel also reaps ffmpeg. */
export async function transcribeSpeechFile(input: {
  ffmpeg: string; file: string; signal: AbortSignal; recognize(pcm: Buffer, signal: AbortSignal): Promise<string>;
}): Promise<{ text: string; audioSeconds: number }> {
  input.signal.throwIfAborted();
  const child = spawn(input.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input.file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '', bytes = 0, text = '';
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-2048); });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(input.signal.aborted ? '语音识别已取消。' : `音频解码失败：${diagnostic.slice(-240)}`))); });
  // Observe rejection even when cancellation interrupts the pipe before it is awaited.
  void exited.catch(() => undefined);
  const stop = () => { child.kill(); };
  input.signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const chunk of speechPcmChunks(child.stdout, input.signal)) {
      bytes += chunk.length;
      if (bytes > 32000 * 60 * 120) throw Error('单次转写最多处理 2 小时音频，请拆分后重试。');
      const part = await input.recognize(chunk, input.signal);
      if (text.length + part.length + 1 > SPEECH_MAX_TRANSCRIPT) throw Error('音频转写超过 64000 字，请拆分后重试。');
      if (part.trim()) text += (text ? '\n' : '') + part.trim();
    }
    await exited; input.signal.throwIfAborted();
    if (!bytes) throw Error('附件没有可识别的音轨。');
    return { text, audioSeconds: bytes / 32000 };
  } finally { input.signal.removeEventListener('abort', stop); stop(); await exited.catch(() => undefined); }
}
