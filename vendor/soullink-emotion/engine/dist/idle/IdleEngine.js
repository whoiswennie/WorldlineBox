import { addFACS } from "../facs/FACSUtils";
import { BlinkController } from "./BlinkController";
import { BodySwayController } from "./BodySwayController";
import { BreathingController } from "./BreathingController";
import { GazeController } from "./GazeController";
import { IdleBiasController } from "./IdleBiasController";
import { MicroMotionController } from "./MicroMotionController";
import { deriveMotionSeed } from "../runtime/MotionStyle";
export class IdleEngine {
    blink;
    gaze;
    breathing;
    microMotion;
    bodySway;
    bias = new IdleBiasController();
    style;
    constructor(style = {}) {
        this.style = {
            seed: style.seed ?? 1,
            gazeStability: style.gazeStability ?? 0.72,
            blinkRate: style.blinkRate ?? 1,
            breathRate: style.breathRate ?? 1,
            breathVariance: style.breathVariance ?? 0.42,
            microMotionGain: style.microMotionGain ?? 1
        };
        this.blink = new BlinkController(deriveMotionSeed(this.style.seed, 1), this.style.blinkRate);
        this.gaze = new GazeController(deriveMotionSeed(this.style.seed, 2), this.style.gazeStability);
        this.breathing = new BreathingController(deriveMotionSeed(this.style.seed, 3));
        this.microMotion = new MicroMotionController(deriveMotionSeed(this.style.seed, 4));
        this.bodySway = new BodySwayController(deriveMotionSeed(this.style.seed, 5));
    }
    setBias(bias, duration, timeSeconds) {
        this.bias.setBias(bias, duration, timeSeconds);
    }
    deferBlink(timeSeconds, duration) {
        this.blink.defer(timeSeconds, duration);
    }
    resetBias() {
        this.bias.reset();
    }
    reset() {
        this.bias.reset();
        this.blink = new BlinkController(deriveMotionSeed(this.style.seed, 1), this.style.blinkRate);
        this.gaze = new GazeController(deriveMotionSeed(this.style.seed, 2), this.style.gazeStability);
        this.breathing = new BreathingController(deriveMotionSeed(this.style.seed, 3));
        this.microMotion = new MicroMotionController(deriveMotionSeed(this.style.seed, 4));
        this.bodySway = new BodySwayController(deriveMotionSeed(this.style.seed, 5));
    }
    update(timeSeconds, options) {
        if (!options.enabled) {
            return this.bias.update(timeSeconds);
        }
        const focusLevel = options.focusLevel;
        let result = {};
        result = addFACS(result, this.breathing.update(timeSeconds, {
            rate: this.style.breathRate,
            variance: this.style.breathVariance
        }));
        result = addFACS(result, this.microMotion.update(timeSeconds, focusLevel, this.style.microMotionGain));
        result = addFACS(result, this.bodySway.update(timeSeconds, focusLevel, options.profile, options.bodyMotionGain ?? 1));
        result = addFACS(result, this.gaze.update(timeSeconds, focusLevel, options.profile.idleConfig));
        result = addFACS(result, this.blink.update(timeSeconds, focusLevel));
        result = addFACS(result, this.bias.update(timeSeconds));
        return result;
    }
}
