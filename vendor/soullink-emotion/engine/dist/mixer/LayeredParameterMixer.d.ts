import type { Live2DParamState } from "../facs/FACSLikeState";
export declare class LayeredParameterMixer {
    private current;
    reset(): void;
    smooth(target: Live2DParamState, deltaSeconds: number, speedByParam?: Record<string, number>): Live2DParamState;
}
