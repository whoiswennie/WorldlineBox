import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { PartialFACSActionUnitState } from "../facs/FACSActionUnitState";
export declare class ActionUnitSolver {
    solve(actionUnits: PartialFACSActionUnitState): PartialFACSLikeState;
    solvePartial(actionUnits: PartialFACSActionUnitState): PartialFACSLikeState;
    project(facs: PartialFACSLikeState): PartialFACSActionUnitState;
}
