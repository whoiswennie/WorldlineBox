import { type FACSActionUnitKey, type FACSActionUnitState, type PartialFACSActionUnitState } from "./FACSActionUnitState";
export declare function actionUnitRangeForKey(key: FACSActionUnitKey): [number, number];
export declare function clampActionUnitValue(key: FACSActionUnitKey, value: number): number;
export declare function clampActionUnitState<T extends PartialFACSActionUnitState>(state: T): T;
export declare function normalizeActionUnits(partial: PartialFACSActionUnitState): FACSActionUnitState;
export declare function addActionUnits(base: PartialFACSActionUnitState, overlay: PartialFACSActionUnitState, weight?: number): PartialFACSActionUnitState;
