export function clamp(value, min = -Infinity, max = Infinity) {
    return Math.min(max, Math.max(min, value));
}
export function clamp01(value) {
    return clamp(value, 0, 1);
}
