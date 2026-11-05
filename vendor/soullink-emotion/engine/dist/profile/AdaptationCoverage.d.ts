import type { ModelCapabilities, ModelProfile } from "./ModelProfile";
export type MappingSource = "standard-group" | "standard-id" | "name-match" | "llm" | "derived" | "unmapped" | "unknown";
export interface FACSKeyCoverage {
    key: string;
    status: "mapped" | "unmapped";
    source: MappingSource;
    targets: string[];
    confidence: "high" | "medium" | "low";
    capability?: string;
}
export interface UnmappedCdiParameter {
    id: string;
    name: string;
    groupId: string;
    groupName: string;
    guessedFacsKey?: string;
}
export interface AdaptationCoverage {
    schemaVersion: 1;
    modelDir: string;
    facsKeyCount: number;
    mappedKeyCount: number;
    perKey: FACSKeyCoverage[];
    unmappedKeys: string[];
    lowConfidenceKeys: string[];
    cdiParameterCount: number;
    usedCdiParameterCount: number;
    unmappedCdiParameters: UnmappedCdiParameter[];
    capabilities: ModelCapabilities;
    provider: string;
}
export interface CdiParamLike {
    id: string;
    name: string;
    groupId: string;
    groupName: string;
}
export interface CoverageInput {
    modelDir: string;
    provider?: string;
    provenance?: Record<string, MappingSource>;
}
/** Membership check over the standard Cubism parameter ids. */
export declare function isStandardId(id: string): boolean;
/**
 * Best-effort hint: guess which FACS key an unmapped CDI parameter probably
 * corresponds to, from simple name needles over id + name + groupName.
 * Returns undefined when nothing matches. Hint only — never authoritative.
 */
export declare function guessFacsKey(param: CdiParamLike): string | undefined;
/**
 * Compute a response-only adaptation-coverage diagnostic for a model profile.
 * Pure: never mutates inputs and never touches disk. This must never be written
 * into soullink.profile.json.
 */
export declare function computeAdaptationCoverage(profile: ModelProfile, params: CdiParamLike[], input: CoverageInput): AdaptationCoverage;
