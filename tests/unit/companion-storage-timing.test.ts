import { expect, it } from 'vitest';
import { companionStorageReplySchema } from '../../src/shared/companion-storage';
import { companionStorageTimingSchema, emptyCompanionStorageTimingSegments, measureCompanionStorageTiming,
  withCompanionStorageTiming, type CompanionStorageTimingSegment } from '../../src/shared/companion-storage-timing';

it('accepts optional fixed scalar telemetry and rejects unknown keys, missing stages and invalid durations', () => {
  const timing = { receivedEpochMs: 1000, respondedEpochMs: 1002, parseMs: 0.1, runMs: 1.5, segments: emptyCompanionStorageTimingSegments() };
  const reply = { requestId: 'timing-request', response: { ok: true } };
  expect(companionStorageReplySchema.parse(reply)).toEqual(reply);
  expect(companionStorageReplySchema.parse({ ...reply, timing }).timing).toEqual(timing);
  for (const value of [-1, NaN, Infinity]) expect(companionStorageTimingSchema.safeParse({ ...timing, runMs: value }).success).toBe(false);
  expect(companionStorageTimingSchema.safeParse({ ...timing, body: 'not telemetry' }).success).toBe(false);
  expect(companionStorageTimingSchema.safeParse({ ...timing, segments: { ...timing.segments, unknown: 1 } }).success).toBe(false);
  const { dispatch: _dispatch, ...incomplete } = timing.segments; void _dispatch;
  expect(companionStorageTimingSchema.safeParse({ ...timing, segments: incomplete }).success).toBe(false);
});

it('contains observer failures and restores the finite synchronous context after success and the original exception', () => {
  const observed: CompanionStorageTimingSegment[] = [], value = { original: true }, failure = new Error('original operation failure');
  const observer = (segment: CompanionStorageTimingSegment, durationMs: number) => {
    expect(Number.isFinite(durationMs) && durationMs >= 0).toBe(true); observed.push(segment); throw new Error('observer failure');
  };
  expect(withCompanionStorageTiming(observer, () => measureCompanionStorageTiming('dispatch', () => value))).toBe(value);
  expect(() => withCompanionStorageTiming(observer, () => measureCompanionStorageTiming('capture', () => { throw failure; }))).toThrow(failure);
  measureCompanionStorageTiming('invalidations', () => undefined);
  expect(observed).toEqual(['dispatch', 'capture']);
});

it('restores the outer observer after an independently scoped nested collection', () => {
  const outer: string[] = [], inner: string[] = [];
  withCompanionStorageTiming(segment => outer.push(segment), () => {
    measureCompanionStorageTiming('dispatch', () => withCompanionStorageTiming(segment => inner.push(segment), () =>
      measureCompanionStorageTiming('captureExpected', () => 7)));
    measureCompanionStorageTiming('invalidations', () => undefined);
  });
  expect(outer).toEqual(['dispatch', 'invalidations']); expect(inner).toEqual(['captureExpected']);
});
