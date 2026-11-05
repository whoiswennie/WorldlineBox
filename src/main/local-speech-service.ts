import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { SPEECH_MAX_TRANSCRIPT, validateSpeechWave, type LocalSpeechStatus, type LocalSpeechTranscript } from '../shared/local-speech';
import { speechPcmChunks, transcribeSpeechFile } from './local-speech-audio';

interface Asset { path: string; url: string; bytes: number; sha256: string }
interface Options { root: string; resources: string; appPath: string; ffmpeg?: () => string | undefined; fetchFn?: typeof fetch }
interface Worker { child: ChildProcessWithoutNullStreams; exited: Promise<void>; read?: { resolve(value: { text?: string; ready?: boolean; error?: string }): void; reject(error: Error): void } }
const supportedPlatforms = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

/** Application-wide CPU service. One worker, at most three accepted operations, five-minute idle unload. */
export class LocalSpeechService {
  private state: LocalSpeechStatus = { phase: 'unprepared' };
  private assets?: string;
  private preparing?: Promise<void>;
  private worker?: Worker;
  private stopping?: Promise<void>;
  private idle?: ReturnType<typeof setTimeout>;
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Map<string, AbortController>();
  private disposed = false;
  constructor(private readonly options: Options) {}
  status(): LocalSpeechStatus { return { ...this.state }; }
  cancel(id: string): void { this.active.get(id)?.abort(); }
  async close(): Promise<void> { this.disposed = true; for (const work of this.active.values()) work.abort(); await this.tail.catch(() => undefined); await this.stop(); }
  async run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw Error('本地语音服务已关闭。');
    if (this.active.has(id)) throw Error('语音请求已在处理中。');
    if (this.active.size >= 3) throw Error('语音识别繁忙，请稍后重试。');
    const controller = new AbortController(); this.active.set(id, controller);
    const timeout = setTimeout(() => controller.abort(), 20 * 60_000);
    const result = this.tail.catch(() => undefined).then(async () => { controller.signal.throwIfAborted(); return work(controller.signal); });
    this.tail = result;
    try { return await result; }
    finally { clearTimeout(timeout); this.active.delete(id); this.scheduleIdle(); }
  }
  private scheduleIdle(): void {
    clearTimeout(this.idle);
    if (!this.active.size && this.worker) { this.state = { phase: 'ready' }; this.idle = setTimeout(() => { void this.stop(); }, 300_000); this.idle.unref(); }
  }
  private async verified(file: string, asset: Asset): Promise<boolean> {
    try {
      if ((await stat(file)).size !== asset.bytes) return false;
      const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
      return digest.digest('hex') === asset.sha256;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async prepare(signal: AbortSignal): Promise<void> {
    if (!supportedPlatforms.includes(`${process.platform}-${process.arch}`)) throw Error('此平台尚不支持本地语音识别。');
    if (this.assets) return;
    if (this.preparing) return this.preparing;
    this.preparing = this.acquire(signal);
    try { await this.preparing; } finally { this.preparing = undefined; }
  }
  private async acquire(signal: AbortSignal): Promise<void> {
    this.state = { phase: 'preparing', completedBytes: 0 };
    try {
      const bundle = path.join(this.options.resources, 'speech-models');
      const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8')) as { files: Asset[] };
      const totalBytes = manifest.files.reduce((sum, item) => sum + item.bytes, 0);
      if ((await Promise.all(manifest.files.map(item => this.verified(path.join(bundle, item.path), item)))).every(Boolean)) {
        signal.throwIfAborted(); this.assets = bundle; this.state = { phase: 'standby' }; return;
      }
      const directory = path.join(this.options.root, 'sensevoice-int8'); await mkdir(directory, { recursive: true });
      let completed = 0;
      for (const asset of manifest.files) {
        signal.throwIfAborted(); const target = path.join(directory, asset.path);
        if (!await this.verified(target, asset)) {
          let failure: unknown;
          for (const origin of ['https://huggingface.co', 'https://hf-mirror.com']) {
            const temporary = target + '.' + randomUUID() + '.part';
            try {
              const fetchFn = this.options.fetchFn ?? fetch;
              const response = await fetchFn(asset.url.replace('https://huggingface.co', origin), { signal });
              if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(`模型下载失败（HTTP ${response.status}）。`); }
              const digest = createHash('sha256'); let received = 0;
              const progress = new Transform({ transform: (chunk: Buffer, _encoding, next) => {
                received += chunk.length;
                if (received > asset.bytes) { next(Error('模型下载大小不符。')); return; }
                digest.update(chunk); this.state = { phase: 'preparing', completedBytes: completed + received, totalBytes }; next(null, chunk);
              } });
              await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporary, { flags: 'wx' }), { signal });
              if (received !== asset.bytes || digest.digest('hex') !== asset.sha256) throw Error('模型校验失败，请重试。');
              await rename(temporary, target); failure = undefined; break;
            } catch (error) { failure = error; if (signal.aborted) throw error; }
            finally { await rm(temporary, { force: true }); }
          }
          if (failure) throw failure;
        }
        completed += asset.bytes; this.state = { phase: 'preparing', completedBytes: completed, totalBytes };
      }
      signal.throwIfAborted(); this.assets = directory; this.state = { phase: 'standby' };
    } catch (error) { this.state = { phase: 'failed', error: error instanceof Error ? error.message : '模型准备失败。' }; throw error; }
  }
  private read(worker: Worker, signal: AbortSignal): Promise<{ text?: string; ready?: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.child.kill(); reject(Error('本地语音模型响应超时。')); }, 120_000);
      const abort = () => { worker.child.kill(); reject(signal.reason instanceof Error ? signal.reason : Error('已取消语音识别。')); };
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); worker.read = undefined; };
      worker.read = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  private async start(signal: AbortSignal): Promise<Worker> {
    clearTimeout(this.idle); await this.stopping; await this.prepare(signal); signal.throwIfAborted();
    if (this.worker) return this.worker;
    this.state = { phase: 'loading' };
    const modulePath = createRequire(path.join(this.options.appPath, 'package.json')).resolve('sherpa-onnx-node');
    const config = { modulePath, model: path.join(this.assets!, 'model.int8.onnx'), tokens: path.join(this.assets!, 'tokens.txt'), vad: path.join(this.assets!, 'silero_vad.onnx') };
    const child = spawn(process.execPath, ['--expose-gc', path.join(this.options.resources, 'speech-runtime', 'worker.cjs'), JSON.stringify(config)],
      { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let finish!: () => void; const worker: Worker = { child, exited: new Promise(resolve => { finish = resolve; }) }; this.worker = worker;
    let diagnostic = '';
    child.stderr.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(-2000); });
    child.stdin.on('error', error => worker.read?.reject(error));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        if (line.length > 300000) throw Error('语音模型返回内容过长。');
        const value = JSON.parse(line) as { text?: string; ready?: boolean; error?: string };
        worker.read?.resolve(value);
      } catch { worker.read?.reject(Error('语音模型返回无效数据。')); child.kill(); }
    });
    child.once('error', error => { worker.read?.reject(error); finish(); });
    child.once('exit', () => {
      lines.close(); if (this.worker === worker) { this.worker = undefined; this.state = { phase: 'standby' }; }
      worker.read?.reject(Error('语音进程已退出。' + diagnostic.slice(-240))); finish();
    });
    try { const ready = await this.read(worker, signal); if (!ready.ready) throw Error('本地语音模型启动失败。'); return worker; }
    catch (error) { await this.stop(); throw error; }
  }
  private async recognize(pcm: Buffer, signal: AbortSignal): Promise<string> {
    const worker = await this.start(signal); this.state = { phase: 'transcribing' };
    try {
      const response = this.read(worker, signal);
      worker.child.stdin.write(JSON.stringify({ pcm: pcm.toString('base64') }) + '\n');
      const value = await response;
      if (value.error || typeof value.text !== 'string' || value.text.length > SPEECH_MAX_TRANSCRIPT) throw Error(value.error || '语音识别返回无效内容。');
      return value.text;
    } catch (error) { await this.stop(); throw error; }
  }
  async transcribeWave(bytes: Buffer, signal: AbortSignal): Promise<LocalSpeechTranscript> {
    const audioSeconds = validateSpeechWave(bytes); let text = '';
    for await (const chunk of speechPcmChunks(Readable.from([bytes.subarray(44)]), signal)) {
      const part = await this.recognize(chunk, signal);
      if (text.length + part.length + 1 > SPEECH_MAX_TRANSCRIPT) throw Error('转写结果过长，请缩短录音。');
      if (part) text += (text ? '\n' : '') + part;
    }
    return { text, audioSeconds, engine: 'sensevoice-int8-cpu' };
  }
  async transcribeFile(file: string, signal: AbortSignal): Promise<LocalSpeechTranscript> {
    await access(file); const ffmpeg = this.options.ffmpeg?.(); if (!ffmpeg) throw Error('音频解码组件尚未准备好。');
    await this.start(signal);
    const result = await transcribeSpeechFile({ ffmpeg, file, signal, recognize: (pcm, abort) => this.recognize(pcm, abort) });
    return { ...result, engine: 'sensevoice-int8-cpu' };
  }
  private async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    clearTimeout(this.idle); const worker = this.worker; if (!worker) return;
    this.worker = undefined;
    const stopping = (async () => {
      worker.child.kill(); await worker.exited;
      if (!this.disposed) this.state = { phase: this.assets ? 'standby' : 'unprepared' };
    })();
    this.stopping = stopping;
    try { await stopping; } finally { if (this.stopping === stopping) this.stopping = undefined; }
  }
}
