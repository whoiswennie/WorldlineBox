import { clamp01 } from "../utils/clamp";
import { pickOne, randomRange } from "../utils/randomRange";
import { seededRandom } from "../utils/seededRandom";
import { clampFACSState } from "../facs/FACSUtils";
import { defaultFACSState } from "../facs/defaultFACSState";
import { getEmotionArchetype } from "./EmotionArchetypeRegistry";
const defaultPersonality = {
    expressiveness: 0.85,
    softness: 0.65,
    shyness: 0.55,
    gazeStability: 0.7
};
const transitionFACSKeys = [
    "browInnerUp",
    "browOuterUp",
    "browDown",
    "eyeOpen",
    "eyeSmile",
    "eyeSquint",
    "eyeBlinkL",
    "eyeBlinkR",
    "mouthSmile",
    "mouthFrown",
    "mouthOpen",
    "mouthPucker",
    "gazeX",
    "gazeY",
    "blush",
    "tear",
    "sweat"
];
const livingJitter = {
    browInnerUp: 0.032,
    browOuterUp: 0.03,
    browDown: 0.026,
    eyeOpen: 0.026,
    eyeSmile: 0.026,
    eyeSquint: 0.022,
    mouthSmile: 0.036,
    mouthFrown: 0.028,
    mouthOpen: 0.032,
    mouthPucker: 0.018,
    gazeX: 0.036,
    gazeY: 0.028,
    headX: 0.018,
    headY: 0.014,
    headZ: 0.024,
    blush: 0.026,
    tear: 0.018,
    sweat: 0.018
};
export class RuntimeExpressionGenerator {
    generate(input) {
        const random = seededRandom(input.seed);
        const personality = { ...defaultPersonality, ...input.personality };
        const archetype = getEmotionArchetype(input.emotion);
        const variantName = input.variant && archetype.variants[input.variant]
            ? input.variant
            : pickOne(Object.keys(archetype.variants), random);
        const variant = archetype.variants[variantName];
        const intensity = clamp01(input.intensity) * (0.65 + personality.expressiveness * 0.45);
        const ranges = this.mergeRanges(archetype.baseTendency, variant.ranges);
        const peakFACS = this.sampleFACS(ranges, intensity, random);
        this.applyContextBias(peakFACS, input.contextTags, personality);
        const timeline = this.buildTimeline(peakFACS, input.previousState, input.seed, random);
        return {
            emotion: archetype.emotion,
            variant: variantName,
            intensity: clamp01(input.intensity),
            timeline,
            peakFACS,
            idleBias: this.createIdleBias(archetype.emotion, variantName, peakFACS),
            recoveryDuration: 3.8 + random() * 2.8
        };
    }
    mergeRanges(base, variant) {
        return { ...base, ...variant };
    }
    sampleFACS(ranges, intensity, random) {
        const result = {};
        for (const key of Object.keys(ranges)) {
            const range = ranges[key];
            if (!range)
                continue;
            const sampled = randomRange(range, random);
            result[key] = key === "eyeOpen" ? 1 + (sampled - 1) * intensity : sampled * intensity;
        }
        return clampFACSState(result);
    }
    applyContextBias(facs, contextTags, personality) {
        if (contextTags.includes("compliment")) {
            facs.blush = Math.max(facs.blush ?? 0, 0.3 + personality.shyness * 0.45);
            facs.gazeX = facs.gazeX ?? -0.18;
            facs.gazeY = facs.gazeY ?? -0.08;
        }
        if (contextTags.includes("user_tired")) {
            facs.browInnerUp = Math.max(facs.browInnerUp ?? 0, 0.22 + personality.softness * 0.18);
            facs.eyeSmile = Math.max(facs.eyeSmile ?? 0, 0.05 + personality.softness * 0.1);
        }
        if (contextTags.includes("user_good_news")) {
            facs.eyeOpen = Math.max(facs.eyeOpen ?? 1, 1.05);
            facs.mouthSmile = Math.max(facs.mouthSmile ?? 0, 0.55);
        }
    }
    buildTimeline(peakFACS, previousState, seed, random) {
        const headTilt = (peakFACS.headZ ?? 0) + (random() - 0.5) * 0.08;
        const hasSmile = (peakFACS.mouthSmile ?? 0) > 0.25;
        const hasConcern = (peakFACS.browInnerUp ?? 0) > 0.18 && !hasSmile;
        const anticipationDuration = 0.2 + random() * 0.18;
        const settleDuration = 0.42 + random() * 0.22;
        const holdDuration = 0.5 + random() * 0.42;
        const gazeReturn = Math.abs(previousState.gazeX) > 0.16 ? previousState.gazeX * 0.2 : 0;
        const attention = {
            gazeX: gazeReturn,
            gazeY: 0,
            headX: 0,
            headY: 0,
            eyeOpen: Math.max(0.96, peakFACS.eyeOpen ?? 1),
            browInnerUp: Math.max(peakFACS.browInnerUp ?? 0, hasConcern ? 0.24 : 0.06)
        };
        const faceLead = {
            eyeOpen: peakFACS.eyeOpen,
            browInnerUp: peakFACS.browInnerUp,
            browOuterUp: peakFACS.browOuterUp,
            browDown: peakFACS.browDown,
            gazeX: peakFACS.gazeX,
            gazeY: peakFACS.gazeY
        };
        const expressionPeak = {
            ...peakFACS,
            headZ: headTilt
        };
        const transitionStart = this.createTransitionStart(previousState);
        const transitionAttention = this.createTransitionTarget(previousState, attention);
        const livingPeak = this.createLivingVariant(expressionPeak, random, 1);
        const livingSettle = this.createLivingVariant(expressionPeak, random, 0.72);
        const tinyNod = seed % 2 === 0 ? -0.03 : 0.035;
        const timeline = [];
        if (Object.keys(transitionStart).length > 0) {
            timeline.push({
                time: 0,
                duration: 0,
                easing: "linear",
                facs: transitionStart
            });
        }
        timeline.push({
            time: 0,
            duration: anticipationDuration,
            easing: "easeInOut",
            facs: transitionAttention
        }, {
            time: anticipationDuration * 0.72,
            duration: settleDuration,
            easing: "easeOut",
            facs: clampFACSState({
                ...faceLead,
                headY: tinyNod
            })
        }, {
            time: anticipationDuration + settleDuration * 0.55,
            duration: holdDuration * 0.58,
            easing: "easeInOut",
            facs: clampFACSState(expressionPeak)
        }, {
            time: anticipationDuration + settleDuration * 0.55 + holdDuration * 0.32,
            duration: holdDuration * 0.72,
            easing: "easeInOut",
            facs: livingPeak,
            weight: 0.96
        }, {
            time: anticipationDuration + settleDuration + holdDuration * 0.6,
            duration: 0.45 + random() * 0.3,
            easing: "easeInOut",
            facs: clampFACSState({
                ...livingSettle,
                mouthOpen: hasSmile ? 0.05 : peakFACS.mouthOpen,
                headY: 0
            }),
            weight: 0.82
        });
        return timeline;
    }
    createTransitionStart(previousState) {
        const result = {};
        for (const key of transitionFACSKeys) {
            const value = previousState[key];
            if (this.isActiveFromNeutral(key, value))
                result[key] = value;
        }
        return clampFACSState(result);
    }
    createTransitionTarget(previousState, target) {
        const result = { ...target };
        for (const key of transitionFACSKeys) {
            if (result[key] !== undefined)
                continue;
            if (this.isActiveFromNeutral(key, previousState[key])) {
                result[key] = defaultFACSState[key];
            }
        }
        return clampFACSState(result);
    }
    createLivingVariant(base, random, amount) {
        const result = { ...base };
        for (const [key, range] of Object.entries(livingJitter)) {
            const value = base[key];
            if (typeof value !== "number")
                continue;
            const neutral = defaultFACSState[key];
            const activity = Math.min(1, Math.abs(value - neutral) * 2.4 + 0.28);
            result[key] = value + (random() - 0.5) * 2 * range * amount * activity;
        }
        return clampFACSState(result);
    }
    isActiveFromNeutral(key, value) {
        const threshold = key === "eyeOpen" ? 0.012 : 0.018;
        return Math.abs(value - defaultFACSState[key]) > threshold;
    }
    createIdleBias(emotion, variant, peakFACS) {
        if (emotion === "happy") {
            return {
                mouthSmile: Math.min(0.16, (peakFACS.mouthSmile ?? 0) * 0.18),
                eyeSmile: Math.min(0.1, (peakFACS.eyeSmile ?? 0) * 0.18),
                blush: variant.includes("shy") ? Math.min(0.18, (peakFACS.blush ?? 0) * 0.25) : 0
            };
        }
        if (emotion === "concerned") {
            return {
                browInnerUp: Math.min(0.1, (peakFACS.browInnerUp ?? 0) * 0.2),
                mouthSmile: Math.min(0.08, (peakFACS.mouthSmile ?? 0) * 0.2)
            };
        }
        return {
            mouthSmile: Math.min(0.06, (peakFACS.mouthSmile ?? 0) * 0.12)
        };
    }
}
