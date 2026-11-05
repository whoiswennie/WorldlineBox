import type { EmotionIntent } from "../reaction/EmotionIntent";
import type { VADRuntimeState, VADVector } from "./VADState";
export interface EmotionPersonality {
    baseline?: Partial<VADVector>;
    reactivity?: number;
    targetApproachRate?: number;
    decayRate?: number;
    emotionHoldSeconds?: number;
    emotionBias?: Partial<Record<string, number>>;
    ambientDriftStrength?: number;
}
export declare class EmotionStateController {
    private current;
    private target;
    private baseline;
    private ambientDrift;
    private ambientTarget;
    private ambientDriftStrength;
    private driftClock;
    private nextDriftAt;
    private random;
    private reactivity;
    private targetApproachRate;
    private decayRate;
    private emotionHoldSeconds;
    private holdRemainingSeconds;
    private emotionBias;
    private dominantEmotion;
    constructor(personality?: EmotionPersonality);
    configure(personality: EmotionPersonality): void;
    getDecayRate(): number;
    setBaseline(baseline: Partial<VADVector>): void;
    nudge(intent: EmotionIntent): void;
    blendTo(target: Partial<VADVector>, amount?: number): void;
    nudgeVAD(delta: Partial<VADVector>, amount?: number): void;
    reset(): void;
    update(deltaSeconds: number): VADRuntimeState;
    private inferDominantEmotion;
    private inferSubtleEmotion;
    private updateAmbientDrift;
    private pickAmbientTarget;
    private withAmbientDrift;
    private extendHold;
    private completeVAD;
}
