import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { VADVector } from "./VADState";
export interface ReflectionPulseInput {
    emotion?: string;
    vadTarget?: Partial<VADVector>;
    intensity?: number;
    seed?: number;
}
export declare class ReflectionPulseController {
    private pulse;
    start(input: ReflectionPulseInput, timeSeconds: number): void;
    update(timeSeconds: number): PartialFACSLikeState;
    reset(): void;
    private envelope;
}
