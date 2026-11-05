import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { SoullinkActionBeat } from "./SoullinkPlan";
export declare class ActionPlanSequencer {
    private beats;
    private startedAt;
    private actionUnitSolver;
    start(beats: SoullinkActionBeat[] | undefined, timeSeconds: number): void;
    reset(): void;
    get beatCount(): number;
    get duration(): number;
    isComplete(timeSeconds: number): boolean;
    evaluate(timeSeconds: number): PartialFACSLikeState;
}
