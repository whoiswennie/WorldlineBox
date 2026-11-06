import { expect, it } from 'vitest';
import { SoullinkRuntime, SpeechPerformancePlanner, deriveSpeechPerformanceCapabilities } from '@soullink-emotion/engine';
import { BotCallPerformance } from '../../src/renderer/companion-bot/call-performance';
import { botCallProfile, type BotCallModelCatalog } from '../../src/renderer/companion-bot/call-presentation';

const range = (min: number, max: number, value = 0) => ({ min, max, default: value });
const modelParameters = {
  ParamAngleX: range(-30, 30), ParamAngleY: range(-30, 30), ParamAngleZ: range(-30, 30),
  ParamBodyAngleX: range(-30, 30), ParamBodyAngleY: range(-30, 30), ParamBodyAngleZ: range(-30, 30),
  ParamEyeLOpen: range(0, 1.5, 1), ParamEyeROpen: range(0, 1.5, 1), ParamEyeBallX: range(-1, 1), ParamEyeBallY: range(-1, 1),
  ParamMouthOpenY: range(0, 1), ParamMouthForm: range(-1, 1), ParamBrowLY: range(-1, 1), ParamBrowRY: range(-1, 1), ParamBreath: range(0, 1), key7: range(0, 1),
  Clothes2: range(0, 2), key10: range(0, 1),
};
const catalog: BotCallModelCatalog = { credits: '', license: '',
  expressions: [{ name: '脸红', file: 'Exp3/脸红.exp3.json', params: ['key7'] }, { name: '体型2', file: 'Exp3/体型2.exp3.json', params: ['Clothes2'] }],
  motions: [{ name: 'IDLE', group: 'Idle', index: 0, file: 'Animation/IDLE.motion3.json', duration: 6, params: ['ParamAngleX'] }, { name: '脱帽', group: 'Interaction', index: 0, file: 'Animation/脱帽.motion3.json', duration: 2, params: ['key10'] }] };
function fixture() {
  let time = 0;
  const profile = botCallProfile(modelParameters, 'local.model3.json', catalog);
  const engine = new SoullinkRuntime({ profile, motionStyle: { seed: 20261105, spontaneity: 1, microMotionGain: 1.15, idleActionGain: 1.1, gazeStability: .64 } });
  const performance = new BotCallPerformance(engine, new SpeechPerformancePlanner(), profile, deriveSpeechPerformanceCapabilities(profile), () => time);
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

it('drives mouth opening from measured playback, closes during silence, then returns to idle without erasing emotion', () => {
  const f = fixture(); f.tick(1); f.performance.react('今天成功通过了，非常开心！'); f.tick(1);
  f.performance.speech({ playing: true, level: .8, durationSeconds: 12 });
  const speaking = f.tick(.6); expect(speaking.state).toBe('SPEAKING'); expect(speaking.live2dParams.ParamMouthOpenY).toBeGreaterThan(.7);
  expect(speaking.vad.current.valence).toBeGreaterThan(0);
  f.performance.speech({ playing: true, level: 0 }); const silence = f.tick(1); expect(silence.live2dParams.ParamMouthOpenY).toBeLessThan(.015);
  const emotion = silence.vad.current.valence;
  f.performance.speech({ playing: false, level: 1 }); const ended = f.tick(1 / 60);
  expect(ended.state).toBe('IDLE'); expect(ended.live2dParams.ParamMouthOpenY).toBe(0);
  expect(ended.vad.current.valence).toBeGreaterThan(emotion * .8);
  expect(f.tick(4).live2dParams.ParamBreath).not.toBe(ended.live2dParams.ParamBreath);
});

it('keeps explicit pose controls, releases stale pointer focus, and gives the mouth to actual audio only while playing', () => {
  const f = fixture(); f.tick(1); f.performance.pose({ headX: .3, mouthOpen: .7 }); f.performance.point(.9, -.6);
  expect(f.tick(.5).live2dParams.ParamMouthOpenY).toBe(.7);
  f.performance.speech({ playing: true, level: .7, durationSeconds: 3 }); const speaking = f.tick(.6);
  expect(speaking.live2dParams.ParamMouthOpenY).toBeGreaterThan(.65); expect(speaking.live2dParams.ParamAngleX).toBeGreaterThan(8);
  f.performance.speech({ playing: false, level: 0 }); const released = f.tick(3);
  expect(Math.abs(released.live2dParams.ParamEyeBallX!)).toBeLessThan(.3); expect(released.live2dParams.ParamMouthOpenY).toBe(.7);
  f.performance.reset(); expect(f.tick(1 / 60).live2dParams.ParamMouthOpenY).toBe(0);
});

it('uses an expressive mouth range for emotionally neutral speech, follows syllables and closes quickly between them', () => {
  const f = fixture(); f.tick(1);
  f.performance.speech({ playing: true, level: .4, durationSeconds: 5 });
  const vowel = f.tick(.12).live2dParams.ParamMouthOpenY!;
  expect(vowel).toBeGreaterThan(.35);
  f.performance.speech({ playing: true, level: .95 });
  const loud = f.tick(.12).live2dParams.ParamMouthOpenY!;
  expect(loud).toBeGreaterThan(.75); expect(loud).toBeLessThanOrEqual(1);
  f.performance.speech({ playing: true, level: 0 });
  expect(f.tick(.25).live2dParams.ParamMouthOpenY).toBeLessThan(.08);
  f.performance.speech({ playing: false, level: .95 });
  expect(f.tick(1 / 60).live2dParams.ParamMouthOpenY).toBe(0);
});

it('preserves continuous message emotion and binds only the neutral native clip, never automatic outfits or props', () => {
  const f = fixture(); expect(f.profile.capabilities?.blush).toBe(true); expect(f.profile.nativeAnimations?.expressions).toHaveLength(2);
  f.tick(1); f.performance.react('你真可爱，我喜欢你。'); const reaction = f.tick(1);
  expect(reaction.nativeAnimation?.motion?.group).toBe('Idle'); expect(reaction.nativeAnimation?.expression).toBeNull();
  expect(Object.values(f.profile.motionMap ?? {}).every(binding => binding.group === 'Idle')).toBe(true);
  expect(f.profile.expressionMap).toBeUndefined();
  const snapshots = Array.from({ length: 600 }, () => f.tick(1 / 60));
  expect(Math.max(...snapshots.map(snapshot => snapshot.live2dParams.key7 ?? 0))).toBeLessThan(.2);
  expect(snapshots.some(snapshot => (snapshot.live2dParams.key7 ?? 0) > .01)).toBe(true);
});

it('smoothly turns the eyes toward a new pointer target instead of snapping across UI boundaries', () => {
  const f = fixture(); f.performance.point(-1, -.6); const before = f.tick(.7).live2dParams.ParamEyeBallX!;
  f.performance.point(1, .6); const immediate = f.tick(1 / 60).live2dParams.ParamEyeBallX!;
  expect(before).toBeLessThan(-.8); expect(immediate).toBeLessThan(0);
  expect(immediate - before).toBeLessThan(.4);
  const settled = f.tick(.7).live2dParams;
  expect(settled.ParamEyeBallX).toBeGreaterThan(.8); expect(settled.ParamEyeBallY).toBeGreaterThan(.4);
});
