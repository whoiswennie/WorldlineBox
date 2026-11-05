import type { ModelProfile, ParameterMap } from '@soullink-emotion/engine';
import type { Live2DMotionParameterInfo } from '@soullink-emotion/live2d-pixi';

export const BOT_CALL_TIMEOUT_MS = 60000;
export const BOT_CALL_RINGTONE_SECONDS = 26;
export const BOT_CALL_PORTRAIT_SCALE = 1.9;
export interface BotCallExpression { name: string; file: string; params: string[] }
export interface BotCallMotion { name: string; file: string; group: string; index: number; duration: number; params: string[] }
export interface BotCallModelCatalog { expressions: BotCallExpression[]; motions: BotCallMotion[]; credits: string; license: string }
export const botCallClock = (elapsed: number) => `${Math.floor(Math.max(0, elapsed) / 60000).toString().padStart(2, '0')}:${Math.floor(Math.max(0, elapsed) / 1000 % 60).toString().padStart(2, '0')}`;
export function botCallProfile(parameters: Record<string, Live2DMotionParameterInfo>, modelPath: string, catalog?: BotCallModelCatalog): ModelProfile {
  const source: ParameterMap = {
    headX: { target: 'ParamAngleX', scale: 30 }, headY: { target: 'ParamAngleY', scale: 24 }, headZ: { target: 'ParamAngleZ', scale: 24 },
    bodyX: { target: 'ParamBodyAngleX', scale: 10 }, bodyY: { target: 'ParamBodyAngleY', scale: 8 }, bodyZ: { target: 'ParamBodyAngleZ', scale: 8 },
    eyeOpen: { targets: ['ParamEyeLOpen', 'ParamEyeROpen'], scale: 1 }, eyeBlinkL: { target: 'ParamEyeLOpen', mode: 'add', scale: -1 }, eyeBlinkR: { target: 'ParamEyeROpen', mode: 'add', scale: -1 },
    eyeSmile: { targets: ['ParamEyeLSmile', 'ParamEyeRSmile'], scale: 1 }, gazeX: { target: 'ParamEyeBallX', scale: 1 }, gazeY: { target: 'ParamEyeBallY', scale: 1 },
    mouthOpen: { target: 'ParamMouthOpenY', scale: 1 }, mouthSmile: { target: 'ParamMouthForm', scale: .4 }, mouthFrown: { target: 'ParamMouthForm', mode: 'subtract', scale: .4 },
    browInnerUp: { targets: ['ParamBrowLY', 'ParamBrowRY'], scale: 1 }, browDown: { targets: ['ParamBrowLY', 'ParamBrowRY'], mode: 'subtract', scale: .7 },
    browOuterUp: { targets: ['ParamBrowLY', 'ParamBrowRY'], mode: 'add', scale: .45 },
    breath: { target: 'ParamBreath', scale: 1 }, blush: { target: 'key7', scale: .16 },
  };
  const parameterMap: ParameterMap = {};
  for (const [key, rule] of Object.entries(source)) {
    const targets = (rule.targets ?? (rule.target ? [rule.target] : [])).filter(id => parameters[id]);
    if (!targets.length) continue;
    const ranges = targets.map(id => parameters[id]!);
    Object.assign(parameterMap, { [key]: { ...rule, target: undefined, targets, mode: rule.mode ?? 'set', min: Math.min(...ranges.map(value => value.min)), max: Math.max(...ranges.map(value => value.max)) } });
  }
  const idleMotion = catalog?.motions.find(motion => motion.group === 'Idle' && motion.name === 'IDLE');
  return { modelId: 'worldlinebox-deepseek-chan', displayName: '大肥鱼', version: '1.1.0', schemaVersion: 2, modelPath, parameterMap,
    capabilities: {
      headControl: !!(parameterMap.headX || parameterMap.headY || parameterMap.headZ), bodyControl: !!(parameterMap.bodyX || parameterMap.bodyY || parameterMap.bodyZ),
      eyeBlink: !!(parameterMap.eyeBlinkL || parameterMap.eyeBlinkR), eyeSmile: !!parameterMap.eyeSmile, gazeControl: !!(parameterMap.gazeX || parameterMap.gazeY),
      mouthOpen: !!parameterMap.mouthOpen, mouthSmile: !!parameterMap.mouthSmile, browControl: !!(parameterMap.browInnerUp || parameterMap.browDown),
      blush: !!parameterMap.blush, tear: false, sweat: false, breath: !!parameterMap.breath,
    },
    idleConfig: { headX: [-.14, .14], headY: [-.09, .1], headZ: [-.14, .14], bodyX: [-.11, .11], bodyY: [-.04, .04], bodyZ: [-.12, .12], gazeX: [-.2, .2], gazeY: [-.12, .14] },
    nativeAnimations: catalog ? { expressions: catalog.expressions, motions: catalog.motions } : undefined,
    // Costume, prop and body-type expressions stay explicitly user controlled.
    // Natural emotion is continuous FACS; only the rig's neutral idle clip is automatic.
    motionMap: idleMotion ? Object.fromEntries(['neutral', 'happy', 'shy', 'curious', 'concerned', 'sad', 'tired', 'confused', 'excited'].map(emotion => [emotion, { group: idleMotion.group, index: idleMotion.index, priority: 'idle' as const }])) : undefined,
    neutralParams: Object.fromEntries(Object.entries(parameters).filter(([id]) => Object.values(parameterMap).some(rule => rule?.targets?.includes(id))).map(([id, info]) => [id, info.default])) };
}
