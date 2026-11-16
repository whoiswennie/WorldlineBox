import type { PartialFACSLikeState, SoullinkRuntime } from '@soullink-emotion/engine';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
type SpeechBeat = { at: number; duration: number; headY: number; headZ: number; brow: number };

function speechBeats(text: string, durationMs?: number): SpeechBeat[] {
  const phrases = text.match(/[^,，。！？!?…]+[,，。！？!?…]*/gu) ?? [];
  const lengths = phrases.map(phrase => Array.from(phrase.replace(/\s/gu, '')).length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!total) return [];
  const duration = durationMs ? durationMs / 1000 : clamp(total * .115 + .45, 1.1, 10);
  let words = 0;
  return phrases.flatMap((phrase, index) => {
    const length = lengths[index]!, span = duration * length / total;
    const at = duration * words / total + span * .30;
    words += length;
    if (!length) return [];
    if (/[?？]/u.test(phrase)) return [{ at, duration: clamp(span * .75, .35, .95), headY: .055, headZ: -.14, brow: .22 }];
    if (/[!！]/u.test(phrase)) return [{ at, duration: clamp(span * .64, .25, .62), headY: .16, headZ: .04, brow: .15 }];
    if (/…|\.{3}/u.test(phrase)) return [{ at, duration: clamp(span, .5, 1.2), headY: -.12, headZ: -.06, brow: 0 }];
    return [{ at, duration: clamp(span * .75, .3, .75), headY: .07, headZ: .03 * (index % 2 ? -1 : 1), brow: .04 }];
  });
}

/** Display-only orchestration of the SDK's continuous layers. It never produces chat. */
export class BotCallPerformance {
  private manual: PartialFACSLikeState = {};
  private pointer: { x: number; y: number; at: number } | undefined;
  private pointerPose = { x: 0, y: 0, weight: 0 };
  private headFollow = { x: 0, y: 0 };
  private bodyFollow = { x: 0, y: 0 };
  private gesture: { kind: 'nod' | 'shake' | 'blink'; at: number } | undefined;
  private gazeEnabled = true;
  private presence: 'idle' | 'waiting' | 'speaking' = 'idle';
  private presenceAt = 0;
  private presencePose = { headY: 0, headZ: 0, bodyX: 0, bodyY: 0 };
  private speechEnergy = 0;
  private speech = { at: 0, beats: [] as SpeechBeat[] };
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
  setSpeech(text = '', durationMs?: number) {
    this.speech = { at: this.clock(), beats: speechBeats(text, durationMs) };
  }
  get pointerWeight() { return this.pointerPose.weight; }
  get speaking() { return this.presence === 'speaking'; }
  get calm() { return this.presence === 'idle' && !this.gesture && this.clock() - this.lastAudioAt > .18; }
  get gesturing() { return !!this.gesture; }
  reset() {
    this.manual = {}; this.pointer = undefined; this.pointerPose = { x: 0, y: 0, weight: 0 };
    this.headFollow = { x: 0, y: 0 }; this.bodyFollow = { x: 0, y: 0 };
    this.gesture = undefined; this.audioLevel = 0; this.lastAudioAt = -Infinity;
    this.presencePose = { headY: 0, headZ: 0, bodyX: 0, bodyY: 0 }; this.speechEnergy = 0;
    this.setSpeech();
    this.engine.reset(this.clock());
  }

  update(time: number, delta: number, motion: PartialFACSLikeState = {}, foreground = false) {
    const dt = clamp(delta, 0, .1);
    const elapsed = Math.max(0, time - this.presenceAt);
    const presenceGain = this.idleEnabled && !foreground && this.presence !== 'idle' ? (this.reducedMotion ? .4 : 1) : 0;
    const ease = 1 - Math.exp(-dt / .28);
    const speaking = this.presence === 'speaking';
    this.speechEnergy += ((speaking ? this.audioLevel : 0) - this.speechEnergy) * (1 - Math.exp(-dt / .16));
    const accent = this.speechEnergy * .20 + Math.sin(elapsed * 2.6) * .045;
    const presenceTarget = speaking
      ? { headY: accent, headZ: .05 + Math.sin(elapsed * 1.8) * .06, bodyX: .10 + Math.sin(elapsed * 1.15) * .07, bodyY: accent * .62 }
      : { headY: -.035 + Math.sin(elapsed * 1.35) * .035, headZ: -.09 + Math.sin(elapsed * 1.2) * .035, bodyX: -.085, bodyY: -.06 };
    let pose = { ...motion };
    for (const key of ['headY', 'headZ', 'bodyX', 'bodyY'] as const) {
      this.presencePose[key] += (presenceTarget[key] * presenceGain - this.presencePose[key]) * ease;
      if (Math.abs(this.presencePose[key]) > .001) pose[key] = (pose[key] ?? 0) + this.presencePose[key];
    }
    if (speaking && presenceGain) {
      const spoken = time - this.speech.at;
      for (const beat of this.speech.beats) {
        const progress = (spoken - beat.at) / beat.duration;
        if (progress <= 0 || progress >= 1) continue;
        const weight = Math.sin(progress * Math.PI) ** 2 * presenceGain;
        pose.headY = (pose.headY ?? 0) + beat.headY * weight;
        pose.headZ = (pose.headZ ?? 0) + beat.headZ * weight;
        pose.browInnerUp = (pose.browInnerUp ?? 0) + beat.brow * weight;
      }
    }
    const weight = this.pointer ? clamp((2.2 - (time - this.pointer.at)) / .8, 0, 1) : 0;
    const blend = 1 - Math.exp(-dt / .07);
    this.pointerPose.x += ((this.pointer?.x ?? this.pointerPose.x) - this.pointerPose.x) * blend;
    this.pointerPose.y += ((this.pointer?.y ?? this.pointerPose.y) - this.pointerPose.y) * blend;
    this.pointerPose.weight += (weight - this.pointerPose.weight) * blend;
    const x = this.pointerPose.x * this.pointerPose.weight, y = this.pointerPose.y * this.pointerPose.weight;
    for (const axis of ['x', 'y'] as const) {
      this.headFollow[axis] += ((axis === 'x' ? x : y) - this.headFollow[axis]) * (1 - Math.exp(-dt / .14));
      this.bodyFollow[axis] += (this.headFollow[axis] - this.bodyFollow[axis]) * ease;
    }
    if (this.pointerPose.weight > .001) {
      pose.gazeX = x + (pose.gazeX ?? 0) * (1 - this.pointerPose.weight);
      pose.gazeY = y + (pose.gazeY ?? 0) * (1 - this.pointerPose.weight);
    }
    if (Math.abs(this.bodyFollow.x) + Math.abs(this.bodyFollow.y) + Math.abs(this.headFollow.x) + Math.abs(this.headFollow.y) > .001) {
      const gain = this.reducedMotion ? .38 : 1;
      pose.headX = (pose.headX ?? 0) + this.headFollow.x * .32 * gain;
      pose.headY = (pose.headY ?? 0) + this.headFollow.y * .22 * gain;
      pose.headZ = (pose.headZ ?? 0) - this.headFollow.x * .07 * gain;
      pose.bodyX = (pose.bodyX ?? 0) + this.bodyFollow.x * .38 * gain;
      pose.bodyY = (pose.bodyY ?? 0) + this.bodyFollow.y * .23 * gain;
      pose.bodyZ = (pose.bodyZ ?? 0) - this.bodyFollow.x * .18 * gain;
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
    return this.engine.update(time, dt);
  }
}
