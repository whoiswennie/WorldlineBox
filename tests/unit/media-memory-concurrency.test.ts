import { describe, expect, it } from 'vitest';

import {
  MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES,
  mediaFfmpegConcurrencyLimit,
  systemAvailablePhysicalMemoryBytes,
} from '../../src/worker/media-memory-concurrency';
import { MediaNativeMemoryBudget } from '../../src/worker/media-memory-budget';

describe('memory-aware FFmpeg concurrency', () => {
  it('uses one process below 4 GiB and for unknown probes, and two at the boundary', () => {
    expect(mediaFfmpegConcurrencyLimit(MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES - 1)).toBe(1);
    expect(mediaFfmpegConcurrencyLimit(MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES)).toBe(2);
    expect(mediaFfmpegConcurrencyLimit(undefined)).toBe(1);
    expect(mediaFfmpegConcurrencyLimit(Number.NaN)).toBe(1);
    expect(mediaFfmpegConcurrencyLimit(0)).toBe(1);
  });

  it('reads system memory outside V8 and returns a positive byte count when available', () => {
    const availableBytes = systemAvailablePhysicalMemoryBytes();
    expect(availableBytes === undefined || (Number.isSafeInteger(availableBytes) && availableBytes > 0))
      .toBe(true);
  });

  it.each([
    { tier: 'low memory', availableBytes: MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES - 1, limit: 1 },
    { tier: 'at the boundary', availableBytes: MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES, limit: 2 },
  ])('caps simultaneous work to the selected tier ($tier)', async ({ availableBytes, limit }) => {
    const unit = 8 * 1024 * 1024;
    const budget = new MediaNativeMemoryBudget(3 * unit);
    const admission = { key: 'ffmpeg', limit: () => mediaFfmpegConcurrencyLimit(availableBytes) };
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 5 }, () => budget.run(
      undefined,
      unit,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      },
      admission,
    )));

    expect(peak).toBe(limit);
    expect(budget.activeForAdmission('ffmpeg')).toBe(0);
    expect(budget.usedBytes).toBe(0);
  });

  it('stops admission after memory drops without pre-reserving bytes for waiters', async () => {
    const unit = 8 * 1024 * 1024;
    const budget = new MediaNativeMemoryBudget(3 * unit);
    let availableBytes = MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES;
    const started: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const admission = { key: 'ffmpeg', limit: () => mediaFfmpegConcurrencyLimit(availableBytes) };
    const first = budget.run(undefined, unit, () => new Promise<void>((resolve) => {
      started.push('first');
      releaseFirst = resolve;
    }), admission);
    const second = budget.run(undefined, unit, () => new Promise<void>((resolve) => {
      started.push('second');
      releaseSecond = resolve;
    }), admission);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);
    expect(budget.usedBytes).toBe(2 * unit);

    availableBytes = MEDIA_FFMPEG_MEMORY_THRESHOLD_BYTES - 1;
    const third = budget.run(undefined, unit, async () => {
      started.push('third');
    }, admission);
    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);
    expect(budget.usedBytes).toBe(2 * unit);

    releaseFirst();
    await first;
    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);
    expect(budget.activeForAdmission('ffmpeg')).toBe(1);
    expect(budget.usedBytes).toBe(unit);

    releaseSecond();
    await second;
    await third;
    expect(started).toEqual(['first', 'second', 'third']);
    expect(budget.activeForAdmission('ffmpeg')).toBe(0);
    expect(budget.usedBytes).toBe(0);
  });

  it('lets another decoder use free budget while an FFmpeg slot waiter stays queued', async () => {
    const unit = 8 * 1024 * 1024;
    const budget = new MediaNativeMemoryBudget(4 * unit);
    const admission = { key: 'ffmpeg', limit: () => 1 };
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const hold = (name: string, ffmpeg: boolean) => budget.run(
      undefined,
      unit,
      () => new Promise<void>((resolve) => {
        started.push(name);
        releases.set(name, resolve);
      }),
      ffmpeg ? admission : undefined,
    );

    const first = hold('ffmpeg-1', true);
    const second = hold('ffmpeg-2', true);
    const third = hold('ffmpeg-3', true);
    const sharp = hold('sharp-thumbnail', false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(['ffmpeg-1', 'sharp-thumbnail']);
    expect(budget.usedBytes).toBe(2 * unit);
    expect(budget.activeForAdmission('ffmpeg')).toBe(1);

    releases.get('ffmpeg-1')?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['ffmpeg-1', 'sharp-thumbnail', 'ffmpeg-2']);

    releases.get('ffmpeg-2')?.();
    await second;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['ffmpeg-1', 'sharp-thumbnail', 'ffmpeg-2', 'ffmpeg-3']);

    releases.get('ffmpeg-3')?.();
    releases.get('sharp-thumbnail')?.();
    await Promise.all([third, sharp]);
    expect(budget.usedBytes).toBe(0);
    expect(budget.activeForAdmission('ffmpeg')).toBe(0);
  });

  it('uses the conservative limit when probing throws and releases cancelled waiters atomically', async () => {
    const unit = 8 * 1024 * 1024;
    const budget = new MediaNativeMemoryBudget(3 * unit);
    const unavailableAdmission = { key: 'ffmpeg', limit: () => { throw new Error('unavailable'); } };
    let releaseFirst!: () => void;
    const first = budget.run(undefined, unit, () => new Promise<void>((resolve) => { releaseFirst = resolve; }), unavailableAdmission);
    await Promise.resolve();
    expect(budget.activeForAdmission('ffmpeg')).toBe(1);

    const controller = new AbortController();
    const waiting = budget.run(controller.signal, unit, async () => undefined, unavailableAdmission);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.usedBytes).toBe(unit);

    releaseFirst();
    await first;
    expect(budget.activeForAdmission('ffmpeg')).toBe(0);
    expect(budget.usedBytes).toBe(0);
  });
});
