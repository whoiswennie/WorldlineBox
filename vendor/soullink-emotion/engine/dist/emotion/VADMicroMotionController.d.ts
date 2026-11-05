import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { VADVector } from "./VADState";
export declare class VADMicroMotionController {
    private readonly seed;
    private previous;
    private pulse;
    private random;
    private nextAllowedPulseAt;
    private phases;
    constructor(seed?: number);
    reset(): void;
    update(timeSeconds: number, vad: VADVector, focusLevel: number, bodyMotionGain?: number): PartialFACSLikeState;
    private getDelta;
    private maybeStartPulse;
    private continuousLayer;
    private pulseLayer;
    private createPhases;
}
