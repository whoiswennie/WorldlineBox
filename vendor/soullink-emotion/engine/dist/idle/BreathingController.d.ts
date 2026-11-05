import type { PartialFACSLikeState } from "../facs/FACSLikeState";
export interface BreathingOptions {
    rate?: number;
    variance?: number;
}
export declare class BreathingController {
    private phase;
    private modulationPhase;
    private secondaryPhase;
    constructor(seed?: number);
    update(timeSeconds: number, options?: BreathingOptions): PartialFACSLikeState;
}
