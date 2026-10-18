import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { CAPTURE_GIF_LIMIT_SECONDS, CAPTURE_VIDEO_LIMIT_SECONDS, type CaptureRecordingState } from '../../shared/capture-tools';

export const MAX_RECORDING_CHUNK_BYTES = 16 * 1024 * 1024;
export const MAX_RECORDING_PENDING_BYTES = 32 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024 * 1024;
type Format = CaptureRecordingState['format'];
interface RecordingSession {
  state: CaptureRecordingState; handle: FileHandle; input: string; sequence: number; pendingBytes: number;
  queue: Promise<void>; started: number; deadline?: ReturnType<typeof setTimeout>; fallback?: ReturnType<typeof setTimeout>;
  process?: ChildProcess; finishing?: Promise<{ path: string }>; closed: boolean; cancelled: boolean; committing: boolean;
  prefix: Buffer;
}
export interface RecordingStoreOptions {
  downloadPath: string;
  getFfmpeg(): string | undefined | Promise<string | undefined>;
  changed(state: CaptureRecordingState): void;
  onLimit?(id: string): void;
}
/** Fixed arguments only. Inputs and outputs are owned files, never shell text. */
export function recordingConversionArgs(input: string, output: string, format: 'mp4' | 'gif'): string[] {
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', input];
  return format === 'mp4' ? [...common, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libopenh264', '-b:v', '6M', '-pix_fmt', 'yuv420p',
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', output]
    : [...common, '-t', String(CAPTURE_GIF_LIMIT_SECONDS), '-an', '-filter_complex',
      'fps=12,scale=min(960\\,iw):-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop', '0', '-f', 'gif', output];
}

/** Streams MediaRecorder data to disk. No unbounded Blob or base64 accumulation. */
export class RecordingStore {
  private session?: RecordingSession;
  private preparing = false;
  private stopping = false;
  constructor(private readonly options: RecordingStoreOptions) {}
  state(): CaptureRecordingState | undefined { return this.session ? structuredClone(this.session.state) : undefined; }
  private publish(session: RecordingSession): void { if (this.session === session) this.options.changed(structuredClone(session.state)); }
  private active(id: string): RecordingSession {
    const session = this.session;
    if (!session || session.state.id !== id) throw Error('找不到此录屏任务。');
    return session;
  }
  private clearTimers(session: RecordingSession): void { clearTimeout(session.deadline); clearTimeout(session.fallback); }
  private async close(session: RecordingSession): Promise<void> { if (!session.closed) { session.closed = true; await session.handle.close(); } }
  private async fail(session: RecordingSession, error: unknown): Promise<void> {
    this.clearTimers(session); session.process?.kill();
    await this.close(session).catch(() => undefined);
    if (session.cancelled) return;
    session.state.status = 'failed'; session.state.path = session.input;
    // FFmpeg stderr may include full local paths. Keep the UI error concise;
    // the recoverable source is exposed separately through the reveal action.
    session.state.error = error instanceof Error ? error.message.slice(0, 1000) : '录屏保存失败。'; this.publish(session);
  }
  async prepare(format: Format): Promise<string> {
    if (this.stopping || this.preparing || this.session && ['recording', 'paused', 'finalizing'].includes(this.session.state.status)) throw Error('请先结束当前录屏。');
    if (!['mp4', 'webm', 'gif'].includes(format)) throw Error('录屏格式无效。');
    this.preparing = true;
    try {
      if (format !== 'webm' && !await this.options.getFfmpeg()) throw Error('缺少 FFmpeg，无法生成所选格式，请选择 WebM。');
      const directory = path.resolve(this.options.downloadPath); await mkdir(directory, { recursive: true });
      const id = randomUUID(); const input = path.join(directory, '.WorldlineBox-Recording-' + id + '.webm.part');
      const handle = await open(input, 'wx', 0o600);
      if (this.stopping) { await handle.close(); await rm(input, { force: true }); throw Error('录屏工具正在关闭。'); }
      const started = Date.now();
      const session: RecordingSession = { state: { id, format, status: 'recording', bytes: 0, startedAt: new Date(started).toISOString() },
        handle, input, sequence: 0, pendingBytes: 0, queue: Promise.resolve(), started, closed: false, cancelled: false, committing: false, prefix: Buffer.alloc(0) };
      this.session = session;
      session.deadline = setTimeout(() => {
        if (!['recording', 'paused'].includes(session.state.status)) return;
        session.state.error = '已到达录制时长上限，正在结束录制。'; this.publish(session);
        try { this.options.onLimit?.(session.state.id); } catch { /* The fallback also finishes if the UI was closed. */ }
        session.fallback = setTimeout(() => { void this.finish(session.state.id).catch(() => undefined); }, 5000); session.fallback.unref();
      }, (format === 'gif' ? CAPTURE_GIF_LIMIT_SECONDS : CAPTURE_VIDEO_LIMIT_SECONDS) * 1000); session.deadline.unref();
      this.publish(session); return id;
    } finally { this.preparing = false; }
  }
  append(id: string, sequence: number, data: Uint8Array): Promise<void> {
    const session = this.active(id);
    if (session.cancelled || !['recording', 'paused'].includes(session.state.status)) return Promise.reject(Error('此录屏已停止接收数据。'));
    if (!Number.isSafeInteger(sequence) || sequence !== session.sequence) return Promise.reject(Error('录屏数据顺序错误，请重新开始录制。'));
    if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_RECORDING_CHUNK_BYTES) return Promise.reject(Error('录屏数据块超过 16 MiB 上限或为空。'));
    if (session.pendingBytes + data.byteLength > MAX_RECORDING_PENDING_BYTES) return Promise.reject(Error('磁盘写入繁忙，请降低录制质量后重试。'));
    if (session.state.bytes + session.pendingBytes + data.byteLength > MAX_RECORDING_BYTES) return Promise.reject(Error('录屏文件已达到 16 GiB 上限。'));
    const durationLimit = session.state.format === 'gif' ? CAPTURE_GIF_LIMIT_SECONDS : CAPTURE_VIDEO_LIMIT_SECONDS;
    if (Date.now() - session.started > durationLimit * 1000 + 5000) return Promise.reject(Error('已达到录屏时长上限。'));
    // MediaRecorder can emit its EBML signature across several dataavailable
    // events (including a one-byte first Blob). Retain at most four signature
    // bytes, validate each arriving prefix, and stream every accepted byte in
    // its original order rather than buffering a whole recording or Blob.
    if (session.prefix.length < 4) {
      const prefix = Buffer.concat([session.prefix, Buffer.from(data.subarray(0, 4 - session.prefix.length))]);
      if (!prefix.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).subarray(0, prefix.length))) return Promise.reject(Error('录屏内容不是有效的 WebM 数据。'));
      session.prefix = prefix;
    }
    const bytes = Buffer.from(data); session.sequence++; session.pendingBytes += bytes.length;
    const writing = session.queue.then(async () => {
      if (session.cancelled) throw Error('录屏已取消。');
      let offset = 0;
      while (offset < bytes.length) { const result = await session.handle.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw Error('磁盘未接受录屏数据。'); offset += result.bytesWritten; }
      session.state.bytes += bytes.length; this.publish(session);
    });
    session.queue = writing;
    // Attach a rejection handler immediately, even if the caller is torn down
    // before its IPC response arrives. Subsequent queued writes also reject.
    void writing.catch(error => this.fail(session, error));
    return writing.finally(() => { session.pendingBytes -= bytes.length; });
  }
  pause(id: string, paused: boolean): void {
    const session = this.active(id); if (!['recording', 'paused'].includes(session.state.status)) throw Error('当前录屏不能暂停。');
    session.state.status = paused ? 'paused' : 'recording'; this.publish(session);
  }
  finish(id: string): Promise<{ path: string }> {
    const session = this.active(id);
    if (session.finishing) return session.finishing;
    if (session.state.status === 'saved' && session.state.path) return Promise.resolve({ path: session.state.path });
    if (!['recording', 'paused'].includes(session.state.status)) return Promise.reject(Error('当前录屏无法完成，请重新开始。'));
    session.state.status = 'finalizing'; this.clearTimers(session); this.publish(session);
    session.finishing = this.complete(session);
    return session.finishing;
  }
  private async complete(session: RecordingSession): Promise<{ path: string }> {
    let converted: string | undefined;
    try {
      await session.queue;
      if (session.cancelled) throw Error('录屏已取消。');
      if (!session.state.bytes) throw Error('录屏没有收到视频数据。');
      if (session.prefix.length !== 4) throw Error('录屏的 WebM 文件头不完整，原始数据已保留。');
      await session.handle.sync(); await this.close(session);
      const format = session.state.format;
      let source = session.input;
      if (this.stopping) throw Error('应用退出，原始 WebM 已保留。');
      if (format !== 'webm') {
        const ffmpeg = await this.options.getFfmpeg(); if (!ffmpeg) throw Error('缺少 FFmpeg，原始录屏已保留，可稍后重新转换。');
        converted = path.join(path.dirname(session.input), '.WorldlineBox-Converted-' + session.state.id + '.' + format + '.part');
        await this.convert(session, ffmpeg, converted, format); source = converted;
      }
      if (session.cancelled) throw Error('录屏已取消。');
      if (this.stopping) throw Error('应用退出，原始 WebM 已保留。');
      const stamp = session.state.startedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const output = path.join(path.dirname(session.input), 'WorldlineBox-Recording-' + stamp + '-' + session.state.id.slice(0, 8) + '.' + format);
      session.committing = true;
      await copyFile(source, output, constants.COPYFILE_EXCL);
      const handle = await open(output, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      session.state.status = 'saved'; session.state.path = output; session.state.error = undefined;
      // The final file is durable at this point. A scanner temporarily locking a
      // staging file must not turn a successful recording into a failed one or
      // replace its path with a source that may already have been removed.
      await rm(session.input, { force: true }).catch(() => undefined);
      if (converted) await rm(converted, { force: true }).catch(() => undefined); this.publish(session);
      return { path: output };
    } catch (error) {
      session.committing = false;
      if (converted) await rm(converted, { force: true }).catch(() => undefined);
      await this.fail(session, error); throw error;
    }
  }
  private convert(session: RecordingSession, ffmpeg: string, output: string, format: 'mp4' | 'gif'): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, recordingConversionArgs(session.input, output, format), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      session.process = child;
      // Drain stderr without retaining arbitrary amounts of process output.
      child.stderr?.resume();
      const timer = setTimeout(() => { child.kill(); reject(Error('录屏转换超时，原始 WebM 已保留。')); }, format === 'gif' ? 5 * 60_000 : 30 * 60_000); timer.unref();
      child.once('error', () => { clearTimeout(timer); reject(Error('无法启动 FFmpeg，原始 WebM 已保留。')); });
      child.once('close', code => {
        clearTimeout(timer); session.process = undefined;
        if (session.cancelled) reject(Error('录屏已取消。'));
        else if (code !== 0) reject(Error('录屏转换失败，原始 WebM 已保留。'));
        else void stat(output).then(info => info.size > 0 ? resolve() : reject(Error('录屏转换未生成有效文件。')), reject);
      });
    });
  }
  async cancel(id: string): Promise<void> {
    const session = this.active(id); if (session.state.status === 'saved') throw Error('已保存的录屏不能取消。');
    if (session.committing) throw Error('录屏正在完成保存，请稍后查看生成的文件。');
    session.cancelled = true; this.clearTimers(session); session.process?.kill();
    await session.queue.catch(() => undefined); await session.finishing?.catch(() => undefined); await this.close(session).catch(() => undefined);
    await rm(session.input, { force: true }); session.state.status = 'cancelled'; session.state.path = undefined; session.state.error = undefined; this.publish(session);
  }
  async shutdown(): Promise<void> {
    this.stopping = true; const session = this.session;
    if (!session || ['saved', 'cancelled'].includes(session.state.status)) return;
    this.clearTimers(session); session.process?.kill();
    if (session.state.status === 'finalizing') await session.finishing?.catch(() => undefined);
    else { await session.queue.catch(() => undefined); if (session.state.bytes) await session.handle.sync().catch(() => undefined); await this.close(session).catch(() => undefined);
      session.state.status = 'failed'; session.state.path = session.input; session.state.error = '应用退出，原始 WebM 已保留。'; this.publish(session); }
  }
}
