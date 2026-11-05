import type { PartialFACSLikeState } from "../facs/FACSLikeState";
export interface GazeRangeConfig {
    gazeX?: [number, number];
    gazeY?: [number, number];
}
export declare class GazeController {
    private random;
    private fromX;
    private fromY;
    private currentX;
    private currentY;
    private targetX;
    private targetY;
    private moveStartedAt;
    private moveDuration;
    private holdUntil;
    private stability;
    constructor(seed?: number, stability?: number);
    update(timeSeconds: number, focusLevel: number, config: GazeRangeConfig): PartialFACSLikeState;
    private pickNextTarget;
    private pickScaledTarget;
}
