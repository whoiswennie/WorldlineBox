import { expect, it } from 'vitest';
import { worldAdvanceFrameClock, worldAnimationWakeDelay, worldArrivalPresentationDuration, worldContinuePath, worldNextRenderDelay, worldRemainingPath, worldScenePreparationGate, worldSnapshotInterpolationDuration, worldTargetFrameRate } from '../../src/renderer/companions/world/world-render-timing';

const at = '2026-10-15T08:00:00.000Z';
it('waits for current scene preparation and ignores obsolete compilation completion', () => {
  const gate = worldScenePreparationGate(); expect(gate.ready).toBe(false);
  const first = gate.begin(), second = gate.begin();
  expect(gate.complete(first)).toBe(false); expect(gate.ready).toBe(false);
  expect(gate.complete(second)).toBe(true); expect(gate.ready).toBe(true);
  const third = gate.begin(); expect(gate.ready).toBe(false);
  expect(gate.complete(second)).toBe(false); expect(gate.ready).toBe(false);
  expect(gate.complete(third)).toBe(true);
});
it('stops hidden renderers and lets every visible moving observer retain a smooth frame budget', () => {
  const input = { active: true, continuous: true, dirty: false, visibleWindowCount: 4, sinceLastDrawMs: 10, nextAnimationMs: Infinity };
  expect(worldTargetFrameRate(1)).toBe(30); expect(worldTargetFrameRate(3)).toBe(30); expect(worldTargetFrameRate(4)).toBe(24); expect(worldTargetFrameRate(8)).toBe(20);
  expect(worldNextRenderDelay(input)).toBeCloseTo(1000 / 24 - 10);
  expect(worldNextRenderDelay({ ...input, active: false, dirty: true })).toBeUndefined();
  let cursor = 0, draws = 0;
  for (let tick = 1; tick <= 600; tick++) { const time = tick * 1000 / 60; if (time - cursor >= 1000 / 24 - .001) { cursor = worldAdvanceFrameClock(cursor, time + .00001, 4); draws++; } }
  expect(draws).toBeGreaterThanOrEqual(239); expect(draws).toBeLessThanOrEqual(241);
  const firstEarly = worldAdvanceFrameClock(0, 33.1, 2);
  expect(firstEarly).toBeCloseTo(1000 / 30);
  expect(worldAdvanceFrameClock(firstEarly, 66.4, 2)).toBeCloseTo(2000 / 30);
});
it('draws static scenes only for a real dirty change or the next three-frame sprite change', () => {
  const input = { active: true, continuous: false, dirty: false, visibleWindowCount: 3, sinceLastDrawMs: 100, nextAnimationMs: Infinity };
  expect(worldNextRenderDelay(input)).toBeUndefined();
  expect(worldNextRenderDelay({ ...input, nextAnimationMs: 480 })).toBe(480);
  expect(worldNextRenderDelay({ ...input, dirty: true })).toBe(0);
  expect(worldAnimationWakeDelay(at, 2100, 'loop', Date.parse(at) + 250, false)).toBe(450);
  expect(worldAnimationWakeDelay(at, 2100, 'transition', Date.parse(at) + 1500, false)).toBe(Infinity);
  expect(worldAnimationWakeDelay(at, 2100, 'loop', Date.parse(at) + 250, true)).toBe(Infinity);
});
it('uses received snapshot spacing instead of stopping a one-second movement after 750ms', () => {
  expect(worldSnapshotInterpolationDuration(at, '2026-10-15T08:00:01.000Z')).toBe(1000);
  expect(worldSnapshotInterpolationDuration(at, '2026-10-15T09:00:00.000Z')).toBe(1250);
  expect(worldSnapshotInterpolationDuration(at, at)).toBe(1000);
  const oldPath = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  expect(worldRemainingPath(oldPath, 250, 1000)).toEqual([{ x: .5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
  expect(worldContinuePath(oldPath, 250, 1000, [{ x: 1, y: 1 }, { x: 1, y: 2 }])).toEqual([{ x: .5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }]);
  expect(worldRemainingPath(oldPath, 1500, 1000)).toEqual([{ x: 1, y: 1 }]);
});
it('briefly converges known arrival corners without keeping settled work or sleep behind the authority', () => {
  const path = [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }];
  expect(worldArrivalPresentationDuration('idle', path, 2.4)).toBe(220);
  expect(worldArrivalPresentationDuration('seating', path, 4.8)).toBe(220);
  expect(worldArrivalPresentationDuration('idle', [{ x: 0, y: 0 }, { x: .1, y: 0 }], 2)).toBe(50);
  expect(worldArrivalPresentationDuration('working', path, 2.4)).toBe(0);
  expect(worldArrivalPresentationDuration('sleeping', path, 2.4)).toBe(0);
});
