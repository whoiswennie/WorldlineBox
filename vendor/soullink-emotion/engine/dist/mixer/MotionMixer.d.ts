import type { FACSLikeState, PartialFACSLikeState } from "../facs/FACSLikeState";
export interface MotionMixerInput {
    idle?: PartialFACSLikeState;
    emotion?: PartialFACSLikeState;
    reaction?: PartialFACSLikeState;
    speech?: PartialFACSLikeState;
    speechPerformance?: PartialFACSLikeState;
    manual?: PartialFACSLikeState;
}
export declare class MotionMixer {
    mix(input: MotionMixerInput): FACSLikeState;
    private applyLayer;
}
