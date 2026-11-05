import type { FACSKey } from "../facs/FACSLikeState";
import type { ModelProfile } from "./ModelProfile";
/** Return the FACS key families that share a smoothing value */
export declare function smoothingForFACS(key: FACSKey): number;
type ProfileRules = Pick<ModelProfile, "parameterMap" | "customParams">;
/** Derive neutral parameter values from the profile's parameterMap and customParams.
 *  eyeOpen targets → 1, breath target → 0.5, all others → 0.
 *  Returns {} if parameterMap/customParams are empty. */
export declare function deriveNeutralParams(profile: Pick<ModelProfile, "parameterMap"> & Partial<Pick<ModelProfile, "customParams">>): Record<string, number>;
/** Derive per-parameter smoothing values from the profile's parameterMap and customParams. */
export declare function deriveParameterSmoothing(profile: ProfileRules): Record<string, number>;
/** Derive per-parameter {min, max} ranges from the profile's parameterMap/customParams (for gain clamping). */
export declare function deriveParameterRanges(profile: ProfileRules): Record<string, {
    min?: number;
    max?: number;
}>;
export {};
