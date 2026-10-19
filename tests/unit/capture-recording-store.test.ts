import path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import type * as FilePromises from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECORDING_CHUNK_BYTES, RecordingStore, recordingConversionArgs } from '../../src/main/capture-tools/recording-store';
import type { CaptureRecordingState } from '../../src/shared/capture-tools';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FilePromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-recording-')); roots.push(root); return root; }
const webm = Buffer.from('1a45dfa30102030405060708090a0b0c0d0e0f10111213', 'hex');
async function fixture() { const downloadPath = await directory(); const changes: CaptureRecordingState[] = [];
  const store = new RecordingStore({ downloadPath, getFfmpeg: () => undefined, changed: state => changes.push(state) });
  return { store, downloadPath, changes }; }

describe('bounded streamed recordings', () => {
  it('serializes chunks to a unique WebM file and publishes pause/finalize/save states', async () => {
    const { store, changes, downloadPath } = await fixture();
    const id = await store.prepare('webm');
    const first = store.append(id, 0, webm.subarray(0, 10)); const second = store.append(id, 1, webm.subarray(10));
    await Promise.all([first, second]); store.pause(id, true); expect(store.state()?.status).toBe('paused'); store.pause(id, false);
    const result = await store.finish(id); expect(path.dirname(result.path)).toBe(downloadPath); expect(result.path.endsWith('.webm')).toBe(true);
    expect(await readFile(result.path)).toEqual(webm); expect(await readdir(downloadPath)).toEqual([path.basename(result.path)]);
    expect(changes.map(state => state.status)).toEqual(expect.arrayContaining(['recording', 'paused', 'finalizing', 'saved']));
    expect(await store.finish(id)).toEqual(result); await expect(store.append(id, 2, webm)).rejects.toThrow(); await store.shutdown();
  });

  it('rejects corrupt first chunks, out-of-order data, oversized blocks and simultaneous starts', async () => {
    const { store } = await fixture(); const preparing = store.prepare('webm'); await expect(store.prepare('webm')).rejects.toThrow(); const id = await preparing;
    await expect(store.append(id, 0, Buffer.from('not WebM'))).rejects.toThrow('WebM');
    await expect(store.append(id, 1, webm)).rejects.toThrow('顺序');
    await expect(store.append(id, 0, new Uint8Array(MAX_RECORDING_CHUNK_BYTES + 1))).rejects.toThrow('16 MiB');
    await store.append(id, 0, webm); await expect(store.append(id, 0, webm)).rejects.toThrow('顺序');
    await store.cancel(id); expect(store.state()?.status).toBe('cancelled'); await store.shutdown();
  });

  it('validates the WebM signature across one-byte MediaRecorder fragments and preserves all ordered bytes', async () => {
    const { store } = await fixture(); const id = await store.prepare('webm');
    await store.append(id, 0, webm.subarray(0, 1)); await store.append(id, 1, webm.subarray(1, 3));
    await store.append(id, 2, webm.subarray(3, 4)); await store.append(id, 3, webm.subarray(4));
    const result = await store.finish(id); expect(await readFile(result.path)).toEqual(webm); await store.shutdown();
  });

  it('rejects a malformed split signature and refuses to save an incomplete signature as a video', async () => {
    const { store } = await fixture(); const id = await store.prepare('webm');
    await store.append(id, 0, webm.subarray(0, 1));
    await expect(store.append(id, 1, new Uint8Array([0x00, 0xdf, 0xa3]))).rejects.toThrow('WebM');
    await expect(store.finish(id)).rejects.toThrow('文件头不完整');
    expect(store.state()?.status).toBe('failed'); expect(await readFile(store.state()!.path!)).toEqual(webm.subarray(0, 1)); await store.shutdown();
  });

  it('copies incoming bytes before enqueueing and cancels without leaving a partial file', async () => {
    const { store, downloadPath } = await fixture(); const id = await store.prepare('webm'); const incoming = Uint8Array.from(webm);
    const writing = store.append(id, 0, incoming); incoming.fill(0); await writing;
    const result = await store.finish(id); expect(await readFile(result.path)).toEqual(webm);
    const next = await store.prepare('webm'); await store.append(next, 0, webm); await store.cancel(next);
    expect(await readdir(downloadPath)).toEqual([path.basename(result.path)]); await store.shutdown();
  });

  it('keeps the original partial WebM when conversion fails, allowing recovery and a new recording', async () => {
    const downloadPath = await directory();
    const store = new RecordingStore({ downloadPath, getFfmpeg: () => path.join(downloadPath, 'missing-ffmpeg.exe'), changed: vi.fn() });
    const id = await store.prepare('mp4'); await store.append(id, 0, webm);
    await expect(store.finish(id)).rejects.toThrow('FFmpeg'); const failed = store.state()!;
    expect(failed.status).toBe('failed'); expect(failed.path).toBeDefined(); expect(await readFile(failed.path!)).toEqual(webm);
    const next = await store.prepare('webm'); await store.cancel(next); expect(await stat(failed.path!)).toMatchObject({ size: webm.length }); await store.shutdown();
  });

  it('preserves an interrupted recording on shutdown and refuses new work', async () => {
    const { store } = await fixture(); const id = await store.prepare('webm'); await store.append(id, 0, webm); await store.shutdown();
    expect(store.state()).toMatchObject({ status: 'failed', error: '应用退出，原始 WebM 已保留。' });
    expect(await readFile(store.state()!.path!)).toEqual(webm); await expect(store.prepare('webm')).rejects.toThrow();
  });

  it('keeps the committed recording successful when cleanup of a staging file is temporarily denied', async () => {
    const { store } = await fixture(); const id = await store.prepare('webm'); await store.append(id, 0, webm);
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(Error('Scanner temporarily locked the file'), { code: 'EPERM' }));
    const result = await store.finish(id); expect(await readFile(result.path)).toEqual(webm);
    expect(store.state()).toMatchObject({ status: 'saved', path: result.path }); expect(store.state()?.error).toBeUndefined(); await store.shutdown();
  });

  it('rejects unavailable conversion before beginning and reports an empty recording honestly', async () => {
    const { store, downloadPath } = await fixture(); await expect(store.prepare('mp4')).rejects.toThrow('FFmpeg'); expect(await readdir(downloadPath)).toEqual([]);
    const id = await store.prepare('webm'); await expect(store.finish(id)).rejects.toThrow('没有收到'); expect(store.state()?.status).toBe('failed'); await store.cancel(id);
  });

  it('requests automatic stop at the GIF wall-time limit and cancels its fallback on explicit cancellation', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const onLimit = vi.fn(); const downloadPath = await directory();
    const store = new RecordingStore({ downloadPath, getFfmpeg: () => 'unused-ffmpeg', changed: vi.fn(), onLimit });
    const id = await store.prepare('gif'); await store.append(id, 0, webm); await vi.advanceTimersByTimeAsync(60_000);
    expect(onLimit).toHaveBeenCalledWith(id); expect(store.state()?.error).toContain('时长上限');
    await store.cancel(id); await vi.advanceTimersByTimeAsync(5000); expect(store.state()?.status).toBe('cancelled'); await store.shutdown();
  });
});

const ffmpeg = process.env.WORLDLINEBOX_FFMPEG_PATH ?? path.resolve('resources/ffmpeg', process.platform === 'win32' ? 'win32-x64/ffmpeg.exe' : 'linux-x64/ffmpeg');
const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const run = promisify(execFile);
describe.skipIf(!existsSync(ffmpeg) || !existsSync(ffprobe))('bundled FFmpeg recording conversions', () => {
  it.each(['mp4', 'gif'] as const)('produces a decodable %s from real MediaRecorder-compatible WebM', async format => {
    const downloadPath = await directory(); const input = path.join(downloadPath, 'source.webm');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10',
      ...(format === 'mp4' ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'libopus'] : ['-an']),
      '-t', '0.6', '-c:v', 'libvpx', '-b:v', '100k', input], { windowsHide: true, timeout: 20_000 });
    const bytes = await readFile(input); const store = new RecordingStore({ downloadPath, getFfmpeg: () => ffmpeg, changed: vi.fn() });
    const id = await store.prepare(format); await store.append(id, 0, bytes); const result = await store.finish(id);
    const probe = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', result.path], { windowsHide: true, timeout: 20_000 });
    const streams = JSON.parse(probe.stdout).streams as { codec_type: string; codec_name: string; width?: number; height?: number }[];
    const stream = streams.find(value => value.codec_type === 'video')!; expect(stream.codec_name).toBe(format === 'mp4' ? 'h264' : 'gif'); expect(stream.width).toBe(96); expect(stream.height).toBe(64);
    if (format === 'mp4') expect(streams.find(value => value.codec_type === 'audio')?.codec_name).toBe('aac'); else expect(streams.some(value => value.codec_type === 'audio')).toBe(false);
    expect((await readdir(downloadPath)).filter(name => name.endsWith('.part'))).toEqual([]); await store.shutdown();
  });
});

it('keeps FFmpeg input paths as argument values and uses conservative fixed conversion settings', () => {
  const args = recordingConversionArgs('C:\\test path\\clip;name.webm', 'C:\\result file.mp4.part', 'mp4');
  expect(args).toContain('C:\\test path\\clip;name.webm'); expect(args).toContain('libopenh264'); expect(args).toContain('aac'); expect(args).toContain('-n');
  const gif = recordingConversionArgs('input', 'output', 'gif'); expect(gif).toContain('60'); expect(gif.join(' ')).toContain('fps=12'); expect(gif.join(' ')).toContain('960');
  for (const [quality, bitrate] of [['original', '16M'], ['1080p', '8M'], ['720p', '4M']] as const) {
    const preset = recordingConversionArgs('input', 'output', 'mp4', quality);
    expect(preset[preset.indexOf('-b:v') + 1]).toBe(bitrate);
  }
});
