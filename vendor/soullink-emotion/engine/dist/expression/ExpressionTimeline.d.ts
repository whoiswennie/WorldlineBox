import type { PartialFACSLikeState } from "../facs/FACSLikeState";
import type { RuntimeExpressionKeyframe } from "./EmotionArchetype";
export declare function getTimelineDuration(timeline: RuntimeExpressionKeyframe[]): number;
export declare function evaluateExpressionTimeline(timeline: RuntimeExpressionKeyframe[], elapsedSeconds: number): PartialFACSLikeState;
