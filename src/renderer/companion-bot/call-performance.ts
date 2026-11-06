import type { ModelProfile, PartialFACSLikeState, SoullinkRuntime, SpeechPerformanceCapabilities, SpeechPerformancePlanner } from '@soullink-emotion/engine';

/** Measurements belong to the actual playing audio, never an estimated text clock. */
export interface BotCallSpeechState { playing: boolean; level: number; durationSeconds?: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));

/** Display-only orchestration of the SDK's continuous layers. It never produces chat. */
export class BotCallPerformance {
  private manual: PartialFACSLikeState = {};
  private pointer: { x: number; y: number; at: number } | undefined;
  private pointerPose = { x: 0, y: 0, weight: 0 };
  private gesture: { kind: 'nod' | 'shake' | 'blink'; at: number } | undefined;
  private speaking = false;
  private level = 0;
  private speechOrdinal = 0;
  private segmentEnds = 0;
  private gazeEnabled = true;

  constructor(readonly engine: SoullinkRuntime, private readonly planner: SpeechPerformancePlanner,
    private readonly profile: ModelProfile, private readonly capabilities: SpeechPerformanceCapabilities,
    private readonly clock: () => number, reducedMotion = false) {
    engine.setParameterGain(1.05); engine.setBodyMotionGain(reducedMotion ? .45 : 1.1);
    engine.setLipSyncEnabled(true);
    engine.setAudioLevelAnalyzer({ getLevel: () => this.level, getPeak: () => this.level, isAvailable: () => true, reset: () => { this.level = 0; } });
    engine.reset(0);
  }

  react(text: string) { this.engine.sendMessage(text.slice(0, 4000), this.clock()); }
  pose(values: PartialFACSLikeState) { this.manual = { ...this.manual, ...values }; }
  gaze(enabled: boolean) { this.gazeEnabled = enabled; if (!enabled) this.pointer = undefined; }
  point(x: number, y: number) { if (this.gazeEnabled) this.pointer = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), at: this.clock() }; }
  leave() { this.pointer = undefined; }
  triggerGesture(kind: 'nod' | 'shake' | 'blink') { this.gesture = { kind, at: this.clock() }; }
  idle(enabled: boolean) { this.engine.setIdleEnabled(enabled); }
  reset() { this.manual = {}; this.pointer = undefined; this.pointerPose = { x: 0, y: 0, weight: 0 }; this.gesture = undefined; this.speaking = false; this.level = 0; this.engine.reset(this.clock()); this.planner.clear(); }

  speech(state: BotCallSpeechState) {
    const start = state.playing && !this.speaking, stop = !state.playing && this.speaking;
    this.speaking = state.playing;
    this.engine.setVoicePlaybackActive(state.playing);
    this.level = state.playing ? clamp(state.level, 0, 1) : 0;
    if (start) this.planSpeech(state.durationSeconds);
    if (stop) this.engine.finishSpeechPerformance(this.clock());
  }

  private planSpeech(durationSeconds = 12) {
    const now = this.clock(), state = this.engine.getSnapshot(), seconds = clamp(durationSeconds, .5, 120);
    const plan = this.planner.plan({ emotion: state.vad.dominantEmotion, vad: state.vad.current,
      intensity: Math.min(.65, state.vad.intensity || .35), confidence: .7, durationMs: seconds * 1000,
      currentPosture: state.facs, turnOrdinal: ++this.speechOrdinal, capabilities: this.capabilities });
    this.engine.startSpeechPerformance(plan, now, 'replace'); this.segmentEnds = now + seconds;
  }

  update(time: number, delta: number) {
    // Long audio can continue across SDK performance segments without freezing its pose.
    if (this.speaking && time >= this.segmentEnds) this.planSpeech();
    let pose: PartialFACSLikeState = {};
    const weight = this.pointer ? clamp((2.2 - (time - this.pointer.at)) / .8, 0, 1) : 0;
    const blend = 1 - Math.exp(-clamp(delta, 0, .1) / .09);
    this.pointerPose.x += ((this.pointer?.x ?? this.pointerPose.x) - this.pointerPose.x) * blend;
    this.pointerPose.y += ((this.pointer?.y ?? this.pointerPose.y) - this.pointerPose.y) * blend;
    this.pointerPose.weight += (weight - this.pointerPose.weight) * blend;
    if (this.pointerPose.weight > .001) {
      const x = this.pointerPose.x * this.pointerPose.weight, y = this.pointerPose.y * this.pointerPose.weight;
      pose = { gazeX: x, gazeY: y, headX: x * .14, headY: y * .08 };
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
    // Audio owns only the mouth during playback. It does not freeze gaze or posture.
    if (this.speaking) delete pose.mouthOpen;
    this.engine.setManualFACS(pose);
    const snapshot = this.engine.update(time, clamp(delta, 0, .1)), parameters = { ...snapshot.live2dParams };
    const mouthRule = this.profile.parameterMap.mouthOpen;
    for (const id of mouthRule?.targets ?? (mouthRule?.target ? [mouthRule.target] : [])) {
      if (!this.speaking) parameters[id] = clamp(this.manual.mouthOpen ?? 0, 0, 1);
    }
    return { ...snapshot, live2dParams: parameters, speaking: this.speaking };
  }
}
