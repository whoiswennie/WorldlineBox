export interface FACSActionUnitState {
    au01InnerBrowRaiser: number;
    au02OuterBrowRaiser: number;
    au04BrowLowerer: number;
    au05UpperLidRaiser: number;
    au06CheekRaiser: number;
    au07LidTightener: number;
    au09NoseWrinkler: number;
    au10UpperLipRaiser: number;
    au12LipCornerPuller: number;
    au14Dimpler: number;
    au15LipCornerDepressor: number;
    au17ChinRaiser: number;
    au18LipPucker: number;
    au20LipStretcher: number;
    au23LipTightener: number;
    au24LipPressor: number;
    au25LipsPart: number;
    au26JawDrop: number;
    au27MouthStretch: number;
    au45Blink: number;
    gazeX: number;
    gazeY: number;
    headX: number;
    headY: number;
    headZ: number;
    bodyX: number;
    bodyY: number;
    bodyZ: number;
    blush: number;
    tear: number;
    sweat: number;
    breath: number;
}
export type FACSActionUnitKey = keyof FACSActionUnitState;
export type PartialFACSActionUnitState = Partial<FACSActionUnitState>;
export interface ActionUnitDefinition {
    key: FACSActionUnitKey;
    code: string;
    label: string;
    group: "brow" | "eye" | "midface" | "mouth" | "extension";
    min: number;
    max: number;
}
export declare const actionUnitDefinitions: ActionUnitDefinition[];
export declare const actionUnitKeys: (keyof FACSActionUnitState)[];
