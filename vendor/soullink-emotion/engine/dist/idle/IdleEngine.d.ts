import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { ModelProfile } from "../profile/ModelProfile";
export interface IdleEngineStyle {
    seed?: number;
    gazeStability?: number;
    blinkRate?: number;
    breathRate?: number;
    breathVariance?: number;
    microMotionGain?: number;
}
export interface IdleEngineOptions {
    enabled: boolean;
    focusLevel: number;
    profile: ModelProfile;
    bodyMotionGain?: number;
}
export declare class IdleEngine {
    private blink;
    private gaze;
    private breathing;
    private microMotion;
    private bodySway;
    private bias;
    private style;
    constructor(style?: IdleEngineStyle);
    setBias(bias: PartialFACSLikeState, duration: number, timeSeconds: number): void;
    deferBlink(timeSeconds: number, duration: number): void;
    resetBias(): void;
    reset(): void;
    update(timeSeconds: number, options: IdleEngineOptions): PartialFACSLikeState;
}
