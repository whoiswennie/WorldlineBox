import { clamp } from "../utils/clamp";
import { lerp } from "../utils/lerp";
import { seededRandom } from "../utils/seededRandom";
const swayKeys = ["bodyX", "bodyY", "bodyZ", "headX", "headY", "headZ"];
const defaultRanges = {
    bodyX: [-0.045, 0.045],
    bodyY: [-0.014, 0.014],
    bodyZ: [-0.055, 0.055],
    headX: [-0.028, 0.028],
    headY: [-0.016, 0.018],
    headZ: [-0.034, 0.034]
};
const profileRangeScale = {
    bodyX: 1,
    bodyY: 0.65,
    bodyZ: 1,
    headX: 0.45,
    headY: 0.42,
    headZ: 0.58
};
function neutralPose() {
    return {
        bodyX: 0,
        bodyY: 0,
        bodyZ: 0,
        headX: 0,
        headY: 0,
        headZ: 0
    };
}
export class BodySwayController {
    random;
    from = neutralPose();
    current = neutralPose();
    target = neutralPose();
    moveStartedAt = 0;
    moveDuration = 2.2;
    holdUntil = 0;
    constructor(seed = 29) {
        this.random = seededRandom(seed);
    }
    update(timeSeconds, focusLevel, profile, gain = 1) {
        const focus = clamp(focusLevel, 0, 1);
        const motionGain = clamp(gain, 0, 4);
        if (focus > 0.5) {
            this.recenter(0.06 + focus * 0.08);
            return this.toLayer((1 - focus * 0.76) * motionGain);
        }
        if (timeSeconds >= this.holdUntil) {
            this.pickNextTarget(timeSeconds, profile);
        }
        const local = this.moveDuration <= 0
            ? 1
            : clamp((timeSeconds - this.moveStartedAt) / this.moveDuration, 0, 1);
        const eased = local * local * local * (local * (local * 6 - 15) + 10);
        for (const key of swayKeys) {
            this.current[key] = lerp(this.from[key], this.target[key], eased);
        }
        return this.toLayer(motionGain);
    }
    recenter(amount) {
        for (const key of swayKeys) {
            this.current[key] = lerp(this.current[key], 0, amount);
            this.from[key] = this.current[key];
            this.target[key] = 0;
        }
    }
    pickNextTarget(timeSeconds, profile) {
        this.from = { ...this.current };
        const bodyX = this.pickValue("bodyX", profile);
        const bodyZ = this.pickValue("bodyZ", profile);
        const headXRange = this.rangeFor("headX", profile);
        const headZRange = this.rangeFor("headZ", profile);
        this.target = {
            bodyX,
            bodyY: this.pickValue("bodyY", profile),
            bodyZ,
            headX: clamp(this.pickValue("headX", profile) + bodyX * 0.32, headXRange[0], headXRange[1]),
            headY: this.pickValue("headY", profile),
            headZ: clamp(this.pickValue("headZ", profile) + bodyZ * 0.42, headZRange[0], headZRange[1])
        };
        this.moveStartedAt = timeSeconds;
        this.moveDuration = 1.45 + this.random() * 2.35;
        this.holdUntil = timeSeconds + this.moveDuration + 0.55 + this.random() * 1.85;
    }
    pickValue(key, profile) {
        const [min, max] = this.rangeFor(key, profile);
        const centerBias = this.random() < 0.22 ? 0.38 : 1;
        const center = (min + max) / 2;
        const half = (max - min) / 2 * centerBias;
        return center - half + this.random() * half * 2;
    }
    rangeFor(key, profile) {
        const configured = profile.idleConfig[key];
        if (!configured)
            return defaultRanges[key];
        const center = (configured[0] + configured[1]) / 2;
        const half = (configured[1] - configured[0]) / 2 * profileRangeScale[key];
        return [center - half, center + half];
    }
    toLayer(weight) {
        return {
            bodyX: this.current.bodyX * weight,
            bodyY: this.current.bodyY * weight,
            bodyZ: this.current.bodyZ * weight,
            headX: this.current.headX * weight,
            headY: this.current.headY * weight,
            headZ: this.current.headZ * weight
        };
    }
}
