import type { VADVector } from "../emotion/VADState";
import type { PartialFACSLikeState } from "../facs/FACSLikeState";
export interface VoiceWaitingMotionOptions {
    emotion?: string;
    intensity?: number;
    vad?: Partial<VADVector>;
}
export interface VoiceWaitingMotionStartInfo {
    label: string;
    duration: number;
    amplitude: number;
    tempo: number;
    emotion: string;
    vad: VADVector;
}
export declare class VoiceWaitingMotionController {
    private motion;
    start(timeSeconds: number, seed?: number, options?: VoiceWaitingMotionOptions): VoiceWaitingMotionStartInfo;
    reset(): void;
    update(timeSeconds: number, bodyMotionGain?: number): PartialFACSLikeState;
}
