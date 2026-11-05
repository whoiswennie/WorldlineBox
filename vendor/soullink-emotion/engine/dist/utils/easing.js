import { clamp01 } from "./clamp";
export function ease(name, t) {
    const x = clamp01(t);
    if (name === "easeIn")
        return x * x;
    if (name === "easeOut")
        return 1 - (1 - x) * (1 - x);
    if (name === "easeInOut")
        return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    return x;
}
