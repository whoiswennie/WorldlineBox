import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { VADVector } from "./VADState";
export interface VADExpressionResidue {
    emotion: string;
    facs: PartialFACSLikeState;
}
export interface VADExpressionMapperOptions {
    dominantEmotion?: string;
    residue?: VADExpressionResidue | null;
    styleGain?: number;
}
export declare class VADExpressionMapper {
    toFACS(vad: VADVector, weight?: number, options?: VADExpressionMapperOptions): PartialFACSLikeState;
    private getArchetypeStyle;
    private applyStyle;
}
