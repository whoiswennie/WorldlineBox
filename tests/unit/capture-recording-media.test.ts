import { expect, it, vi } from 'vitest';
import { normalizeCaptureRegion, recordingClock, recordingMimeType } from '../../src/renderer/capture-tools/recording-media';

it('constrains crop fractions to the captured frame and handles invalid numeric input', () => {
  expect(normalizeCaptureRegion({ x: -.1, y: .9, width: 2, height: .5 })).toEqual({ x: 0, y: .9, width: 1, height: 1 - .9 });
  expect(normalizeCaptureRegion({ x: NaN, y: Infinity, width: NaN, height: -4 })).toEqual({ x: 0, y: 0, width: 1, height: .01 });
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
