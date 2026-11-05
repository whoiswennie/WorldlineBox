import { scaleFACSFromNeutral } from "../facs/FACSUtils";
export class RecoveryController {
    startedAt = 0;
    duration = 0;
    from = {};
    start(from, duration, timeSeconds) {
        this.from = { ...from };
        this.duration = Math.max(0.2, duration);
        this.startedAt = timeSeconds;
    }
    reset() {
        this.from = {};
        this.duration = 0;
        this.startedAt = 0;
    }
    get active() {
        return this.duration > 0;
    }
    isComplete(timeSeconds) {
        return this.active && timeSeconds - this.startedAt >= this.duration;
    }
    update(timeSeconds) {
        if (!this.active)
            return {};
        const progress = Math.min(1, (timeSeconds - this.startedAt) / this.duration);
        const weight = Math.pow(1 - progress, 1.8);
        return scaleFACSFromNeutral(this.from, weight);
    }
}
