import { expect, it } from 'vitest';
import { LipSyncController } from '../../vendor/soullink-emotion/engine/dist/speech/LipSyncController';

function mouth(intensity: number, level: number) {
  const controller = new LipSyncController();
  let value = 0;
  for (let frame = 0; frame < 12; frame++) value = controller.update(frame / 60, { enabled: true, speaking: true, intensity, audioLevel: level, deltaSeconds: 1 / 60 }).mouthOpen ?? 0;
  return value;
}
it('maps real audible levels into a useful jaw range independently of emotional intensity', () => {
  expect(mouth(0, .5)).toBeGreaterThan(.5);
  expect(mouth(0, 1)).toBeGreaterThan(.9);
  expect(mouth(0, .5)).toBe(mouth(1, .5));
  expect(mouth(0, .15)).toBeLessThan(mouth(0, .5));
});
it('does not manufacture a speech animation for silent audio or a microphone-only listening phase', () => {
  expect(mouth(1, 0)).toBe(0); expect(mouth(1, .02)).toBe(0);
  const controller = new LipSyncController();
  controller.update(0, { enabled: true, speaking: true, intensity: 1, audioLevel: 1 });
  expect(controller.update(.02, { enabled: true, speaking: false, intensity: 1, audioLevel: 1 })).toEqual({});
  expect(controller.update(.04, { enabled: true, speaking: true, intensity: 1, audioLevel: 0 }).mouthOpen).toBe(0);
});
