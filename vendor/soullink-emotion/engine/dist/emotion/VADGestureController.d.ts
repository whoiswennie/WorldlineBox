import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { VADRuntimeState } from "./VADState";
export interface VADGestureOptions {
    enabled: boolean;
    bodyMotionGain?: number;
    frequency?: number;
    avoidRepeatWindow?: number;
}
export interface VADGestureState {
    activeLabel: string | null;
    recentLabels: string[];
    nextAllowedGestureAt: number;
}
export declare class VADGestureController {
    private readonly seed;
    private previousTarget;
    private gesture;
    private random;
    private nextAllowedGestureAt;
    private recentGestureLabels;
    constructor(seed?: number);
    reset(): void;
    getState(): VADGestureState;
    update(timeSeconds: number, vad: VADRuntimeState, options: VADGestureOptions): PartialFACSLikeState;
    private getTargetDelta;
    private maybeStartGesture;
    private evaluateGesture;
}
