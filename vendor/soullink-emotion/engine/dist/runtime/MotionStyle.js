import { clamp } from "../utils/clamp";
export const motionStylePresets = {
    natural: {
        spontaneity: 1,
        gestureFrequency: 1,
        gazeStability: 0.72,
        blinkRate: 1,
        breathRate: 1,
        breathVariance: 0.42,
        microMotionGain: 1,
        idleActionGain: 1,
        avoidRepeatWindow: 3,
        speechAccentGain: 1
    },
    lively: {
        spontaneity: 1.32,
        gestureFrequency: 1.3,
        gazeStability: 0.5,
        blinkRate: 1.12,
        breathRate: 1.06,
        breathVariance: 0.58,
        microMotionGain: 1.16,
        idleActionGain: 1.12,
        avoidRepeatWindow: 4,
        speechAccentGain: 1.12
    },
    calm: {
        spontaneity: 0.68,
        gestureFrequency: 0.76,
        gazeStability: 0.86,
        blinkRate: 0.84,
        breathRate: 0.82,
        breathVariance: 0.28,
        microMotionGain: 0.72,
        idleActionGain: 0.8,
        avoidRepeatWindow: 4,
        speechAccentGain: 0.72
    },
    shy: {
        spontaneity: 0.92,
        gestureFrequency: 0.9,
        gazeStability: 0.56,
        blinkRate: 1.16,
        breathRate: 0.96,
        breathVariance: 0.52,
        microMotionGain: 0.9,
        idleActionGain: 0.88,
        avoidRepeatWindow: 4,
        speechAccentGain: 0.86
    }
};
export function resolveMotionStyle(options = {}, fallbackGazeStability = 0.72, fallbackSeed = createMotionSeed()) {
    return {
        seed: normalizeSeed(options.seed ?? fallbackSeed),
        spontaneity: clamp(options.spontaneity ?? 1, 0, 2),
        gestureFrequency: clamp(options.gestureFrequency ?? 1, 0, 2.5),
        gazeStability: clamp(options.gazeStability ?? fallbackGazeStability, 0, 1),
        blinkRate: clamp(options.blinkRate ?? 1, 0.25, 2.5),
        breathRate: clamp(options.breathRate ?? 1, 0.5, 1.8),
        breathVariance: clamp(options.breathVariance ?? 0.42, 0, 1),
        microMotionGain: clamp(options.microMotionGain ?? 1, 0, 2),
        idleActionGain: clamp(options.idleActionGain ?? 1, 0, 2),
        avoidRepeatWindow: Math.round(clamp(options.avoidRepeatWindow ?? 3, 0, 8)),
        speechAccentGain: clamp(options.speechAccentGain ?? 1, 0, 2)
    };
}
export function createMotionSeed() {
    const time = Date.now() >>> 0;
    const random = Math.floor(Math.random() * 0xffffffff) >>> 0;
    return normalizeSeed(time ^ random);
}
export function deriveMotionSeed(seed, channel) {
    let value = (normalizeSeed(seed) ^ Math.imul(channel + 1, 0x9e3779b1)) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x85ebca6b) >>> 0;
    value ^= value >>> 13;
    value = Math.imul(value, 0xc2b2ae35) >>> 0;
    value ^= value >>> 16;
    return normalizeSeed(value);
}
function normalizeSeed(seed) {
    if (!Number.isFinite(seed))
        return 1;
    return (Math.abs(Math.floor(seed)) >>> 0) || 1;
}
