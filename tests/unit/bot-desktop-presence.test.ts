import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BOT_PRESENCE_TASK_TIMEOUT_MS } from '../../src/shared/companion-bot-media';
import { DesktopPresence } from '../../src/main/companion-bot/desktop-presence';
import { PresenceArchive } from '../../src/main/companion-bot/presence-archive';
import { readPresenceVideo } from '../../src/main/companion-bot/presence-video';

const frame = async (background: string) => (await sharp({ create: { width: 40, height: 30, channels: 3, background } }).jpeg().toBuffer()).toString('base64');
const clip = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
function captures(archive = new PresenceArchive()) {
  return {
    screen: vi.fn(async () => Buffer.from(await frame('#fff'), 'base64')),
    add: (kind: 'video' | 'screen', bytes: Uint8Array, startedAt: number, at: number) => archive.add('room', kind, bytes, startedAt, at),
    stage: vi.fn(),
    canCapture: () => archive.canCapture(),
    claim: () => archive.claim('room'),
    finish: (records: Parameters<PresenceArchive['finish']>[0], success: boolean) => archive.finish(records, success),
    prepare: vi.fn(async (records: Parameters<PresenceArchive['finish']>[0]) => ({ records, frames: [], sources: [], subtitles: [] })),
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const ffmpeg = path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe');
it.skipIf(!existsSync(ffmpeg))('samples the whole video and assigns a larger frame budget to frequent visual changes', async () => {
  const encode = (seconds: number, filter: string) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=64x36:r=5', '-t', String(seconds), '-vf', filter, '-threads', '1', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'], { windowsHide: true });
  const short = await readPresenceVideo(ffmpeg, encode(16, 'null'), AbortSignal.timeout(10000));
  const moving = await readPresenceVideo(ffmpeg, encode(16, "drawbox=color=white:t=fill:enable='lt(mod(t,4),2)'"), AbortSignal.timeout(10000));
  const long = await readPresenceVideo(ffmpeg, encode(120, 'null'), AbortSignal.timeout(10000), 120);
  expect(short.flatMap(sheet => sheet.timestamps)).toHaveLength(3);
  expect(moving.flatMap(sheet => sheet.timestamps).length).toBeGreaterThan(3);
  expect(moving.length).toBeLessThanOrEqual(2);
  const times = long.flatMap(sheet => sheet.timestamps);
  expect(times[0]).toBe('00:00:00.000');
  expect(times.at(-1)).toMatch(/^00:01:5\d\./u);
  expect(long.every(sheet => sheet.timestamps.length <= 6)).toBe(true);
}, 20_000);

it('chooses exactly one capture kind for each energy setting', () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const target = { vision: true, busy: () => false, observe: vi.fn() };
  const random = vi.spyOn(Math, 'random').mockReturnValue(.5);
  const low = new DesktopPresence('low', target, captures());
  const active = new DesktopPresence('active', target, captures());
  const balancedVideo = new DesktopPresence('balanced', target, captures());
  random.mockReturnValue(.8);
  const balancedPhoto = new DesktopPresence('balanced', target, captures());
  expect(low.status()).toMatchObject({ capture: 'screen', nextAt: active.status().nextAt });
  expect(active.status().capture).toBe('video');
  expect(balancedVideo.status().capture).toBe('video');
  expect(balancedPhoto.status().capture).toBe('screen');
  [low, active, balancedVideo, balancedPhoto].forEach(session => session.close());
});

it('stages video while waiting and sends every piece, including the tail sealed at the heartbeat', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const archive = new PresenceArchive(), capture = captures(archive);
  const observe = vi.fn(async () => ({ reaction: '一起看。', vision: true }));
  const session = new DesktopPresence('active', { vision: true, busy: () => false, observe }, capture);
  session.putClip(clip, 75_000, 91_000);
  session.putClip(clip, 91_000, 97_000);
  expect(capture.stage).toHaveBeenCalledTimes(2);
  expect(observe).not.toHaveBeenCalled();
  const work = session.beat();
  expect(session.status()).toMatchObject({ thinking: true, nextAt: undefined });
  const seal = session.status().flushCycle!;
  session.flushed(seal + 1);
  await Promise.resolve();
  expect(observe).not.toHaveBeenCalled();
  session.putClip(clip, 97_000, 100_000);
  session.flushed(seal);
  expect(await work).toBe('accepted');
  expect(capture.prepare.mock.calls[0]?.[0].map(record => [record.startedAt, record.at])).toEqual([[75_000, 91_000], [91_000, 97_000], [97_000, 100_000]]);
  expect(capture.screen).not.toHaveBeenCalled();
  expect(archive.list('room').every(record => record.status === 'archived')).toBe(true);
  session.close(); archive.close();
});

it('takes repeated screenshots while waiting and a last screenshot at the heartbeat', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const archive = new PresenceArchive(), capture = captures(archive);
  capture.screen.mockResolvedValue(Buffer.from([1, 2, 3]));
  const observe = vi.fn(() => new Promise<{ reaction: string; vision: boolean }>(() => undefined));
  const session = new DesktopPresence('low', { vision: true, busy: () => false, observe }, capture);
  await vi.advanceTimersByTimeAsync(23_000);
  expect(capture.screen).toHaveBeenCalledTimes(5);
  expect(observe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(capture.screen).toHaveBeenCalledTimes(6);
  expect(capture.prepare.mock.calls[0]?.[0].at(-1)?.at).toBe(124_000);
  expect(session.status()).toMatchObject({ thinking: true, nextAt: undefined });
  expect(await session.beat()).toBe('thinking');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(capture.screen).toHaveBeenCalledTimes(6);
  session.interrupt();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.status().nextAt).toBeGreaterThan(144_000);
  expect(archive.list('room').every(record => record.status === 'pending')).toBe(true);
  session.close(); archive.close();
});

it('fences a stalled request at the deadline and leaves the batch queued for the next heartbeat', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const archive = new PresenceArchive(), capture = captures(archive);
  capture.screen.mockResolvedValue(Buffer.from([1, 2, 3]));
  const busy = vi.fn(() => true);
  let signal: AbortSignal | undefined;
  const observe = vi.fn((_sample, active: AbortSignal) => { signal = active; return new Promise<undefined>(() => undefined); });
  const session = new DesktopPresence('low', { vision: true, busy, observe }, capture);
  expect(await session.beat()).toBe('busy');
  busy.mockReturnValue(false);
  const work = session.beat();
  await vi.advanceTimersByTimeAsync(0);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(BOT_PRESENCE_TASK_TIMEOUT_MS);
  expect(await work).toBe('failed');
  expect(signal?.aborted).toBe(true);
  expect(session.status()).toMatchObject({ thinking: false, error: '本轮采集未在时限内完成，素材已留待下次处理。' });
  expect(archive.list('room').map(record => record.status)).toEqual(['pending']);
  session.close(); archive.close();
});

it('reports every quiet DSH turn without extending the next interval', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.spyOn(Math, 'random').mockReturnValue(.5);
  const archive = new PresenceArchive(), capture = captures(archive);
  capture.screen.mockResolvedValue(Buffer.from([1, 2, 3]));
  const observe = vi.fn(async () => ({ reaction: '', vision: true }));
  const session = new DesktopPresence('low', { vision: true, busy: () => false, observe }, capture);
  for (let index = 0; index < 4; index++) {
    expect(await session.beat()).toBe('accepted');
    expect(session.status().last).toEqual({ at: Date.now(), outcome: 'observed' });
    expect(session.status().nextAt! - Date.now()).toBe(30_500);
    vi.setSystemTime(session.status().nextAt!);
  }
  expect(observe).toHaveBeenCalledTimes(4);
  session.close(); archive.close();
});

it('evicts the oldest archived records and never clears queued or processing inputs', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T08:10:06.123Z'));
  const archive = new PresenceArchive();
  const done = Array.from({ length: 51 }, () => archive.add('room', 'video', clip));
  expect(done[0]?.name).toContain('2026-11-17_08-10-06.123Z');
  expect(done[0]?.name).not.toBe(done[1]?.name);
  archive.finish(archive.claim('room'), true);
  const processing = archive.add('room', 'video', clip);
  archive.claim('room');
  const pending = archive.add('room', 'screen', clip);
  const other = archive.add('another-room', 'video', clip);
  expect(archive.list('room').filter(record => record.status === 'archived')).toHaveLength(50);
  expect(() => archive.read('room', done[0]!.id)).toThrow();
  await archive.clear('room');
  expect(archive.list('room').map(record => [record.id, record.status])).toEqual([[pending.id, 'pending'], [processing.id, 'processing']]);
  expect(archive.read('another-room', other.id)).toEqual(clip);
  archive.finish([processing], false);
  expect(archive.claim('room')).toHaveLength(2);
  archive.close();
});
