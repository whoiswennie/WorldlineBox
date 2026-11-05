import { addFACS, clampFACSState, scaleFACSFromNeutral } from "../facs/FACSUtils";
import { ActionUnitSolver } from "../expression/ActionUnitSolver";
import { clamp01 } from "../utils/clamp";
function envelope(progress) {
    const t = clamp01(progress);
    return Math.sin(Math.PI * t);
}
export class ActionPlanSequencer {
    beats = [];
    startedAt = 0;
    actionUnitSolver = new ActionUnitSolver();
    start(beats, timeSeconds) {
        this.beats = (beats ?? [])
            .filter((beat) => beat.duration > 0 && beat.intensity > 0)
            .slice(0, 12)
            .sort((a, b) => a.time - b.time);
        this.startedAt = timeSeconds;
    }
    reset() {
        this.beats = [];
        this.startedAt = 0;
    }
    get beatCount() {
        return this.beats.length;
    }
    get duration() {
        return this.beats.reduce((max, beat) => Math.max(max, beat.time + beat.duration), 0);
    }
    isComplete(timeSeconds) {
        return this.beats.length === 0 || Math.max(0, timeSeconds - this.startedAt) >= this.duration;
    }
    evaluate(timeSeconds) {
        if (this.beats.length === 0)
            return {};
        const elapsed = Math.max(0, timeSeconds - this.startedAt);
        let result = {};
        for (const beat of this.beats) {
            const local = (elapsed - beat.time) / beat.duration;
            if (local < 0 || local > 1)
                continue;
            const weight = envelope(local) * clamp01(beat.intensity);
            let layer = {};
            if (beat.facs) {
                layer = addFACS(layer, scaleFACSFromNeutral(beat.facs, weight));
            }
            if (beat.actionUnits && Object.keys(beat.actionUnits).length > 0) {
                layer = addFACS(layer, scaleFACSFromNeutral(this.actionUnitSolver.solvePartial(beat.actionUnits), weight));
            }
            result = addFACS(result, layer);
        }
        return clampFACSState(result);
    }
}
