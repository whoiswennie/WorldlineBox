import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BOT_PRESENCE_ROUND_DAYS, BOT_PRESENCE_ROUND_LIMIT, BOT_PRESENCE_TASK_TIMEOUT_MS, type BotPresenceStatus } from '../../src/shared/companion-bot-media';
import { DesktopPresence } from '../../src/main/companion-bot/desktop-presence';
import { PresenceArchive } from '../../src/main/companion-bot/presence-archive';
import { readPresenceVideo } from '../../src/main/companion-bot/presence-video';

const frame = async (background: string) => (await sharp({ create: { width: 40, height: 30, channels: 3, background } }).jpeg().toBuffer()).toString('base64');
const clip = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
function captures(archive = new PresenceArchive()) {
  return {
    beginRound: (at: number, wait: number) => archive.beginRound('room', at, wait),
    updateRound: (...args: Parameters<PresenceArchive['updateRound']>) => archive.updateRound(...args),
    screen: vi.fn(async () => Buffer.from(await frame('#fff'), 'base64')),
    add: (kind: 'video' | 'screen', bytes: Uint8Array, startedAt: number, at: number) => archive.add('room', kind, bytes, startedAt, at),
    discardPending: () => archive.discardPending('room'),
    canCapture: () => archive.canCapture(),
    claim: () => archive.claim('room'),
    finish: (...args: Parameters<PresenceArchive['finish']>) => archive.finish(...args),
    prepare: vi.fn(async (records: Parameters<PresenceArchive['finish']>[0]) => ({ records, frames: [], sources: [], subtitles: [] })),
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('records the actual inputs of each attempt, even when the same clip is retried and its bytes later expire', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const archive = new PresenceArchive(), first = archive.beginRound('room', Date.now(), 30_000);
  archive.add('room', 'video', clip, 80_000, 96_000);
  const a = archive.claim('room');
  archive.updateRound(first, 'preparing', a); archive.updateRound(first, 'failed', undefined, '401 token=test-credential'); archive.finish(a, false);
  const second = archive.beginRound('room', Date.now(), 40_000);
  archive.add('room', 'screen', Uint8Array.of(1));
  const b = archive.claim('room');
  archive.updateRound(second, 'observing', b); archive.updateRound(second, 'completed'); archive.finish(b, true);
  vi.advanceTimersByTime(31 * 60_000);
  const { rounds, recordings } = archive.timeline('room');
  expect(recordings).toEqual([]);
  expect(rounds.map(r => [r.state, r.inputs.map(i => i.id)])).toEqual([['completed', b.map(i => i.id)], ['failed', [a[0]!.id]]]);
  expect(rounds[0]!.inputs[0]).not.toHaveProperty('bytes');
  expect(rounds[1]?.error).toBe('401 token=[redacted]');
  expect(archive.timeline('other').rounds).toEqual([]); archive.close();
});

it('bounds a multi-day heartbeat history, pages without overlap, and expires metadata even while idle', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const archive = new PresenceArchive();
  for (let i = 0; i < BOT_PRESENCE_ROUND_LIMIT * 3; i++) {
    vi.advanceTimersByTime(30_000);
    const id = archive.beginRound('room', Date.now(), 30_000);
    archive.updateRound(id, 'empty');
  }
  const seen = new Set<number>();
  let page = archive.timeline('room');
  for (;;) {
    for (const round of page.rounds) { expect(seen.has(round.id)).toBe(false); seen.add(round.id); }
    if (!page.olderRounds) break;
    page = archive.timeline('room', page.rounds.at(-1)!.id);
  }
  expect(seen.size).toBe(BOT_PRESENCE_ROUND_LIMIT);
  vi.advanceTimersByTime((BOT_PRESENCE_ROUND_DAYS + 1) * 86_400_000);
  expect(archive.timeline('room').rounds).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0); archive.close();
});

const ffmpeg = path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe');
it.skipIf(!existsSync(ffmpeg))('samples the whole video and assigns a larger frame budget to frequent visual changes', async () => {
  const encode = (seconds: number, filter: string) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=64x36:r=5', '-t', String(seconds), '-vf', filter, '-threads', '1', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'], { windowsHide: true });
  const short = await readPresenceVideo(ffmpeg, encode(16, 'null'), AbortSignal.timeout(10000));
  const moving = await readPresenceVideo(ffmpeg, encode(16, "drawbox=color=white:t=fill:enable='lt(mod(t,4),2)'"), AbortSignal.timeout(10000));
  const long = await readPresenceVideo(ffmpeg, encode(120, 'null'), AbortSignal.timeout(10000), 120);
  const sheets = (frames: typeof short) => frames.filter(frame => frame.kind === 'sheet');
  expect(sheets(short).flatMap(sheet => sheet.timestamps)).toHaveLength(3);
  expect(sheets(moving).flatMap(sheet => sheet.timestamps).length).toBeGreaterThan(3);
  expect(sheets(moving).length).toBeLessThanOrEqual(2);
  expect(short.filter(frame => frame.kind === 'keyframe')).toHaveLength(1);
  expect(moving.filter(frame => frame.kind === 'keyframe')).toHaveLength(2);
  const times = sheets(long).flatMap(sheet => sheet.timestamps);
  expect(times[0]).toBe('00:00:00.000');
  expect(times.at(-1)).toBe('00:02:00.000');
  expect(long.every(sheet => sheet.timestamps.length <= 6)).toBe(true);
}, 20_000);

it.skipIf(!existsSync(ffmpeg))('decodes standalone detail directly from the original video', async () => {
  const bytes = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=2',
    '-t', '2', '-threads', '1', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'], { windowsHide: true });
  const images = await readPresenceVideo(ffmpeg, bytes, AbortSignal.timeout(15_000), 2);
  const detail = images.find(item => item.kind === 'keyframe')!;
  expect(await sharp(Buffer.from(detail.jpeg, 'base64')).metadata()).toMatchObject({ width: 1920, height: 1080 });
});

it('yields an in-flight observation, discards stale media and starts one fresh wait after foreground work drains', async () => {
  vi.useFakeTimers();
  const archive = new PresenceArchive(), capture = captures(archive);
  capture.screen.mockResolvedValue(Buffer.from([1]));
  let busy = false;
  const observe = vi.fn<(sample: unknown, signal: AbortSignal) => Promise<undefined>>(() => new Promise(() => undefined));
  const session = new DesktopPresence('low', { vision: true, busy: () => busy, observe }, capture);
  const oldCycle = session.status().cycle;
  const work = session.beat();
  await vi.advanceTimersByTimeAsync(0);
  session.syncActivity(true);
  expect(await work).toBe('failed');
  expect(observe.mock.calls[0]?.[1].aborted).toBe(true);
  expect(archive.list('room')).toEqual([]);
  busy = true;
  session.syncActivity(false);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(session.status()).toMatchObject({ waitingForPartner: true, nextAt: undefined, capturePaused: true });
  expect(observe).toHaveBeenCalledTimes(1);
  busy = false;
  session.syncActivity(false);
  session.putClip(clip, Date.now() - 1000, Date.now(), oldCycle);
  expect(archive.list('room')).toEqual([]);
  const next = session.status().nextAt!;
  expect(next - Date.now()).toBeGreaterThanOrEqual(24_000);
  session.syncActivity(false);
  expect(session.status().nextAt).toBe(next);
  session.close(); archive.close();
});

it('announces actual screenshots and observation phases, clears recent notices, and suppresses interrupted results', async () => {
  vi.useFakeTimers();
  const archive = new PresenceArchive(), capture = captures(archive);
  const notify = vi.fn<(status: BotPresenceStatus) => void>();
  const target = { vision: true, busy: () => false, observe: vi.fn(async () => ({ reaction: '', vision: true })) };
  const session = new DesktopPresence('low', target, { ...capture, notify });
  try {
    let finish!: (value: Buffer<ArrayBuffer>) => void;
    capture.screen.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = session.beat();
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ screenshot: 'capturing' }));
    finish(Buffer.from([1]));
    await first;
    expect(notify.mock.calls.map(([status]) => status.phase)).toEqual(['sealing', 'sealing', 'preparing', 'observing', undefined]);
    expect(session.status().screenshot).toBe('just-captured');
    await vi.advanceTimersByTimeAsync(3100);
    expect(session.status().screenshot).toBeUndefined();
    const second = session.beat();
    session.syncActivity(true);
    finish(Buffer.from([2]));
    await second;
    expect(session.status()).toMatchObject({ screenshot: undefined, waitingForPartner: true });
    expect(target.observe).toHaveBeenCalledTimes(1);
  } finally { session.close(); archive.close(); }
});

it('evicts pending originals under byte pressure and expiry while protecting claimed evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'presence-archive-test-'));
  const archive = new PresenceArchive(directory);
  try {
    vi.useFakeTimers();
    const bytes = new Uint8Array(8 * 1024 * 1024);
    const pinned = archive.add('room', 'video', bytes);
    archive.claim('room');
    const old = archive.add('room', 'video', bytes);
    const file = await archive.original(old, new AbortController().signal);
    for (let i = 0; i < 8; i++) archive.add('room', 'video', bytes);
    expect(archive.list('room').reduce((n, item) => n + item.size, 0)).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(archive.list('room').some(item => item.id === old.id)).toBe(false);
    await archive.clear('room');
    expect(existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(archive.list('room').map(item => item.id)).toEqual([pinned.id]);
  } finally {
    archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('bounds a backlog of small unprocessed files by count and video duration even below the byte limit', () => {
  vi.useFakeTimers();
  const now = Date.now(), archive = new PresenceArchive();
  for (let i = 0; i < 1000; i++) archive.add('room', 'screen', clip, now - 200_000 + i);
  expect(archive.list('room')).toHaveLength(60);
  for (let i = 10; i > 0; i--) archive.add('video-room', 'video', clip, now - i * 16_000, now - (i - 1) * 16_000);
  const video = archive.claim('video-room');
  expect(video.map(item => item.startedAt)).toEqual(Array.from({ length: 6 }, (_, i) => now - (6 - i) * 16_000));
  archive.close();
});

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
  expect(archive.list('room')).toHaveLength(2);
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

it('backs off after quiet DSH turns with a bounded interval', async () => {
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
    expect(session.status().nextAt! - Date.now()).toBe(30_500 + Math.min(3, index + 1) * 5000);
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
