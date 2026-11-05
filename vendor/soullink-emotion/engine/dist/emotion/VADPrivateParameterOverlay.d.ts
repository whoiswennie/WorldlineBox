import type { Live2DParamState } from "../facs/FACSLikeState";
import type { PrivateEmotionMap } from "../profile/ModelProfile";
import type { VADRuntimeState } from "./VADState";
export interface VADPrivateParameterInfo {
    name?: string;
    groupId?: string;
    groupName?: string;
    min: number;
    max: number;
    default: number;
}
export interface VADPrivateParameterSummary {
    totalParameters: number;
    candidateCount: number;
    categories: Record<string, number>;
}
export interface VADPrivateParameterUpdateContext {
    /** Semantic intent may be more specific than the VAD-derived label (for example, confused). */
    intentEmotion?: string;
    intentVariant?: string;
}
export declare class VADPrivateParameterOverlay {
    private candidates;
    private declaredCandidates;
    private totalParameters;
    private activeExclusiveCategory;
    private activeVariantByCategory;
    setParameters(parameters: Record<string, VADPrivateParameterInfo>, privateEmotionMap?: PrivateEmotionMap, profileMappedIds?: ReadonlySet<string>): void;
    getSummary(): VADPrivateParameterSummary;
    update(vadState: VADRuntimeState, weight?: number, context?: VADPrivateParameterUpdateContext): Live2DParamState;
}
