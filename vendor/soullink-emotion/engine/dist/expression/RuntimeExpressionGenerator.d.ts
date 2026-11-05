import type { FACSLikeState } from "../facs/FACSLikeState";
import type { RuntimeExpression } from "./EmotionArchetype";
export interface CharacterPersonality {
    expressiveness: number;
    softness: number;
    shyness: number;
    gazeStability: number;
}
export interface ExpressionGenerateInput {
    emotion: string;
    variant?: string;
    intensity: number;
    contextTags: string[];
    personality: CharacterPersonality;
    previousState: FACSLikeState;
    seed: number;
}
export declare class RuntimeExpressionGenerator {
    generate(input: ExpressionGenerateInput): RuntimeExpression;
    private mergeRanges;
    private sampleFACS;
    private applyContextBias;
    private buildTimeline;
    private createTransitionStart;
    private createTransitionTarget;
    private createLivingVariant;
    private isActiveFromNeutral;
    private createIdleBias;
}
