import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { VADVector } from "../emotion/VADState";
import type { ModelProfile } from "../profile/ModelProfile";
import { type EasingName } from "../utils/easing";
export type SpeechGestureChannel = "headX" | "headY" | "headZ" | "bodyX" | "bodyY" | "bodyZ" | "gazeX" | "gazeY";
export type SpeechExpressionChannel = "browInnerUp" | "browOuterUp" | "browDown" | "eyeSquint" | "eyeSmile" | "mouthSmile" | "mouthFrown" | "mouthPucker" | "blush" | "tear" | "sweat";
export declare const speechGestureChannels: readonly SpeechGestureChannel[];
export declare const speechExpressionChannels: readonly SpeechExpressionChannel[];
export declare const speechPerformanceSemanticChannels: Readonly<{
    speechGesture: readonly SpeechGestureChannel[];
    expressionAccent: readonly SpeechExpressionChannel[];
    mouthSync: readonly ["mouthOpen"];
    idleMotion: readonly ["breath", "eyeBlinkL", "eyeBlinkR"];
}>;
export interface SpeechPerformanceCurveFrame {
    at: number;
    value: number;
    easing?: EasingName;
}
export interface SpeechPerformanceCurve {
    range: [number, number];
    maxNormalizedVelocity: number;
    keyframes: readonly SpeechPerformanceCurveFrame[];
}
export type SpeechPerformanceCurveId = "softPulse" | "quickAttackSlowRelease" | "slowAttackQuickRelease" | "anticipationAccent" | "overshootSettle" | "dampedSpring" | "doublePulse" | "holdAndRelease";
export declare const SPEECH_PERFORMANCE_CURVES: Readonly<Record<SpeechPerformanceCurveId, SpeechPerformanceCurve>>;
export declare function sampleSpeechPerformanceCurve(curveId: SpeechPerformanceCurveId, progress: number): number;
export interface SpeechGestureTemplate {
    family: string;
    curveId: SpeechPerformanceCurveId;
    compatibleCurveIds: readonly SpeechPerformanceCurveId[];
    emotions: readonly string[];
    vad: readonly [number, number, number];
    durationRatio: number;
    durationBoundsMs: readonly [number, number];
    amplitudeBounds: readonly [number, number];
    cooldownGroup: string;
    semanticCues: readonly string[];
    deliveryHints: readonly string[];
    lateral?: boolean;
    channels: Readonly<Partial<Record<SpeechGestureChannel, number>>>;
}
export declare const SPEECH_GESTURE_TEMPLATES: Readonly<Record<string, SpeechGestureTemplate>>;
export declare const SUPPORTED_SPEECH_PERFORMANCE_EMOTIONS: readonly string[];
export interface SpeechPerformanceExpressionVariant {
    id: string;
    facs: Readonly<Partial<Record<SpeechExpressionChannel, number>>>;
    gestureAffinity: readonly string[];
}
export declare const SPEECH_EXPRESSION_VARIANTS: Readonly<Record<string, readonly SpeechPerformanceExpressionVariant[]>>;
export interface SpeechPerformanceMotionBudget {
    maxSimultaneousAxes?: number;
    maxMotionDensity?: number;
    minRestWindowMs?: number;
    usedMotionDensity?: number;
    maxSimultaneousAxesUsed?: number;
}
export type SpeechPerformancePlanToken = number;
export interface SpeechPerformanceCapabilities {
    enabled?: boolean;
    gestureChannels?: readonly SpeechGestureChannel[];
    expressionChannels?: readonly SpeechExpressionChannel[];
    channelScales?: Partial<Record<SpeechGestureChannel, number>>;
    maxGestureAmplitude?: number;
    gestureAmplitudeGain?: number;
    gestureLimit?: number;
    performanceTier?: "low" | "medium" | "high";
    reducedMotion?: boolean;
    motionBudget?: SpeechPerformanceMotionBudget;
}
export interface SpeechPerformancePlanInput {
    emotion?: string;
    vad?: Partial<VADVector>;
    intensity?: number;
    confidence?: number;
    emotionConfidence?: number;
    durationMs?: number;
    semanticCues?: readonly string[];
    deliveryHints?: readonly string[] | string;
    currentPosture?: Partial<Record<SpeechGestureChannel, number>>;
    history?: readonly SpeechPerformanceHistoryEntry[];
    audioPeaks?: readonly (number | {
        ratio?: number;
        timeRatio?: number;
        timeMs?: number;
        strength?: number;
        energy?: number;
    })[];
    turnOrdinal?: number;
    segmentOrdinal?: number;
    revision?: number;
    lifecycleToken?: SpeechPerformancePlanToken;
    seed?: number;
    capabilities?: SpeechPerformanceCapabilities;
}
export interface SpeechPerformanceGesture {
    id: string;
    templateId: string;
    family: string;
    cooldownGroup: string;
    curveId: SpeechPerformanceCurveId;
    startMs: number;
    durationMs: number;
    peakMs: number;
    restBeforeMs: number;
    direction: -1 | 1;
    channels: Partial<Record<SpeechGestureChannel, number>>;
    channelTimings?: Partial<Record<SpeechGestureChannel, {
        offsetMs: number;
        amplitudeScale: number;
    }>>;
    gazeCoordination?: {
        mode: "follow" | "noFollow" | "reverseFollow";
        headDelayMs: number | null;
        gazeChannels: SpeechGestureChannel[];
        headChannels: SpeechGestureChannel[];
    } | null;
}
export interface SpeechPerformanceExpression {
    emotion: string;
    variantId: string;
    facs: PartialFACSLikeState;
    supportedChannels: SpeechExpressionChannel[];
    gestureAffinity: string[];
}
export interface SpeechPerformancePlan {
    version: 1;
    lifecycleToken?: SpeechPerformancePlanToken;
    seed: number;
    emotion: string;
    vad: VADVector;
    intensity: number;
    confidence: number;
    semanticCues: string[];
    deliveryHints: string[];
    currentPosture: Partial<Record<SpeechGestureChannel, number>>;
    durationMs: number;
    motionBudget: Required<Pick<SpeechPerformanceMotionBudget, "maxSimultaneousAxes" | "maxMotionDensity" | "minRestWindowMs">> & {
        usedMotionDensity: number;
        maxSimultaneousAxesUsed: number;
    };
    expression: SpeechPerformanceExpression;
    gestures: SpeechPerformanceGesture[];
}
export interface SpeechPerformanceHistoryEntry {
    gestureId?: string;
    cooldownGroup?: string;
    direction?: -1 | 1;
    gazeFollowMode?: "follow" | "noFollow" | "reverseFollow";
    expressionVariantId?: string;
}
export interface SpeechPerformanceSample {
    speechGesture: PartialFACSLikeState;
    expressionAccent: PartialFACSLikeState;
    activeBeatIds: string[];
}
export declare function normalizeSpeechPerformanceEmotion(value?: string): string;
export declare function deriveSpeechPerformanceCapabilities(profile: ModelProfile, overrides?: SpeechPerformanceCapabilities): SpeechPerformanceCapabilities;
export declare function createSpeechPerformanceSeed(input?: {
    turnOrdinal?: number;
    segmentOrdinal?: number;
    emotion?: string;
    durationMs?: number;
    revision?: number;
}): number;
export declare function planSpeechPerformance(input?: SpeechPerformancePlanInput): SpeechPerformancePlan;
export declare function sampleSpeechPerformance(plan: SpeechPerformancePlan | undefined, elapsedMs: number): SpeechPerformanceSample;
export declare function validateSpeechPerformanceRegistries(): {
    valid: boolean;
    errors: string[];
};
export declare class SpeechPerformancePlanner {
    private history;
    private readonly historyLimit;
    private recordedSeeds;
    constructor(options?: {
        historyLimit?: number;
    });
    plan(input?: SpeechPerformancePlanInput): SpeechPerformancePlan;
    recordPlan(plan: SpeechPerformancePlan | undefined): void;
    getHistory(): SpeechPerformanceHistoryEntry[];
    clear(): void;
}
export declare function createSpeechPerformancePlanner(options?: {
    historyLimit?: number;
}): {
    plan: (input?: SpeechPerformancePlanInput) => SpeechPerformancePlan;
    evaluate: typeof sampleSpeechPerformance;
    recordPlan: (plan: SpeechPerformancePlan) => void;
    clear: () => void;
    getHistory: () => SpeechPerformanceHistoryEntry[];
};
