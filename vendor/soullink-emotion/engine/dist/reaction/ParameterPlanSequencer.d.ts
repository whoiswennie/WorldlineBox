import type { Live2DParamState } from "../facs/FACSLikeState";
import type { SoullinkParameterBeat } from "./SoullinkPlan";
export declare class ParameterPlanSequencer {
    private beats;
    private startedAt;
    private lastActiveSignature;
    start(beats: SoullinkParameterBeat[] | undefined, timeSeconds: number): void;
    reset(): void;
    get beatCount(): number;
    evaluate(timeSeconds: number): Live2DParamState;
    private logActiveBeatChange;
}
