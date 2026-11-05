import type { Live2DParamState, PartialFACSLikeState } from "../facs/FACSLikeState";
import type { ModelProfile } from "./ModelProfile";
export declare class ModelProfileAdapter {
    private profile;
    constructor(profile: ModelProfile);
    setProfile(profile: ModelProfile): void;
    getProfile(): ModelProfile;
    apply(facs: PartialFACSLikeState, customChannels?: Record<string, number>): Live2DParamState;
    private applyLegacy;
    private applyV2;
    private getTargets;
    private mapValue;
    private clampRuleValue;
}
