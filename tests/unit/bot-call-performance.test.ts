import { expect, it } from 'vitest';
import { SoullinkRuntime } from '@soullink-emotion/engine';
import { BotCallPerformance } from '../../src/renderer/companion-bot/call-performance';
import { botCallProfile } from '../../src/renderer/companion-bot/call-presentation';
import { CallCharacterMotion } from '../../src/renderer/companion-bot/call-character-motion';
import { BlinkController } from '../../vendor/soullink-emotion/engine/src/idle/BlinkController';

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
  const tick = (seconds: number, foreground = false) => { let state = performance.update(time, 1 / 60, {}, foreground); const frames = Math.round(seconds * 60);
    for (let frame = 0; frame < frames; frame++) { time += 1 / 60; state = performance.update(time, 1 / 60, {}, foreground); } return state; };
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

it('lets the eyes lead the head and body, then eases the body back after releasing gaze', () => {
  const f = fixture();
  f.performance.idle(false);
  f.performance.point(1, 0);
  const early = f.tick(.15).live2dParams;
  const settled = f.tick(.95).live2dParams;
  expect(early.ParamEyeBallX!).toBeGreaterThan(settled.ParamEyeBallX! * .40);
  expect(early.ParamBodyAngleX!).toBeLessThan(settled.ParamBodyAngleX! * .30);
  expect(settled.ParamBodyAngleX!).toBeGreaterThan(2);
  f.performance.gaze(false);
  expect(f.tick(1.3).live2dParams.ParamBodyAngleX!).toBeLessThan(.4);
});

it('changes speech accents by punctuation and gives a directed cue priority', () => {
  const pose = (text: string, foreground = false) => {
    const f = fixture();
    f.performance.setPresence('speaking');
    f.performance.setSpeech(text, 1000);
    return f.tick(.62, foreground).live2dParams;
  };
  expect(pose('真的！').ParamAngleY! - pose('真的……').ParamAngleY!).toBeGreaterThan(2);
  expect(pose('真的？').ParamAngleZ!).toBeLessThan(pose('真的！').ParamAngleZ! - 1);
  expect(pose('真的！', true)).toEqual(pose('真的……', true));
});

it('renders the closed phase of a blink even when rendering resumes after a long frame', () => {
  const blink = new BlinkController(17);
  const eyes = Array.from({ length: 44 }, (_, step) => blink.update(step * .32, 0).eyeBlinkL);
  expect(eyes).toContain(1);
  expect(eyes.every((eye, index) => !eye || eyes[index + 1] === 0)).toBe(true);
});

it('schedules a full idle pose and yields to a touch or an explicit performance', () => {
  const profile = botCallProfile(modelParameters, 'local.model3.json');
  const parameters = { ...modelParameters, LEar1: range(-1, 1), REar1: range(-1, 1), FrontHairX1: range(-1, 1), SkirtLayerX1: range(-1, 1), LeanInput: range(-30, 30) };
  const motion = new CallCharacterMotion(profile, parameters, { reduced: false, nativeIdle: true, random: () => 0 });
  expect(new CallCharacterMotion(profile, modelParameters, { reduced: false, nativeIdle: true }).proceduralIdle).toBe(false);
  const sample = (time: number, idle = true, react = true) => motion.update(time, 1 / 60, idle, react, 0, idle);
  expect(sample(0).pose).toEqual({});
  sample(1.8);
  expect(sample(3).pose.bodyX).toBeLessThan(-.3);
  expect(sample(6).pose).toEqual({});
  const figure = { x: 0, y: 0, width: 100, height: 100 };
  const hit = motion.hit(44, 9, figure)!;
  expect(hit.zone).toBe('head');
  expect(hit.forehead).toBe(false);
  expect(motion.hit(44, 10.5, figure)?.forehead).toBe(true);
  expect([14, 35, 45, 95].map(y => motion.hit(44, y, figure)?.zone)).toEqual(['cheek', 'waist', 'hip', 'foot']);
  motion.press(6, hit.zone, hit.direction); motion.release(6);
  expect(sample(6.3, false).pose.eyeBlinkL).toBeGreaterThan(.5);
  expect(sample(6.3, false, false).pose).toEqual({});
  expect(sample(8, false).pose).toEqual({});
  motion.press(8, hit.zone, hit.direction);
  motion.move(.4); motion.move(-.4);
  motion.release(8.5);
  expect(sample(8.84, false).pose.eyeSmile).toBeGreaterThan(.45);
  motion.moveWindow({ screenX: 100, screenY: 200 }, 1 / 60);
  motion.moveWindow({ screenX: 145, screenY: 200 }, 1 / 60);
  const drag = sample(9.9, false);
  expect(drag.pose.bodyX).toBeLessThan(-.025);
  expect(drag.secondary.FrontHairX1).toBeLessThan(-.025);
  expect(drag.secondary.SkirtLayerX1).toBeLessThan(-.025);
  for (let i = 0; i < 60; i++) motion.moveWindow({ screenX: 145, screenY: 200 }, 1 / 60);
  expect(sample(10.9, false)).toEqual({ pose: {}, secondary: {} });
  const reduced = new CallCharacterMotion(profile, parameters, { reduced: true, random: () => 0 });
  reduced.update(0, 1 / 60, true, true, 0, true);
  expect(reduced.update(4, 1 / 60, true, true, 0, true)).toEqual({ pose: {}, secondary: {} });
});

it('keeps pressure and follow-through active after the initial cheek animation finishes', () => {
  const profile = botCallProfile(modelParameters, 'local.model3.json');
  const motion = new CallCharacterMotion(profile, modelParameters, { reduced: false });
  motion.press(0, 'cheek', -1);
  let frame = motion.update(0, 1 / 60, true, true, 0, true);
  for (let i = 1; i <= 190; i++) {
    if (i % 12 === 0) motion.move(i % 24 ? .28 : -.28, .035);
    frame = motion.update(i / 60, 1 / 60, true, true, 0, true);
  }
  expect(frame.touch?.zone).toBe('cheek');
  expect(frame.touch?.pressure).toBeGreaterThan(.55);
  expect(frame.pose.headY).toBeLessThan(-.06);
  motion.release(3.2);
  for (let i = 1; i <= 210; i++) frame = motion.update(3.2 + i / 60, 1 / 60, true, true, 0, true);
  expect(frame.touch).toBeUndefined();
});
