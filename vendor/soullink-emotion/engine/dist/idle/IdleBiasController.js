import { scaleFACS } from "../facs/FACSUtils";
export class IdleBiasController {
    bias = {};
    startedAt = 0;
    duration = 0;
    setBias(bias, duration, timeSeconds) {
        this.bias = { ...bias };
        this.duration = Math.max(0.1, duration);
        this.startedAt = timeSeconds;
    }
    reset() {
        this.bias = {};
        this.duration = 0;
        this.startedAt = 0;
    }
    update(timeSeconds) {
        if (this.duration <= 0)
            return {};
        const progress = Math.min(1, (timeSeconds - this.startedAt) / this.duration);
        const residue = Math.pow(1 - progress, 0.82);
        if (progress >= 1) {
            this.reset();
            return {};
        }
        return scaleFACS(this.bias, residue);
    }
}
