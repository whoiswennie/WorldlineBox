import { expect, it, vi } from 'vitest';
import { normalizeCaptureRegion, recordingBitrate, recordingClock, recordingMimeType, recordingOutputSize } from '../../src/renderer/capture-tools/recording-media';

it('constrains crop fractions to the captured frame and handles invalid numeric input', () => {
  expect(normalizeCaptureRegion({ x: -.1, y: .9, width: 2, height: .5 })).toEqual({ x: 0, y: .9, width: 1, height: 1 - .9 });
  expect(normalizeCaptureRegion({ x: NaN, y: Infinity, width: NaN, height: -4 })).toEqual({ x: 0, y: 0, width: 1, height: .000001 });
  expect(normalizeCaptureRegion({ x: .5, y: .5, width: .002, height: .003 })).toEqual({ x: .5, y: .5, width: .002, height: .003 });
});
it('negotiates webm encoding supported by the current browser without requiring MP4 native recording', () => {
  const supported = vi.fn(value => value === 'video/webm;codecs=vp8,opus');
  expect(recordingMimeType(supported, true)).toBe('video/webm;codecs=vp8,opus');
  expect(recordingMimeType(() => false, false)).toBe('');
});
it('keeps elapsed recording time readable beyond an hour', () => {
  expect(recordingClock(3_725_999)).toBe('01:02:05');
  expect(recordingClock(-10)).toBe('00:00:00');
});

it('keeps original 4K detail and offers HD/SD without stretching or upscaling', () => {
  expect(recordingOutputSize(3840, 2160, 'original')).toEqual({ width: 3840, height: 2160 });
  expect(recordingOutputSize(3840, 2160, '1080p')).toEqual({ width: 1920, height: 1080 });
  expect(recordingOutputSize(3840, 2160, '720p')).toEqual({ width: 1280, height: 720 });
  expect(recordingOutputSize(2160, 3840, '1080p')).toEqual({ width: 1080, height: 1920 });
  expect(recordingOutputSize(801, 601, '1080p')).toEqual({ width: 800, height: 600 });
  expect(recordingOutputSize(2560, 1600, '1080p')).toEqual({ width: 1728, height: 1080 });
  expect(recordingBitrate(3840, 2160)).toBeGreaterThan(recordingBitrate(1280, 720));
  expect(recordingBitrate(7680, 4320) * 7200 / 8).toBeLessThan(16 * 1024 ** 3);
});
