import type { Live2DMotionParameterInfo } from "./types";
export interface CDI3ParameterDefinition {
    Id?: string;
    Name?: string;
    GroupId?: string;
}
export interface CDI3ParameterGroupDefinition {
    Id?: string;
    Name?: string;
}
/** Subset of a Cubism `.cdi3.json` file used by the metadata scanner. */
export interface CDI3Data {
    Version?: number;
    Parameters?: CDI3ParameterDefinition[];
    ParameterGroups?: CDI3ParameterGroupDefinition[];
}
/** Subset of a Cubism `.model3.json` file needed to locate DisplayInfo. */
export interface Model3Data {
    FileReferences?: {
        DisplayInfo?: string;
    };
}
export interface CDIParameterMeta {
    name?: string;
    groupId?: string;
    groupName?: string;
}
export interface MetadataFetchResponse {
    ok: boolean;
    json(): Promise<unknown>;
}
/** A deliberately small fetch contract so callers can inject authenticated or test clients. */
export type Live2DMetadataFetch = (url: string) => Promise<MetadataFetchResponse>;
export interface Live2DMetadataLoadOptions {
    fetch?: Live2DMetadataFetch;
    /** Base used when `modelUrl` itself is relative, useful during SSR and in Node tests. */
    documentBaseUrl?: string;
    onWarning?: (message: string, cause?: unknown) => void;
}
export interface CubismCoreModelLike {
    getParameterCount?: () => number;
    getParameterId?: (index: number) => string;
    getParameterMinimumValue?: (index: number) => number;
    getParameterMaximumValue?: (index: number) => number;
    getParameterDefaultValue?: (index: number) => number;
    getParameterValueByIndex?: (index: number) => number;
    _model?: {
        parameters?: {
            ids?: string[];
            minimumValues?: number[];
            maximumValues?: number[];
            defaultValues?: number[];
            values?: ArrayLike<number>;
        };
    };
}
export declare function readCurrentParameters(core?: CubismCoreModelLike): Record<string, number>;
/** Structural input accepted by `buildMotionParameters`; no PIXI class is required. */
export interface Live2DCoreParameterSource {
    internalModel?: {
        coreModel?: CubismCoreModelLike;
    };
}
/** Convert parsed CDI3 JSON into an id-indexed metadata table. */
export declare function parseCDIParameterMeta(cdi: CDI3Data): Record<string, CDIParameterMeta>;
/** Return the DisplayInfo path from parsed model3 JSON, if it is present. */
export declare function parseModel3DisplayInfo(model3: Model3Data): string | null;
/**
 * Resolve an asset path relative to a model URL. Relative model URLs use
 * `documentBaseUrl`, or the current page URL when running in a browser.
 */
export declare function resolveRelativeURL(modelUrl: string, relativePath: string, documentBaseUrl?: string): string;
/** Derive the conventional sibling CDI3 URL without loading model3 JSON. */
export declare function deriveCDIUrl(modelUrl: string): string | null;
export declare function loadCDIParameterMeta(modelUrl: string, options?: Live2DMetadataLoadOptions): Promise<Record<string, CDIParameterMeta>>;
export declare function resolveCDIUrl(modelUrl: string, options?: Live2DMetadataLoadOptions): Promise<string | null>;
export declare function buildMotionParameters(model: Live2DCoreParameterSource, cdiMeta?: Record<string, CDIParameterMeta>): Record<string, Live2DMotionParameterInfo>;
