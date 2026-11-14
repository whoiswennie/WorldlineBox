import type { PartialFACSLikeState, SoullinkRuntime } from '@soullink-emotion/engine';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));

/** Display-only orchestration of the SDK's continuous layers. It never produces chat. */
export class BotCallPerformance {
  private manual: PartialFACSLikeState = {};
  private pointer: { x: number; y: number; at: number } | undefined;
  private pointerPose = { x: 0, y: 0, weight: 0 };
  private gesture: { kind: 'nod' | 'shake' | 'blink'; at: number } | undefined;
  private gazeEnabled = true;
  private presence: 'idle' | 'waiting' | 'speaking' = 'idle';
  private presenceAt = 0;
  private presencePose = { headZ: 0, bodyX: 0 };
  private idleEnabled = true;
  private audioLevel = 0;
  private lastAudioAt = -Infinity;

  constructor(readonly engine: SoullinkRuntime, private readonly clock: () => number, private readonly reducedMotion = false) {
    engine.setParameterGain(1.05); engine.setBodyMotionGain(reducedMotion ? .45 : 1.1);
    engine.setLipSyncEnabled(true);
    engine.setAudioLevelAnalyzer({ getLevel: () => this.audioLevel });
    engine.reset(0);
  }

  pose(values: PartialFACSLikeState) { this.manual = { ...this.manual, ...values }; }
  audio(value: number) {
    this.audioLevel = clamp(value, 0, 1);
    if (this.audioLevel > 0) {
      this.lastAudioAt = this.clock();
      this.engine.setVoicePlaybackActive(true);
    }
  }
  gaze(enabled: boolean) { this.gazeEnabled = enabled; if (!enabled) this.pointer = undefined; }
  point(x: number, y: number) { if (this.gazeEnabled) this.pointer = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), at: this.clock() }; }
  leave() { this.pointer = undefined; }
  setGesture(kind?: 'nod' | 'shake' | 'blink') { this.gesture = kind ? { kind, at: this.clock() } : undefined; }
  idle(enabled: boolean) { this.idleEnabled = enabled; this.engine.setIdleEnabled(enabled); }
  setPresence(value: typeof this.presence) {
    if (value === this.presence) return;
    this.presence = value;
    this.presenceAt = this.clock();
  }
  reset() { this.manual = {}; this.pointer = undefined; this.pointerPose = { x: 0, y: 0, weight: 0 }; this.gesture = undefined; this.audioLevel = 0; this.lastAudioAt = -Infinity; this.engine.reset(this.clock()); }

  update(time: number, delta: number) {
    const elapsed = Math.max(0, time - this.presenceAt);
    const presenceGain = this.idleEnabled && this.presence !== 'idle' ? (this.reducedMotion ? .4 : 1) : 0;
    const ease = 1 - Math.exp(-clamp(delta, 0, .1) / .28);
    const speaking = this.presence === 'speaking';
    const tilt = speaking ? .045 + Math.sin(elapsed * 2.1) * .035 : -.08 + Math.sin(elapsed * 1.2) * .035;
    this.presencePose.headZ += (tilt * presenceGain - this.presencePose.headZ) * ease;
    this.presencePose.bodyX += ((speaking ? .045 : -.04) * presenceGain - this.presencePose.bodyX) * ease;
    let pose: PartialFACSLikeState = {};
    if (presenceGain || Math.abs(this.presencePose.headZ) + Math.abs(this.presencePose.bodyX) > .001) pose = { ...this.presencePose };
    const weight = this.pointer ? clamp((2.2 - (time - this.pointer.at)) / .8, 0, 1) : 0;
    const blend = 1 - Math.exp(-clamp(delta, 0, .1) / .09);
    this.pointerPose.x += ((this.pointer?.x ?? this.pointerPose.x) - this.pointerPose.x) * blend;
    this.pointerPose.y += ((this.pointer?.y ?? this.pointerPose.y) - this.pointerPose.y) * blend;
    this.pointerPose.weight += (weight - this.pointerPose.weight) * blend;
    if (this.pointerPose.weight > .001) {
      const x = this.pointerPose.x * this.pointerPose.weight, y = this.pointerPose.y * this.pointerPose.weight;
      pose = { ...pose, gazeX: x, gazeY: y, headX: x * .14, headY: y * .08 };
    }
    if (!weight) this.pointer = undefined;
    pose = { ...pose, ...this.manual };
    if (this.gesture) {
      const progress = (time - this.gesture.at) / (this.gesture.kind === 'blink' ? .24 : .9);
      if (progress >= 1) this.gesture = undefined;
      else if (this.gesture.kind === 'blink') pose.eyeOpen = Math.abs(progress * 2 - 1);
      else if (this.gesture.kind === 'nod') pose.headY = Math.sin(progress * Math.PI * 2) * .35;
      else pose.headX = Math.sin(progress * Math.PI * 4) * .35;
    }
    if (!this.audioLevel && time - this.lastAudioAt > .18) this.engine.setVoicePlaybackActive(false);
    this.engine.setManualFACS(pose);
    return this.engine.update(time, clamp(delta, 0, .1));
  }
}
