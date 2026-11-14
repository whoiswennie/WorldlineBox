import { expect, it } from 'vitest';
import { SoullinkRuntime } from '@soullink-emotion/engine';
import { BotCallPerformance } from '../../src/renderer/companion-bot/call-performance';
import { botCallProfile } from '../../src/renderer/companion-bot/call-presentation';

const range = (min: number, max: number, value = 0) => ({ min, max, default: value });
const modelParameters = {
  ParamAngleX: range(-30, 30), ParamAngleY: range(-30, 30), ParamAngleZ: range(-30, 30),
  ParamBodyAngleX: range(-30, 30), ParamBodyAngleY: range(-30, 30), ParamBodyAngleZ: range(-30, 30),
  ParamEyeLOpen: range(0, 1.5, 1), ParamEyeROpen: range(0, 1.5, 1), ParamEyeBallX: range(-1, 1), ParamEyeBallY: range(-1, 1),
  ParamMouthOpenY: range(0, 1), ParamMouthForm: range(-1, 1), ParamBrowLY: range(-1, 1), ParamBrowRY: range(-1, 1), ParamBreath: range(0, 1), key7: range(0, 1),
  Clothes2: range(0, 2), key10: range(0, 1),
};
function fixture() {
  let time = 0;
  const profile = botCallProfile(modelParameters, 'local.model3.json');
  const engine = new SoullinkRuntime({ profile, motionStyle: { seed: 20261105, spontaneity: 1, microMotionGain: 1.15, idleActionGain: 1.1, gazeStability: .64 } });
  const performance = new BotCallPerformance(engine, () => time);
  const tick = (seconds: number) => { let state = performance.update(time, 1 / 60); const frames = Math.round(seconds * 60);
    for (let frame = 0; frame < frames; frame++) { time += 1 / 60; state = performance.update(time, 1 / 60); } return state; };
  return { performance, engine, profile, tick };
}

it('continuously breathes, blinks, shifts weight and looks around without messages or manual actions', () => {
  const f = fixture(), samples: Record<string, number>[] = [];
  for (let frame = 0; frame < 1800; frame++) samples.push(f.tick(1 / 60).live2dParams);
  const span = (id: string) => Math.max(...samples.map(sample => sample[id]!)) - Math.min(...samples.map(sample => sample[id]!));
  expect(span('ParamAngleX')).toBeGreaterThan(1); expect(span('ParamAngleZ')).toBeGreaterThan(1);
  expect(span('ParamBodyAngleX')).toBeGreaterThan(.4); expect(span('ParamBreath')).toBeGreaterThan(.4);
  expect(span('ParamEyeBallX')).toBeGreaterThan(.06);
  expect(samples.some(sample => sample.ParamEyeLOpen! < .3)).toBe(true); expect(samples.some(sample => sample.ParamEyeLOpen! > .95)).toBe(true);
  expect(samples.every(sample => sample.ParamMouthOpenY === 0 && !('Clothes2' in sample) && !('key10' in sample))).toBe(true);
});

it('starts and clears the explicit gesture without disturbing manual pose or pointer tracking', () => {
  const f = fixture(); f.performance.idle(false); f.performance.pose({ headX: .3 }); f.performance.point(.9, -.6);
  f.performance.setGesture('nod');
  const nod = f.tick(.22).live2dParams;
  expect(nod.ParamAngleY).toBeGreaterThan(4);
  expect(nod.ParamAngleX).toBeGreaterThan(7);
  expect(nod.ParamMouthOpenY).toBe(0);
  f.performance.setGesture();
  const neutral = f.tick(2.5).live2dParams;
  expect(Math.abs(neutral.ParamAngleY!)).toBeLessThan(2);
  expect(neutral.ParamAngleX).toBeGreaterThan(7);
});

it('opens the mouth with playback level and closes it on silence', () => {
  const f = fixture();
  f.performance.audio(.7);
  expect(f.tick(.25).live2dParams.ParamMouthOpenY).toBeGreaterThan(.4);
  f.performance.audio(0);
  expect(f.tick(.3).live2dParams.ParamMouthOpenY).toBeLessThan(.02);
});

it('uses the rig-specific head parameter and respects reversed gaze mapping', () => {
  const profile = botCallProfile({ AngleZ: range(-30, 30), ParamEyeBallX: range(-1, 1) }, 'local.model3.json', 'Model', [
    { Input: 'FaceAngleZ', OutputLive2D: 'Missing', OutputRangeLower: -20, OutputRangeUpper: 20 },
    { Input: 'FaceAngleZ', OutputLive2D: 'AngleZ', OutputRangeLower: -30, OutputRangeUpper: 30 },
    { Input: 'EyeRightX', OutputLive2D: 'ParamEyeBallX', OutputRangeLower: 1, OutputRangeUpper: -1 },
  ]);
  expect(profile.parameterMap.headZ).toMatchObject({ targets: ['AngleZ'], scale: 30 });
  expect(profile.parameterMap.gazeX).toMatchObject({ targets: ['ParamEyeBallX'], scale: -1 });
  const f = fixture(); f.performance.setPresence('waiting');
  const waiting = f.tick(.75).live2dParams.ParamAngleZ!;
  f.performance.setPresence('speaking');
  const speaking = f.tick(.75).live2dParams.ParamAngleZ!;
  expect(speaking - waiting).toBeGreaterThan(1);
});

it('smoothly turns the eyes toward a new pointer target instead of snapping across UI boundaries', () => {
  const f = fixture(); f.performance.point(-1, -.6); const before = f.tick(.7).live2dParams.ParamEyeBallX!;
  f.performance.point(1, .6); const immediate = f.tick(1 / 60).live2dParams.ParamEyeBallX!;
  expect(before).toBeLessThan(-.8); expect(immediate).toBeLessThan(0);
  expect(immediate - before).toBeLessThan(.4);
  const settled = f.tick(.7).live2dParams;
  expect(settled.ParamEyeBallX).toBeGreaterThan(.8); expect(settled.ParamEyeBallY).toBeGreaterThan(.4);
});
