import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { VADRuntimeState, VADVector } from "../emotion/VADState";
import type { CharacterPersonality } from "../expression/RuntimeExpressionGenerator";
import type { ModelProfile } from "../profile/ModelProfile";
export type IdleActionLabel = "small-nod" | "head-tilt" | "side-look" | "weight-shift" | "gentle-lean" | "sigh-sink" | "slow-blink";
export type IdleActionDirection = -1 | 0 | 1;
export interface IdleActionSchedulerOptions {
    seed: number;
    spontaneity?: number;
    gain?: number;
    minIntervalSeconds?: number;
    maxIntervalSeconds?: number;
    recentWindowSize?: number;
}
export interface IdleActionUpdateContext {
    enabled: boolean;
    focusLevel: number;
    vad: VADVector | VADRuntimeState;
    personality?: Partial<CharacterPersonality>;
    profile: ModelProfile;
    suppressed?: boolean;
}
export interface IdleActionSchedulerState {
    activeAction: IdleActionLabel | null;
    direction: IdleActionDirection;
    startedAt: number | null;
    duration: number;
    nextActionAt: number | null;
    recentActions: IdleActionLabel[];
    recentDirections: Array<-1 | 1>;
    suppressed: boolean;
}
export declare class IdleActionScheduler {
    private readonly seed;
    private readonly spontaneity;
    private readonly gain;
    private readonly minIntervalSeconds;
    private readonly maxIntervalSeconds;
    private readonly recentWindowSize;
    private random;
    private active;
    private nextActionAt;
    private recentActions;
    private recentDirections;
    private lastUpdateAt;
    private suppressed;
    constructor(options: IdleActionSchedulerOptions);
    update(timeSeconds: number, context: IdleActionUpdateContext): PartialFACSLikeState;
    interrupt(timeSeconds?: number): void;
    reset(timeSeconds?: number): void;
    getState(): IdleActionSchedulerState;
    private createAction;
    private pickDirection;
    private remember;
    private sampleInterval;
}
