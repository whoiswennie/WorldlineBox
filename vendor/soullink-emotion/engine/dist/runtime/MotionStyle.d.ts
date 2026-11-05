export interface MotionStyleOptions {
    /** Reuse a seed to reproduce the same local motion sequence. */
    seed?: number;
    /** Overall chance of low-frequency spontaneous idle actions. */
    spontaneity?: number;
    /** Frequency multiplier for VAD transition gestures. */
    gestureFrequency?: number;
    /** 0 looks around often, 1 keeps the gaze comparatively steady. */
    gazeStability?: number;
    /** Natural blink frequency multiplier. */
    blinkRate?: number;
    /** Breathing tempo multiplier. */
    breathRate?: number;
    /** Amount of non-periodic breathing variation. */
    breathVariance?: number;
    /** Gain applied to continuous small head and face motion. */
    microMotionGain?: number;
    /** Gain applied to discrete spontaneous idle actions. */
    idleActionGain?: number;
    /** Number of recent action labels avoided when choosing the next action. */
    avoidRepeatWindow?: number;
    /** Gain applied to speech-onset and speech-peak accents. */
    speechAccentGain?: number;
}
export interface ResolvedMotionStyle {
    seed: number;
    spontaneity: number;
    gestureFrequency: number;
    gazeStability: number;
    blinkRate: number;
    breathRate: number;
    breathVariance: number;
    microMotionGain: number;
    idleActionGain: number;
    avoidRepeatWindow: number;
    speechAccentGain: number;
}
export type MotionStylePresetName = "natural" | "lively" | "calm" | "shy";
export declare const motionStylePresets: Readonly<Record<MotionStylePresetName, Readonly<MotionStyleOptions>>>;
export declare function resolveMotionStyle(options?: MotionStyleOptions, fallbackGazeStability?: number, fallbackSeed?: number): ResolvedMotionStyle;
export declare function createMotionSeed(): number;
export declare function deriveMotionSeed(seed: number, channel: number): number;
