import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { RuntimeExpression } from "../expression/EmotionArchetype";
export declare class ReactionSequencer {
    private expression;
    private startedAt;
    start(expression: RuntimeExpression, timeSeconds: number): void;
    reset(): void;
    get currentExpression(): RuntimeExpression | null;
    get duration(): number;
    elapsed(timeSeconds: number): number;
    isComplete(timeSeconds: number): boolean;
    evaluate(timeSeconds: number): PartialFACSLikeState;
    hold(weight?: number): PartialFACSLikeState;
}
