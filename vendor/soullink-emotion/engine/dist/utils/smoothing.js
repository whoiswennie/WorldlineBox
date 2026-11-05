export function smoothDamp(current, target, factor) {
    return current + (target - current) * factor;
}
export function smoothingFactor(speed, deltaSeconds) {
    return 1 - Math.exp(-Math.max(0, speed) * Math.max(0, deltaSeconds));
}
