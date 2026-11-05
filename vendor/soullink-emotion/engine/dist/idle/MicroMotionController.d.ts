import type { PartialFACSLikeState } from "../facs/FACSLikeState";
export declare class MicroMotionController {
    private phases;
    private rates;
    constructor(seed?: number);
    update(timeSeconds: number, focusLevel: number, gain?: number): PartialFACSLikeState;
}
