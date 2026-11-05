import type { ModelProfile } from "./ModelProfile.js";
export declare const CURRENT_SCHEMA_VERSION = 2;
export declare function effectiveSchemaVersion(profile: ModelProfile): number;
export interface ProfileValidationResult {
    ok: boolean;
    profile: ModelProfile;
    errors: string[];
    warnings: string[];
}
export declare function validateModelProfile(raw: unknown): ProfileValidationResult;
export declare function migrateProfile(raw: unknown): {
    profile: ModelProfile;
    fromVersion: number;
    toVersion: number;
    changes: string[];
};
