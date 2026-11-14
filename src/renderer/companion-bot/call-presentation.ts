import type { BotCallModel } from '../../shared/companion-call';
import type { ModelProfile, ParameterMap } from '@soullink-emotion/engine';
import type { Live2DMotionParameterInfo } from '@soullink-emotion/live2d-pixi';

export const BOT_CALL_TIMEOUT_MS = 60000;
export const BOT_CALL_PORTRAIT_SCALE = 1.9;
export const botCallClock = (elapsed: number) => `${Math.floor(Math.max(0, elapsed) / 60000).toString().padStart(2, '0')}:${Math.floor(Math.max(0, elapsed) / 1000 % 60).toString().padStart(2, '0')}`;
export function botCallProfile(parameters: Record<string, Live2DMotionParameterInfo>, modelPath: string, name = 'Live2D', vts?: BotCallModel['vtsParameters']): ModelProfile {
  const source: ParameterMap = {
    headX: { target: 'ParamAngleX', scale: 30 }, headY: { target: 'ParamAngleY', scale: 24 }, headZ: { target: 'ParamAngleZ', scale: 24 },
    bodyX: { target: 'ParamBodyAngleX', scale: 10 }, bodyY: { target: 'ParamBodyAngleY', scale: 8 }, bodyZ: { target: 'ParamBodyAngleZ', scale: 8 },
    eyeOpen: { targets: ['ParamEyeLOpen', 'ParamEyeROpen'], scale: 1 }, eyeBlinkL: { target: 'ParamEyeLOpen', mode: 'add', scale: -1 }, eyeBlinkR: { target: 'ParamEyeROpen', mode: 'add', scale: -1 },
    eyeSmile: { targets: ['ParamEyeLSmile', 'ParamEyeRSmile'], scale: 1 }, gazeX: { target: 'ParamEyeBallX', scale: 1 }, gazeY: { target: 'ParamEyeBallY', scale: 1 },
    mouthOpen: { target: 'ParamMouthOpenY', scale: 1 }, mouthSmile: { target: 'ParamMouthForm', scale: .4 }, mouthFrown: { target: 'ParamMouthForm', mode: 'subtract', scale: .4 },
    browInnerUp: { targets: ['ParamBrowLY', 'ParamBrowRY'], scale: 1 }, browDown: { targets: ['ParamBrowLY', 'ParamBrowRY'], mode: 'subtract', scale: .7 },
    browOuterUp: { targets: ['ParamBrowLY', 'ParamBrowRY'], mode: 'add', scale: .45 },
    breath: { target: 'ParamBreath', scale: 1 },
  };
  const channels = { headX: ['FaceAngleX'], headY: ['FaceAngleY'], headZ: ['FaceAngleZ'], bodyX: ['BodyAngleX'], bodyY: ['BodyAngleY'], bodyZ: ['BodyAngleZ'],
    gazeX: ['EyeLeftX', 'EyeRightX'], gazeY: ['EyeLeftY', 'EyeRightY'], mouthOpen: ['MouthOpen', 'JawOpen'], eyeSmile: ['MouthSmile'], browInnerUp: ['BrowInnerUp'] } as const;
  for (const [key, inputs] of Object.entries(channels) as Array<[keyof typeof channels, readonly string[]]>) {
    const mapping = inputs.map(input => vts?.find(item => input === item.Input && Object.hasOwn(parameters, item.OutputLive2D)
      && !/^position[xyz]$/iu.test(item.OutputLive2D)
      && (key !== 'eyeSmile' || /eyes?smile/iu.test(item.OutputLive2D)))).find(Boolean);
    if (mapping) {
      const span = (mapping.OutputRangeUpper - mapping.OutputRangeLower) / (key === 'mouthOpen' || key === 'eyeSmile' || key === 'browInnerUp' ? 1 : 2);
      source[key] = { target: mapping.OutputLive2D, scale: span };
    }
  }
  const breath = vts?.find(item => item.UseBreathing && Object.hasOwn(parameters, item.OutputLive2D));
  if (breath) source.breath = { target: breath.OutputLive2D, scale: breath.OutputRangeUpper - breath.OutputRangeLower, offset: breath.OutputRangeLower };
  const parameterMap: ParameterMap = {};
  for (const [key, rule] of Object.entries(source)) {
    const targets = (rule.targets ?? (rule.target ? [rule.target] : [])).filter(id => Object.hasOwn(parameters, id));
    if (!targets.length) continue;
    const ranges = targets.map(id => parameters[id]!);
    const offset = rule.offset ?? (targets.length === 1 && !rule.mode && !['eyeSmile', 'mouthOpen', 'breath'].includes(key) ? ranges[0]?.default : undefined);
    Object.assign(parameterMap, { [key]: { ...rule, offset, target: undefined, targets, mode: rule.mode ?? 'set', min: Math.min(...ranges.map(value => value.min)), max: Math.max(...ranges.map(value => value.max)) } });
  }
  return { modelId: modelPath, displayName: name, version: '1.1.0', schemaVersion: 2, modelPath, parameterMap,
    capabilities: {
      headControl: !!(parameterMap.headX || parameterMap.headY || parameterMap.headZ), bodyControl: !!(parameterMap.bodyX || parameterMap.bodyY || parameterMap.bodyZ),
      eyeBlink: !!(parameterMap.eyeBlinkL || parameterMap.eyeBlinkR), eyeSmile: !!parameterMap.eyeSmile, gazeControl: !!(parameterMap.gazeX || parameterMap.gazeY),
      mouthOpen: !!parameterMap.mouthOpen, mouthSmile: !!parameterMap.mouthSmile, browControl: !!(parameterMap.browInnerUp || parameterMap.browDown),
      blush: !!parameterMap.blush, tear: false, sweat: false, breath: !!parameterMap.breath,
    },
    idleConfig: { headX: [-.14, .14], headY: [-.09, .1], headZ: [-.14, .14], bodyX: [-.11, .11], bodyY: [-.04, .04], bodyZ: [-.12, .12], gazeX: [-.2, .2], gazeY: [-.12, .14] },
    neutralParams: Object.fromEntries(Object.entries(parameters).filter(([id]) => Object.values(parameterMap).some(rule => rule?.targets?.includes(id))).map(([id, info]) => [id, info.default])) };
}
