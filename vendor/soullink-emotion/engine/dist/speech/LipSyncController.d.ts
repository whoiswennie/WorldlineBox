import type { PartialFACSLikeState } from "../facs/FACSLikeState";
export interface LipSyncOptions {
    enabled: boolean;
    speaking: boolean;
    intensity: number;
    /** Normalized RMS/audio level. Supplying this enables the measured path. */
    audioLevel?: number;
    /** Optional normalized instantaneous peak used for speech accents. */
    audioPeak?: number;
    /** Frame delta in seconds. The timestamp delta is used when omitted. */
    deltaSeconds?: number;
    /** Multiplier for small head/brow accents caused by local peaks. */
    speechAccentGain?: number;
}
export declare class LipSyncController {
    private smoothedLevel;
    private previousLevel;
    private previousPeak;
    private accent;
    private accentDirection;
    private lastAccentTime;
    private lastTimeSeconds;
    update(timeSeconds: number, options: LipSyncOptions): PartialFACSLikeState;
    reset(): void;
    private updateProcedural;
    private updateMeasured;
}
