import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { ModelProfile } from "../profile/ModelProfile";
export declare class BodySwayController {
    private random;
    private from;
    private current;
    private target;
    private moveStartedAt;
    private moveDuration;
    private holdUntil;
    constructor(seed?: number);
    update(timeSeconds: number, focusLevel: number, profile: ModelProfile, gain?: number): PartialFACSLikeState;
    private recenter;
    private pickNextTarget;
    private pickValue;
    private rangeFor;
    private toLayer;
}
