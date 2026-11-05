import type { PartialFACSLikeState } from "../facs/FACSLikeState";
export declare class RecoveryController {
    private startedAt;
    private duration;
    private from;
    start(from: PartialFACSLikeState, duration: number, timeSeconds: number): void;
    reset(): void;
    get active(): boolean;
    isComplete(timeSeconds: number): boolean;
    update(timeSeconds: number): PartialFACSLikeState;
}
