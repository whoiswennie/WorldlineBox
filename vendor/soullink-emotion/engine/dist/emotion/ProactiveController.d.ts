import type { CharacterState } from "../state/CharacterState";
import type { VADRuntimeState } from "./VADState";
import type { SoullinkProactiveEvent } from "../reaction/SoullinkPlan";
export interface ProactiveControllerOptions {
    silenceThresholdSeconds?: number;
    longSilenceSeconds?: number;
    cooldownSeconds?: number;
    settledIntensityThreshold?: number;
    targetSettledIntensityThreshold?: number;
    settledHoldSeconds?: number;
    repeatOnSettledVAD?: boolean;
    repeatAxisThreshold?: number;
}
export declare class ProactiveController {
    private silenceThresholdSeconds;
    private longSilenceSeconds;
    private cooldownSeconds;
    private settledIntensityThreshold;
    private targetSettledIntensityThreshold;
    private settledHoldSeconds;
    private repeatOnSettledVAD;
    private repeatAxisThreshold;
    private random;
    private lastUserInteractionAt;
    private lastEventAt;
    private settledSince;
    private firedSinceInteraction;
    private currentEvent;
    constructor(options?: ProactiveControllerOptions);
    setRepeatOnSettledVAD(enabled: boolean): void;
    get repeatEnabled(): boolean;
    reset(timeSeconds?: number): void;
    notifyUserInteraction(timeSeconds: number): void;
    consume(): void;
    update(timeSeconds: number, state: CharacterState, vad: VADRuntimeState): SoullinkProactiveEvent | null;
    private isVADSettled;
    private resolveSettledEmotion;
    private randomVADPresetEmotion;
}
