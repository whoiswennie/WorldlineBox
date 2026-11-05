import { smoothingFactor, smoothDamp } from "../utils/smoothing";
export class LayeredParameterMixer {
    current = {};
    reset() {
        this.current = {};
    }
    smooth(target, deltaSeconds, speedByParam = {}) {
        const result = { ...this.current };
        const keys = new Set([...Object.keys(this.current), ...Object.keys(target)]);
        for (const key of keys) {
            const current = this.current[key] ?? target[key] ?? 0;
            const next = target[key] ?? 0;
            const speed = speedByParam[key] ?? 14;
            const factor = smoothingFactor(speed, deltaSeconds);
            result[key] = smoothDamp(current, next, factor);
        }
        this.current = result;
        return result;
    }
}
