import type { PartialFACSLikeState } from "../facs/FACSLikeState";
export declare class IdleBiasController {
    private bias;
    private startedAt;
    private duration;
    setBias(bias: PartialFACSLikeState, duration: number, timeSeconds: number): void;
    reset(): void;
    update(timeSeconds: number): PartialFACSLikeState;
}
