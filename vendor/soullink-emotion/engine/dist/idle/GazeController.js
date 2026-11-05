import { clamp } from "../utils/clamp";
import { lerp } from "../utils/lerp";
import { seededRandom } from "../utils/seededRandom";
export class GazeController {
    random;
    fromX = 0;
    fromY = 0;
    currentX = 0;
    currentY = 0;
    targetX = 0;
    targetY = 0;
    moveStartedAt = 0;
    moveDuration = 0.8;
    holdUntil = 0;
    stability;
    constructor(seed = 13, stability = 0.72) {
        this.random = seededRandom(seed);
        this.stability = clamp(stability, 0, 1);
    }
    update(timeSeconds, focusLevel, config) {
        if (focusLevel > 0.5) {
            const t = Math.min(1, focusLevel);
            this.currentX = lerp(this.currentX, 0, 0.06 + t * 0.08);
            this.currentY = lerp(this.currentY, 0, 0.06 + t * 0.08);
            return { gazeX: this.currentX, gazeY: this.currentY };
        }
        if (timeSeconds >= this.holdUntil) {
            this.pickNextTarget(timeSeconds, config);
        }
        const local = this.moveDuration <= 0 ? 1 : clamp((timeSeconds - this.moveStartedAt) / this.moveDuration, 0, 1);
        const eased = local < 0.5 ? 2 * local * local : 1 - Math.pow(-2 * local + 2, 2) / 2;
        this.currentX = lerp(this.fromX, this.targetX, eased);
        this.currentY = lerp(this.fromY, this.targetY, eased);
        return {
            gazeX: this.currentX,
            gazeY: this.currentY
        };
    }
    pickNextTarget(timeSeconds, config) {
        const xRange = config.gazeX ?? [-0.1, 0.1];
        const yRange = config.gazeY ?? [-0.05, 0.07];
        const rangeScale = 1.12 - this.stability * 0.54;
        this.fromX = this.currentX;
        this.fromY = this.currentY;
        this.targetX = this.pickScaledTarget(xRange, rangeScale);
        this.targetY = this.pickScaledTarget(yRange, rangeScale);
        this.moveStartedAt = timeSeconds;
        this.moveDuration = 0.55 + this.stability * 0.5 + this.random() * (0.9 + this.stability * 0.62);
        this.holdUntil = timeSeconds + this.moveDuration + 0.8 + this.stability * 1.25
            + this.random() * (1.7 + this.stability * 1.8);
    }
    pickScaledTarget(range, scale) {
        const center = (range[0] + range[1]) / 2;
        const half = (range[1] - range[0]) / 2 * scale;
        return center - half + this.random() * half * 2;
    }
}
